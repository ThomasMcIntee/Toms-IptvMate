import { useEffect, useMemo, useState } from "react";

const INITIAL_RENDER_COUNT = 240;
const LOAD_MORE_STEP = 240;

type EpisodePickerProps = {
  visible: boolean;
  seriesTitle: string;
  episodes: any[];
  loading: boolean;
  error: string | null;
  favoriteLabel?: string;
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
  onToggleFavorite,
  onClose,
  onSelectEpisode
}: EpisodePickerProps) {
  const [renderedCount, setRenderedCount] = useState(INITIAL_RENDER_COUNT);
  const [selectedSeasonKey, setSelectedSeasonKey] = useState<string | null>(null);

  const bySeason = useMemo(() => {
    return groupEpisodesBySeason(episodes);
  }, [episodes]);

  useEffect(() => {
    if (!visible) return;
    setRenderedCount(INITIAL_RENDER_COUNT);
    setSelectedSeasonKey((current) => {
      if (current && bySeason.some((group) => group.key === current)) {
        return current;
      }
      return bySeason[0]?.key ?? null;
    });
  }, [visible, bySeason]);

  const activeSeason = useMemo(() => {
    if (bySeason.length === 0) return null;
    return bySeason.find((group) => group.key === selectedSeasonKey) ?? bySeason[0];
  }, [bySeason, selectedSeasonKey]);

  const displayedEpisodes = useMemo(() => {
    return activeSeason ? activeSeason.items.slice(0, renderedCount) : [];
  }, [activeSeason, renderedCount]);

  const canLoadMore = !!activeSeason && renderedCount < activeSeason.items.length;

  if (!visible) return null;

  return (
    <div className="series-picker-overlay" role="dialog" aria-modal="true" aria-label="Series episodes">
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
                  {displayedEpisodes.map((episode) => (
                    <button
                      key={episode.id}
                      type="button"
                      className="series-episode-btn"
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

function getEpisodeFallbackLetter(episode: any): string {
  const text = String(episode?.name || "E").trim();
  return text.slice(0, 1).toUpperCase() || "E";
}
