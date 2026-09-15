import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeRemoteNavKey } from "../core/remoteKeys";
import type { XtreamSeriesInfo } from "../core/loaders/xtreamLoader";

const INITIAL_RENDER_COUNT = 240;
const LOAD_MORE_STEP = 240;

type Props = {
  visible: boolean;
  series: { name?: string; logo?: string } | null;
  info: XtreamSeriesInfo | null;
  loading: boolean;
  favoriteLabel: string;
  episodes?: any[];
  episodesLoading?: boolean;
  episodesError?: string | null;
  focusEpisodeId?: string | null;
  lastEpisodeId?: string | null;
  playLabel?: string;
  onPlay: () => void;
  onToggleFavorite: () => void;
  onSelectEpisode: (episode: any) => void;
  onClose: () => void;
};

export default function SeriesDetailsScreen({
  visible,
  series,
  info,
  loading,
  favoriteLabel,
  episodes = [],
  episodesLoading = false,
  episodesError = null,
  focusEpisodeId = null,
  lastEpisodeId = null,
  playLabel = "Play",
  onPlay,
  onToggleFavorite,
  onSelectEpisode,
  onClose
}: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const didInitialFocusRef = useRef(false);
  const [previewOn, setPreviewOn] = useState(false);
  const [renderedCount, setRenderedCount] = useState(INITIAL_RENDER_COUNT);
  const [selectedSeasonKey, setSelectedSeasonKey] = useState<string | null>(null);

  const title = info?.title || String(series?.name || "Series");
  const poster = info?.poster || (typeof series?.logo === "string" ? series.logo : "") || "";
  const backdrop = info?.backdrop || "";
  const hasTrailer = !!(info?.trailerEmbedUrl || info?.trailerVideoUrl);
  const plot = info?.plot || "";
  const bySeason = useMemo(() => groupEpisodesBySeason(episodes), [episodes]);

  useEffect(() => {
    if (!visible) {
      setPreviewOn(false);
      didInitialFocusRef.current = false;
    }
  }, [visible, series?.name]);

  useEffect(() => {
    if (!visible) return;
    const focusEpisode = focusEpisodeId
      ? episodes.find((episode) => String(episode?.id || "") === String(focusEpisodeId))
      : null;
    if (focusEpisode) {
      const key = seasonKeyForEpisode(focusEpisode);
      setSelectedSeasonKey(key);
      const group = bySeason.find((entry) => entry.key === key);
      const index = group
        ? group.items.findIndex((episode) => String(episode?.id || "") === String(focusEpisodeId))
        : -1;
      setRenderedCount(Math.max(INITIAL_RENDER_COUNT, index + 1));
      return;
    }
    setRenderedCount(INITIAL_RENDER_COUNT);
    setSelectedSeasonKey((current) => {
      if (current && bySeason.some((group) => group.key === current)) {
        return current;
      }
      return bySeason[0]?.key ?? null;
    });
  }, [visible, bySeason, episodes, focusEpisodeId]);

  const activeSeason = useMemo(() => {
    if (bySeason.length === 0) return null;
    return bySeason.find((group) => group.key === selectedSeasonKey) ?? bySeason[0];
  }, [bySeason, selectedSeasonKey]);

  const displayedEpisodes = useMemo(() => {
    return activeSeason ? activeSeason.items.slice(0, renderedCount) : [];
  }, [activeSeason, renderedCount]);

  const canLoadMore = !!activeSeason && renderedCount < activeSeason.items.length;

  useEffect(() => {
    if (!visible) return;

    const focusInitial = () => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      if (focusEpisodeId) {
        const episodeButtons = overlay.querySelectorAll<HTMLButtonElement>(".series-episode-btn[data-episode-id]");
        for (const button of episodeButtons) {
          if (button.getAttribute("data-episode-id") !== String(focusEpisodeId)) continue;
          button.focus();
          try {
            button.scrollIntoView({ block: "center", inline: "nearest" });
          } catch {
            // Older WebViews may not support scrollIntoView options.
          }
          didInitialFocusRef.current = true;
          return;
        }
        return;
      }
      if (didInitialFocusRef.current) return;
      didInitialFocusRef.current = true;
      overlay.querySelector<HTMLButtonElement>(".movie-details-play")?.focus();
    };
    const timer = window.setTimeout(focusInitial, 50);

    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector(".vod-resume-overlay")) return;
      const overlay = overlayRef.current;
      if (!overlay) return;

      const key = normalizeRemoteNavKey(e);
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key)) return;

      const actions = Array.from(
        overlay.querySelectorAll<HTMLButtonElement>(".movie-details-actions button")
      );
      const seasons = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".series-season-tab"));
      const episodeButtons = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".series-episode-btn"));
      const loadMore = overlay.querySelector<HTMLButtonElement>(".series-picker-load-more");
      const active = document.activeElement as HTMLElement | null;

      e.preventDefault();
      e.stopPropagation();

      const focusEl = (el: HTMLElement | null | undefined) => {
        if (!el) return;
        el.focus();
        try {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
        } catch {
          // Older WebViews may not support scrollIntoView options.
        }
      };

      if (key === "Enter") {
        if (active instanceof HTMLButtonElement && overlay.contains(active)) {
          active.click();
        } else {
          (actions[0] || episodeButtons[0])?.click();
        }
        return;
      }

      if (!active || !overlay.contains(active)) {
        focusEl(actions[0] || seasons[0] || episodeButtons[0]);
        return;
      }

      const actionIndex = actions.indexOf(active as HTMLButtonElement);
      const seasonIndex = seasons.indexOf(active as HTMLButtonElement);
      const episodeIndex = episodeButtons.indexOf(active as HTMLButtonElement);
      const onLoadMore = active === loadMore;
      const firstEpRect = episodeButtons[0]?.getBoundingClientRect();
      const gridRect = episodeButtons[0]?.closest(".series-episode-grid")?.getBoundingClientRect();
      const columns =
        firstEpRect && gridRect
          ? Math.max(1, Math.floor((gridRect.width + 12) / (firstEpRect.width + 12)))
          : 1;

      if (actionIndex >= 0) {
        if (key === "ArrowLeft") focusEl(actions[Math.max(0, actionIndex - 1)]);
        else if (key === "ArrowRight") focusEl(actions[Math.min(actions.length - 1, actionIndex + 1)]);
        else if (key === "ArrowDown") focusEl(seasons[0] || episodeButtons[0] || loadMore);
        else if (key === "ArrowUp") focusEl(actions[0]);
        return;
      }

      if (seasonIndex >= 0) {
        if (key === "ArrowLeft" || key === "ArrowRight") {
          const nextIndex =
            key === "ArrowLeft"
              ? Math.max(0, seasonIndex - 1)
              : Math.min(seasons.length - 1, seasonIndex + 1);
          const next = seasons[nextIndex];
          if (next && next !== active) {
            window.setTimeout(() => next.click(), 0);
          } else {
            focusEl(next);
          }
          return;
        }
        if (key === "ArrowUp") focusEl(actions[0] || actions[actions.length - 1]);
        else if (key === "ArrowDown") focusEl(episodeButtons[0] || loadMore);
        return;
      }

      if (onLoadMore) {
        if (key === "ArrowUp") focusEl(episodeButtons[episodeButtons.length - 1] || seasons[0] || actions[0]);
        else if (key === "ArrowLeft") focusEl(episodeButtons[episodeButtons.length - 1]);
        return;
      }

      if (episodeIndex < 0) {
        focusEl(actions[0] || seasons[0] || episodeButtons[0]);
        return;
      }

      if (key === "ArrowUp") {
        if (episodeIndex < columns) focusEl(seasons[0] || actions[0]);
        else focusEl(episodeButtons[episodeIndex - columns]);
        return;
      }
      if (key === "ArrowDown") {
        const next = episodeIndex + columns;
        if (next < episodeButtons.length) focusEl(episodeButtons[next]);
        else focusEl(loadMore || episodeButtons[episodeButtons.length - 1]);
        return;
      }
      if (key === "ArrowLeft") {
        if (episodeIndex > 0) focusEl(episodeButtons[episodeIndex - 1]);
        else focusEl(seasons[0] || actions[0]);
        return;
      }
      if (key === "ArrowRight" && episodeIndex < episodeButtons.length - 1) {
        focusEl(episodeButtons[episodeIndex + 1]);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [visible, hasTrailer, favoriteLabel, displayedEpisodes.length, selectedSeasonKey, focusEpisodeId]);

  if (!visible) return null;

  const episodeLabel =
    episodes.length > 0 ? `${episodes.length} episode${episodes.length === 1 ? "" : "s"}` : "";
  const metaBits = [
    info?.year,
    info?.genre,
    episodeLabel,
    info?.duration,
    info?.rating ? `Rating ${info.rating}` : ""
  ]
    .map((bit) => String(bit || "").trim())
    .filter(Boolean);

  return (
    <div
      ref={overlayRef}
      className="movie-details-overlay series-details-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {(backdrop || poster) && (
        <div
          className="movie-details-backdrop"
          style={{ backgroundImage: `url("${(backdrop || poster).replace(/"/g, "")}")` }}
          aria-hidden="true"
        />
      )}
      <div className="movie-details-panel series-details-panel">
        <div className="movie-details-media">
          {previewOn && info?.trailerEmbedUrl ? (
            <iframe
              className="movie-details-trailer"
              title={`${title} trailer`}
              src={`${info.trailerEmbedUrl}&autoplay=1`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : previewOn && info?.trailerVideoUrl ? (
            <video className="movie-details-trailer-video" src={info.trailerVideoUrl} controls autoPlay />
          ) : poster ? (
            <img className="movie-details-poster" src={poster} alt="" />
          ) : backdrop ? (
            <img className="movie-details-poster" src={backdrop} alt="" />
          ) : (
            <div className="movie-details-poster-fallback" aria-hidden="true">
              {title.slice(0, 1)}
            </div>
          )}
        </div>
        <div className="movie-details-body">
          <h2 className="movie-details-title">{title}</h2>
          {metaBits.length > 0 && <div className="movie-details-meta">{metaBits.join(" · ")}</div>}
          {info?.director && <div className="movie-details-credit">Director: {info.director}</div>}
          {info?.cast && <div className="movie-details-credit">Cast: {info.cast}</div>}
          {loading && <div className="movie-details-state">Loading details…</div>}
          {!loading && plot ? (
            <p className="movie-details-plot" tabIndex={-1}>
              {plot}
            </p>
          ) : !loading ? (
            <p className="movie-details-plot movie-details-plot-empty" tabIndex={-1}>
              No description is available for this title.
            </p>
          ) : null}
          <div className="movie-details-actions">
            <button type="button" className="movie-details-play" onClick={onPlay}>
              {playLabel}
            </button>
            <button type="button" className="movie-details-favorite" onClick={onToggleFavorite}>
              {favoriteLabel}
            </button>
            {hasTrailer && (
              <button type="button" className="movie-details-preview" onClick={() => setPreviewOn((on) => !on)}>
                {previewOn ? "Hide Preview" : "Preview"}
              </button>
            )}
            {!hasTrailer && !loading && (
              <span className="movie-details-preview-missing">No preview available</span>
            )}
            <button type="button" className="movie-details-close" onClick={onClose}>
              Back
            </button>
          </div>
        </div>
        <div className="series-details-episodes">
          {episodesLoading && <div className="series-picker-state">Loading episodes...</div>}
          {!episodesLoading && episodesError && (
            <div className="series-picker-state series-picker-error">{episodesError}</div>
          )}
          {!episodesLoading && !episodesError && episodes.length === 0 && (
            <div className="series-picker-state">No episodes found for this series.</div>
          )}
          {!episodesLoading && !episodesError && episodes.length > 0 && (
            <div className="series-picker-list series-details-episode-list">
              {bySeason.length > 1 && (
                <div className="series-season-selector" aria-label="Seasons">
                  {bySeason.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      className={`series-season-tab${group.key === activeSeason?.key ? " series-season-tab-active" : ""}`}
                      onClick={() => {
                        setSelectedSeasonKey(group.key);
                        setRenderedCount(INITIAL_RENDER_COUNT);
                      }}
                    >
                      {group.label}
                    </button>
                  ))}
                </div>
              )}
              {activeSeason && (
                <section className="series-season-block">
                  <h3 className="series-season-title">{activeSeason.label}</h3>
                  <div className="series-episode-grid">
                    {displayedEpisodes.map((episode) => {
                      const episodeId = String(episode.id || "");
                      const isLastWatched = !!lastEpisodeId && episodeId === String(lastEpisodeId);
                      return (
                      <button
                        key={episode.id}
                        type="button"
                        className={`series-episode-btn${isLastWatched ? " series-episode-btn-last" : ""}`}
                        data-episode-id={episodeId}
                        onClick={() => onSelectEpisode(episode)}
                      >
                        <span className="series-episode-content">
                          {episode.logo ? (
                            <img
                              src={episode.logo}
                              alt=""
                              className="series-episode-icon"
                              loading="lazy"
                              aria-hidden="true"
                            />
                          ) : (
                            <span className="series-episode-icon series-episode-icon-fallback" aria-hidden="true">
                              {getEpisodeFallbackLetter(episode)}
                            </span>
                          )}
                          <span className="series-episode-copy">
                            <span className="series-episode-label">{episodeShortLabel(episode)}</span>
                            {isLastWatched && <span className="series-episode-last-badge">Last watched</span>}
                          </span>
                        </span>
                      </button>
                      );
                    })}
                  </div>
                </section>
              )}
              {canLoadMore && (
                <button
                  type="button"
                  className="series-picker-load-more"
                  onClick={() => {
                    setRenderedCount((count) => Math.min(activeSeason?.items.length || count, count + LOAD_MORE_STEP));
                  }}
                >
                  Load more episodes ({(activeSeason?.items.length || 0) - renderedCount} remaining)
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function seasonKeyForEpisode(episode: any): string {
  const seasonNumber =
    typeof episode?.episodeInfo?.season === "number" ? episode.episodeInfo.season : Number.MAX_SAFE_INTEGER;
  return Number.isFinite(seasonNumber) ? `season-${seasonNumber}` : "season-unknown";
}

function groupEpisodesBySeason(episodes: any[]): Array<{ key: string; label: string; items: any[] }> {
  const seasonMap = new Map<string, { label: string; seasonValue: number; items: any[] }>();

  episodes.forEach((episode) => {
    const seasonNumber =
      typeof episode?.episodeInfo?.season === "number" ? episode.episodeInfo.season : Number.MAX_SAFE_INTEGER;
    const key = Number.isFinite(seasonNumber) ? `season-${seasonNumber}` : "season-unknown";
    const label = Number.isFinite(seasonNumber) ? `Season ${seasonNumber}` : "Other Episodes";

    if (!seasonMap.has(key)) {
      seasonMap.set(key, { label, seasonValue: seasonNumber, items: [] });
    }

    seasonMap.get(key)?.items.push(episode);
  });

  const groups = Array.from(seasonMap.entries()).map(([key, value]) => ({
    key,
    label: value.label,
    seasonValue: value.seasonValue,
    items: value.items
  }));

  groups.sort((a, b) => a.seasonValue - b.seasonValue);

  return groups.map(({ key, label, items }) => ({ key, label, items }));
}

function padEpisodePart(value: number): string {
  return String(value).padStart(2, "0");
}

function episodeShortLabel(episode: any): string {
  const season = typeof episode?.episodeInfo?.season === "number" ? episode.episodeInfo.season : null;
  const number = typeof episode?.episodeInfo?.episode === "number" ? episode.episodeInfo.episode : null;
  const rawTitle = String(episode?.episodeInfo?.title || "").trim();
  const code =
    season != null && number != null ? `S${padEpisodePart(season)}E${padEpisodePart(number)}` : "";
  const afterCode = rawTitle.match(/S\d+\s*E\d+\s*[-–:]\s*(.+)$/i);
  const lastDash = rawTitle.includes(" - ") ? rawTitle.split(" - ").pop()?.trim() || "" : "";
  const shortTitle = (afterCode?.[1] || lastDash || rawTitle).trim();
  if (code && shortTitle && shortTitle.toUpperCase() !== code) return `${code} · ${shortTitle}`;
  if (code) return code;
  if (shortTitle) return shortTitle;
  return String(episode?.name || "Episode");
}

function getEpisodeFallbackLetter(episode: any): string {
  const text = String(episodeShortLabel(episode) || "E").trim();
  return text.slice(0, 1).toUpperCase() || "E";
}
