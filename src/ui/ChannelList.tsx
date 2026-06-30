
import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  channels: any[];
  onSelect: (ch: any) => void;
  activeChannel: any | null;
  isChannelVisible: (channelId: string) => boolean;
  onToggleChannelVisible: (channelId: string, visible: boolean) => void;
  isFavoriteChannel?: (channelId: string) => boolean;
  onToggleFavorite?: (channelId: string) => void;
  showVisibilityControls?: boolean;
  showFavoriteControls?: boolean;
  showAsIcons?: boolean;
  batchSize?: number;
  suppressLogos?: boolean;
  autoLoadOnScroll?: boolean;
  listClassName?: string;
};

export function ChannelList({
  channels,
  onSelect,
  activeChannel,
  isChannelVisible = () => true,
  onToggleChannelVisible = () => {},
  isFavoriteChannel = () => false,
  onToggleFavorite,
  showVisibilityControls = true,
  showFavoriteControls = false,
  showAsIcons = false,
  batchSize,
  suppressLogos = false,
  autoLoadOnScroll = false,
  listClassName = ""
}: Props) {
  const effectiveBatchSize = Math.max(1, batchSize ?? (showAsIcons ? 180 : 250));
  const [visibleCount, setVisibleCount] = useState(effectiveBatchSize);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleCount(effectiveBatchSize);
    const listEl = listRef.current;
    if (listEl) {
      listEl.scrollTop = 0;
    }
  }, [channels, showAsIcons, effectiveBatchSize]);

  const safeChannels = useMemo(() => {
    return channels.filter((channel) => !!channel && typeof channel === "object");
  }, [channels]);

  const visibleChannels = useMemo(() => {
    return safeChannels.slice(0, visibleCount);
  }, [safeChannels, visibleCount]);

  const hasMoreChannels = visibleCount < safeChannels.length;

  const loadNextBatch = () => {
    setVisibleCount((count) => Math.min(safeChannels.length, count + effectiveBatchSize));
  };

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!autoLoadOnScroll || !hasMoreChannels) return;

    const element = event.currentTarget;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining <= 160) {
      loadNextBatch();
    }
  };

  return (
    <div
      ref={listRef}
      className={"channel-list" + (showAsIcons ? " channel-list-icons" : "") + (listClassName ? ` ${listClassName}` : "")}
      onScroll={handleScroll}
    >
      {visibleChannels.map((ch) => (
        <div
          key={ch.id}
          className={
            "channel-item" +
            (activeChannel?.id === ch.id ? " active" : "") +
            (isChannelVisible(ch.id) ? "" : " hidden")
          }
          onClick={() => {
            if ((!showVisibilityControls || showAsIcons) && isChannelVisible(ch.id)) {
              onSelect(ch);
            }
          }}
        >
          {showAsIcons ? (
            <div className="channel-icon-wrap">
              {showVisibilityControls && (
                <label className="channel-icon-toggle" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isChannelVisible(ch.id)}
                    aria-label={`Show or hide ${ch.name}`}
                    onChange={(e) => onToggleChannelVisible(ch.id, e.target.checked)}
                  />
                </label>
              )}
              {showFavoriteControls && onToggleFavorite && (
                <button
                  type="button"
                  className={`channel-icon-favorite${isFavoriteChannel(String(ch.id || "")) ? " active" : ""}`}
                  aria-label={`${isFavoriteChannel(String(ch.id || "")) ? "Remove" : "Add"} ${ch.name} ${"to favorites"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(String(ch.id || ""));
                  }}
                >
                  {isFavoriteChannel(String(ch.id || "")) ? "★" : "☆"}
                </button>
              )}
              <button
                type="button"
                className="channel-icon-btn"
                aria-label={`Play ${ch.name}`}
                disabled={!isChannelVisible(ch.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isChannelVisible(ch.id)) {
                    onSelect(ch);
                  }
                }}
              >
                {!suppressLogos && ch.logo ? (
                  <img
                    src={ch.logo}
                    className="channel-icon-image"
                    alt={ch.name}
                    loading="lazy"
                  />
                ) : (
                  <div className="channel-icon-fallback">{String(ch.name || "?").slice(0, 1)}</div>
                )}
                <span className="channel-icon-label">{ch.name}</span>
              </button>
            </div>
          ) : showVisibilityControls ? (
            <div className="list-toggle-row">
              <input
                type="checkbox"
                checked={isChannelVisible(ch.id)}
                aria-label={`Show or hide ${ch.name}`}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onToggleChannelVisible(ch.id, e.target.checked)}
              />
              <button
                type="button"
                className="channel-select-btn"
                disabled={!isChannelVisible(ch.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isChannelVisible(ch.id)) {
                    onSelect(ch);
                  }
                }}
              >
                {ch.number} • {ch.name}
              </button>
            </div>
          ) : (
            <span>{ch.number} • {ch.name}</span>
          )}
        </div>
      ))}

      {hasMoreChannels && (
        <button
          type="button"
          className="channel-load-more-btn"
          onClick={loadNextBatch}
        >
          Load more ({safeChannels.length - visibleCount} remaining)
        </button>
      )}
    </div>
  );
}
