import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeRemoteNavKey } from "../core/remoteKeys";
import { focusSeriesControl, moveSeasonTabFocus, restoreActiveSeasonTabFocus } from "./seriesSeasonNav";

const INITIAL_RENDER_COUNT = 240;
const LOAD_MORE_STEP = 240;

type EpisodePickerProps = {
  visible: boolean;
  seriesTitle: string;
  episodes: any[];
  loading: boolean;
  error: string | null;
  favoriteLabel?: string;
  focusEpisodeId?: string | null;
  onToggleFavorite?: () => void;
  onClose: () => void;
  onSelectEpisode: (episode: any) => void;
};

export default function SeriesEpisodePicker({
  visible,
  seriesTitle,
  episodes,
  loading,
  error,
  favoriteLabel,
  focusEpisodeId = null,
  onToggleFavorite,
  onClose,
  onSelectEpisode
}: EpisodePickerProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [renderedCount, setRenderedCount] = useState(INITIAL_RENDER_COUNT);
  const [selectedSeasonKey, setSelectedSeasonKey] = useState<string | null>(null);

  const bySeason = useMemo(() => {
    return groupEpisodesBySeason(episodes);
  }, [episodes]);

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
      const active = document.activeElement as HTMLElement | null;
      if (focusEpisodeId) {
        const episodeButtons = overlay.querySelectorAll<HTMLButtonElement>(".series-episode-btn[data-episode-id]");
        for (const button of episodeButtons) {
          if (button.getAttribute("data-episode-id") !== String(focusEpisodeId)) continue;
          focusSeriesControl(button);
          return;
        }
        return;
      }
      const episodesReady = overlay.querySelector(".series-episode-btn, .series-season-tab");
      if (episodesReady) {
        const activeTab = overlay.querySelector<HTMLButtonElement>(".series-season-tab-active");
        if (active?.matches(".series-episode-btn")) return;
        if (active?.matches(".series-season-tab") && active === activeTab) return;
        (activeTab || overlay.querySelector<HTMLButtonElement>(".series-episode-btn"))?.focus();
        return;
      }
      if (active?.closest(".series-picker-overlay")) return;
      overlay.querySelector<HTMLButtonElement>(".series-picker-favorite, .series-picker-close")?.focus();
    };

    const timer = window.setTimeout(focusInitial, 50);
    return () => window.clearTimeout(timer);
  }, [visible, loading, focusEpisodeId, episodes.length]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => restoreActiveSeasonTabFocus(overlayRef.current), 0);
    return () => window.clearTimeout(timer);
  }, [visible, selectedSeasonKey, displayedEpisodes.length]);

  useEffect(() => {
    if (!visible) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector(".vod-resume-overlay")) return;
      const overlay = overlayRef.current;
      if (!overlay) return;

      const key = normalizeRemoteNavKey(e);
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key)) return;
      if (e.repeat && key !== "Enter") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const actions = Array.from(
        overlay.querySelectorAll<HTMLButtonElement>(".series-picker-favorite, .series-picker-close")
      );
      const seasons = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".series-season-tab"));
      const episodeButtons = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".series-episode-btn"));
      const loadMore = overlay.querySelector<HTMLButtonElement>(".series-picker-load-more");

      e.preventDefault();
      e.stopPropagation();

      if (key === "Enter") {
        if (active instanceof HTMLButtonElement && overlay.contains(active)) {
          active.click();
          return;
        }
        (episodeButtons[0] || seasons[0] || actions[0])?.focus();
        (episodeButtons[0] || seasons[0] || actions[0])?.click();
        return;
      }

      if (!active || !overlay.contains(active)) {
        focusSeriesControl(episodeButtons[0] || seasons[0] || actions[0]);
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
        if (key === "ArrowLeft") focusSeriesControl(actions[Math.max(0, actionIndex - 1)]);
        else if (key === "ArrowRight") focusSeriesControl(actions[Math.min(actions.length - 1, actionIndex + 1)]);
        else if (key === "ArrowDown") focusSeriesControl(seasons[0] || episodeButtons[0] || loadMore);
        return;
      }

      if (seasonIndex >= 0) {
        const result = moveSeasonTabFocus(
          seasons,
          active,
          key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"
        );
        if (result === "moved" || result === "stay") return;
        if (key === "ArrowUp") focusSeriesControl(actions[0] || actions[actions.length - 1]);
        else if (key === "ArrowDown") focusSeriesControl(episodeButtons[0] || loadMore);
        return;
      }

      if (onLoadMore) {
        if (key === "ArrowUp") focusSeriesControl(episodeButtons[episodeButtons.length - 1] || seasons[0] || actions[0]);
        else if (key === "ArrowLeft") focusSeriesControl(episodeButtons[episodeButtons.length - 1]);
        return;
      }

      if (episodeIndex < 0) {
        focusSeriesControl(episodeButtons[0] || seasons[0] || actions[0]);
        return;
      }

      if (key === "ArrowUp") {
        if (episodeIndex < columns) {
          const seasonGuess = seasons[Math.min(episodeIndex, Math.max(0, seasons.length - 1))] || seasons[0];
          focusSeriesControl(seasonGuess || actions[0]);
        } else focusSeriesControl(episodeButtons[episodeIndex - columns]);
        return;
      }
      if (key === "ArrowDown") {
        const next = episodeIndex + columns;
        if (next < episodeButtons.length) focusSeriesControl(episodeButtons[next]);
        else focusSeriesControl(loadMore || episodeButtons[episodeButtons.length - 1]);
        return;
      }
      if (key === "ArrowLeft") {
        if (episodeIndex > 0) focusSeriesControl(episodeButtons[episodeIndex - 1]);
        else focusSeriesControl(seasons[0] || actions[0]);
        return;
      }
      if (key === "ArrowRight" && episodeIndex < episodeButtons.length - 1) {
        focusSeriesControl(episodeButtons[episodeIndex + 1]);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      ref={overlayRef}
      className="series-picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Series episodes"
    >
      <div className="series-picker-panel">
        <div className="series-picker-header">
          <h2 className="series-picker-title">{seriesTitle}</h2>
          <div className="series-picker-actions">
            {onToggleFavorite && (
              <button type="button" className="series-picker-favorite" onClick={onToggleFavorite}>
                {favoriteLabel || "Add Favorite"}
              </button>
            )}
            <button type="button" className="series-picker-close" onClick={onClose}>
              Back
            </button>
          </div>
        </div>

        {loading && <div className="series-picker-state">Loading episodes...</div>}
        {!loading && error && <div className="series-picker-state series-picker-error">{error}</div>}

        {!loading && !error && episodes.length === 0 && (
          <div className="series-picker-state">No episodes found for this series.</div>
        )}

        {!loading && !error && episodes.length > 0 && (
          <div className="series-picker-list">
            {bySeason.length > 1 && (
              <div className="series-season-selector" aria-label="Seasons">
                {bySeason.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    className={`series-season-tab${group.key === activeSeason?.key ? " series-season-tab-active" : ""}`}
                    onClick={(event) => {
                      setSelectedSeasonKey(group.key);
                      setRenderedCount(INITIAL_RENDER_COUNT);
                      event.currentTarget.focus();
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
                  {displayedEpisodes.map((episode) => (
                    <button
                      key={episode.id}
                      type="button"
                      className="series-episode-btn"
                      data-episode-id={String(episode.id || "")}
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
                        <span className="series-episode-label">{episode.name}</span>
                      </span>
                    </button>
                  ))}
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
  );
}

function seasonKeyForEpisode(episode: any): string {
  const seasonNumber = coerceSeasonNumber(episode?.episodeInfo?.season);
  return Number.isFinite(seasonNumber) && seasonNumber !== Number.MAX_SAFE_INTEGER
    ? `season-${seasonNumber}`
    : "season-unknown";
}

function coerceSeasonNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function groupEpisodesBySeason(episodes: any[]): Array<{ key: string; label: string; items: any[] }> {
  const seasonMap = new Map<string, { label: string; seasonValue: number; items: any[] }>();

  episodes.forEach((episode) => {
    const seasonNumber = coerceSeasonNumber(episode?.episodeInfo?.season);
    const key = seasonNumber !== Number.MAX_SAFE_INTEGER ? `season-${seasonNumber}` : "season-unknown";
    const label = seasonNumber !== Number.MAX_SAFE_INTEGER ? `Season ${seasonNumber}` : "Other Episodes";

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

function getEpisodeFallbackLetter(episode: any): string {
  const text = String(episode?.name || "E").trim();
  return text.slice(0, 1).toUpperCase() || "E";
}
