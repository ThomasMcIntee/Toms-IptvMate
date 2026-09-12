
import { useEffect, useMemo, useRef, useState } from "react";
import { VisibilityToggle } from "./VisibilityToggle";

function isHeaderChannel(channel: any) {
  return String(channel?.name || "").includes("##");
}

function getHeaderLabel(channel: any) {
  const name = String(channel?.name || "");
  return name.replace(/##+/g, " ").replace(/\s+/g, " ").trim() || name.trim() || "Header";
}

function ChannelRowLogo({ ch, suppressLogos }: { ch: any; suppressLogos: boolean }) {
  if (suppressLogos) return null;
  if (ch.logo) {
    return <img src={ch.logo} className="channel-row-logo" alt="" loading="lazy" />;
  }
  return (
    <div className="channel-row-logo channel-row-logo-fallback" aria-hidden="true">
      {String(ch.name || "?").slice(0, 1)}
    </div>
  );
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
  showRowLogos: boolean;
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
  showRowLogos,
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

  const handleClick = (event?: { target?: EventTarget | null }) => {
    const target = event?.target;
    if (target instanceof Element && target.closest(".channel-list-favorite, .channel-icon-favorite")) {
      return;
    }
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
              <VisibilityToggle
                checked={visible}
                label={`Show or hide ${ch.name}`}
                onToggle={(next) => onToggleChannelVisible(ch.id, next)}
              />
            </label>
          )}
          {showFavoriteControls && onToggleFavorite && (
            <button
              type="button"
              className={`channel-icon-favorite${isFavoriteChannel(ch) ? " active" : ""}`}
              data-channel-id={String(ch.id || "")}
              aria-label={`${isFavoriteChannel(ch) ? "Remove" : "Add"} ${ch.name} to favorites`}
              onClick={(e) => {
                e.preventDefault();
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
            data-channel-id={String(ch.id || "")}
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

  const channelLabel = ch.number != null && String(ch.number).trim() !== "" ? `${ch.number} • ${ch.name}` : ch.name;
  const showListFavorite = showFavoriteControls && !!onToggleFavorite;

  if (showVisibilityControls || showListFavorite) {
    return (
      <div className={itemClass} onClick={handleClick}>
        <div className="list-toggle-row">
          {showVisibilityControls && (
            <VisibilityToggle
              checked={visible}
              label={`Show or hide ${ch.name}`}
              onToggle={(next) => onToggleChannelVisible(ch.id, next)}
            />
          )}
          <button
            type="button"
            className="channel-select-btn"
            data-channel-id={String(ch.id || "")}
            onClick={(e) => {
              e.stopPropagation();
              if (visible) onSelect(ch);
            }}
          >
            {showRowLogos && <ChannelRowLogo ch={ch} suppressLogos={suppressLogos} />}
            <span className="channel-row-name">{channelLabel}</span>
          </button>
          {showListFavorite && (
            <button
              type="button"
              className={`channel-list-favorite${isFavoriteChannel(ch) ? " active" : ""}`}
              data-channel-id={String(ch.id || "")}
              aria-label={`${isFavoriteChannel(ch) ? "Remove" : "Add"} ${ch.name} to favorites`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleFavorite(ch);
              }}
            >
              {isFavoriteChannel(ch) ? "★" : "☆"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`${itemClass} channel-row-btn`}
      data-channel-id={String(ch.id || "")}
      onClick={handleClick}
    >
      {showRowLogos && <ChannelRowLogo ch={ch} suppressLogos={suppressLogos} />}
      <span className="channel-row-name">{channelLabel}</span>
    </button>
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
  showRowLogos?: boolean;
  autoLoadOnScroll?: boolean;
  listClassName?: string;
  restoreChannelId?: string | null;
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
  showRowLogos = false,
  autoLoadOnScroll = false,
  listClassName = "",
  restoreChannelId = null
}: Props) {
  const isLiveListLayout =
    listClassName.includes("channel-list-live-rows") || listClassName.includes("channel-list-live-grid");
  const useIconGrid = showAsIcons && !isLiveListLayout;
  const effectiveBatchSize = Math.max(1, batchSize ?? (useIconGrid ? 180 : 250));
  const [visibleCount, setVisibleCount] = useState(effectiveBatchSize);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoredForIdRef = useRef<string | null>(null);

  const safeChannels = useMemo(() => {
    return channels.filter((channel) => !!channel && typeof channel === "object");
  }, [channels]);

  const channelIdentity = useMemo(
    () => safeChannels.map((channel) => `${String(channel?.id || "")}|${String(channel?.url || "")}`).join("\n"),
    [safeChannels]
  );

  const visibleChannels = useMemo(() => {
    return safeChannels.slice(0, visibleCount);
  }, [safeChannels, visibleCount]);

  useEffect(() => {
    if (restoreChannelId) return;
    setVisibleCount(effectiveBatchSize);
    const listEl = listRef.current;
    if (listEl) {
      listEl.scrollTop = 0;
    }
  }, [channelIdentity, useIconGrid, effectiveBatchSize, restoreChannelId]);

  useEffect(() => {
    if (!restoreChannelId) return;
    const index = safeChannels.findIndex((channel) => String(channel?.id || "") === restoreChannelId);
    if (index < 0) return;
    setVisibleCount((count) => Math.max(count, index + 1));
  }, [restoreChannelId, channelIdentity, safeChannels]);

  useEffect(() => {
    if (!restoreChannelId) {
      restoredForIdRef.current = null;
      return;
    }
    if (restoredForIdRef.current === restoreChannelId) return;
    const listEl = listRef.current;
    if (!listEl) return;

    const focusRestored = () => {
      const matches = listEl.querySelectorAll<HTMLElement>("[data-channel-id]");
      for (const node of matches) {
        if (node.getAttribute("data-channel-id") !== restoreChannelId) continue;
        const btn =
          node instanceof HTMLButtonElement &&
          (node.classList.contains("channel-icon-btn") ||
            node.classList.contains("channel-select-btn") ||
            node.classList.contains("channel-row-btn"))
            ? node
            : node.querySelector<HTMLButtonElement>(
                ".channel-icon-btn:not([disabled]), .channel-select-btn, .channel-row-btn"
              );
        if (!btn || btn.disabled) continue;
        try {
          btn.focus({ preventScroll: true });
          btn.scrollIntoView({ block: "center", inline: "nearest" });
        } catch {
          btn.focus();
        }
        restoredForIdRef.current = restoreChannelId;
        return true;
      }
      return false;
    };

    if (focusRestored()) return;
    const timer = window.setTimeout(() => {
      focusRestored();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [restoreChannelId, visibleCount, channelIdentity]);

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
      className={"channel-list" + (useIconGrid ? " channel-list-icons" : "") + (listClassName ? ` ${listClassName}` : "")}
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
          showAsIcons={useIconGrid}
          suppressLogos={suppressLogos}
          showRowLogos={showRowLogos || (!useIconGrid && isLiveListLayout)}
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
