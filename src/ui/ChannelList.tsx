
import { useEffect, useMemo, useRef, useState } from "react";

function isHeaderChannel(channel: any) {
  return String(channel?.name || "").includes("##");
}

function getHeaderLabel(channel: any) {
  const name = String(channel?.name || "");
  return name.replace(/##+/g, " ").replace(/\s+/g, " ").trim() || name.trim() || "Header";
}

type ItemProps = {
  ch: any;
  activeChannel: any | null;
  isChannelVisible: (id: string) => boolean;
  onToggleChannelVisible: (id: string, visible: boolean) => void;
  isFavoriteChannel: (channel: any) => boolean;
  onToggleFavorite?: (channel: any) => void;
  onSelect: (ch: any) => void;
  showVisibilityControls: boolean;
  showFavoriteControls: boolean;
  showAsIcons: boolean;
  suppressLogos: boolean;
};

function ChannelItem({
  ch,
  activeChannel,
  isChannelVisible,
  onToggleChannelVisible,
  isFavoriteChannel,
  onToggleFavorite,
  onSelect,
  showVisibilityControls,
  showFavoriteControls,
  showAsIcons,
  suppressLogos,
}: ItemProps) {
  const isHeader = isHeaderChannel(ch);

  if (isHeader) {
    return (
      <div className="channel-item channel-header-item">
        <div className="channel-header-label">{getHeaderLabel(ch)}</div>
      </div>
    );
  }

  const visible = isChannelVisible(ch.id);

  const itemClass =
    "channel-item" +
    (activeChannel?.id === ch.id ? " active" : "") +
    (visible ? "" : " hidden");

  const handleClick = () => {
    if ((!showVisibilityControls || showAsIcons) && visible) {
      onSelect(ch);
    }
  };

  if (showAsIcons) {
    return (
      <div className={itemClass} onClick={handleClick}>
        <div className="channel-icon-wrap">
          {showVisibilityControls && (
            <label className="channel-icon-toggle" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={visible}
                aria-label={`Show or hide ${ch.name}`}
                onChange={(e) => onToggleChannelVisible(ch.id, e.target.checked)}
              />
            </label>
          )}
          {showFavoriteControls && onToggleFavorite && (
            <button
              type="button"
              className={`channel-icon-favorite${isFavoriteChannel(ch) ? " active" : ""}`}
              aria-label={`${isFavoriteChannel(ch) ? "Remove" : "Add"} ${ch.name} to favorites`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(ch);
              }}
            >
              {isFavoriteChannel(ch) ? "★" : "☆"}
            </button>
          )}
          <button
            type="button"
            className="channel-icon-btn"
            aria-label={`Play ${ch.name}`}
            disabled={!visible}
            onClick={(e) => {
              e.stopPropagation();
              if (visible) onSelect(ch);
            }}
          >
            {!suppressLogos && ch.logo ? (
              <img src={ch.logo} className="channel-icon-image" alt={ch.name} loading="lazy" />
            ) : (
              <div className="channel-icon-fallback">{String(ch.name || "?").slice(0, 1)}</div>
            )}
            <span className="channel-icon-label">{ch.name}</span>
          </button>
        </div>
      </div>
    );
  }

  if (showVisibilityControls) {
    return (
      <div className={itemClass} onClick={handleClick}>
        <div className="list-toggle-row">
          <input
            type="checkbox"
            checked={visible}
            aria-label={`Show or hide ${ch.name}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onToggleChannelVisible(ch.id, e.target.checked)}
          />
          <button
            type="button"
            className="channel-select-btn"
            disabled={!visible}
            onClick={(e) => {
              e.stopPropagation();
              if (visible) onSelect(ch);
            }}
          >
            {ch.number} • {ch.name}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={itemClass} onClick={handleClick}>
      <span>{ch.number} • {ch.name}</span>
    </div>
  );
}

type Props = {
  channels: any[];
  onSelect: (ch: any) => void;
  activeChannel: any | null;
  isChannelVisible: (channelId: string) => boolean;
  onToggleChannelVisible: (channelId: string, visible: boolean) => void;
  isFavoriteChannel?: (channel: any) => boolean;
  onToggleFavorite?: (channel: any) => void;
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
        <ChannelItem
          key={`${String(ch?.id || "")}|${String(ch?.url || "")}`}
          ch={ch}
          activeChannel={activeChannel}
          isChannelVisible={isChannelVisible}
          onToggleChannelVisible={onToggleChannelVisible}
          isFavoriteChannel={isFavoriteChannel}
          onToggleFavorite={onToggleFavorite}
          onSelect={onSelect}
          showVisibilityControls={showVisibilityControls}
          showFavoriteControls={showFavoriteControls}
          showAsIcons={showAsIcons}
          suppressLogos={suppressLogos}
        />
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
