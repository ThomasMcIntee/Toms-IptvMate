
type Props = {
  channels: any[];
  onSelect: (ch: any) => void;
  activeChannel: any | null;
  isChannelVisible: (channelId: string) => boolean;
  onToggleChannelVisible: (channelId: string, visible: boolean) => void;
  showVisibilityControls?: boolean;
  showAsIcons?: boolean;
};

export function ChannelList({
  channels,
  onSelect,
  activeChannel,
  isChannelVisible = () => true,
  onToggleChannelVisible = () => {},
  showVisibilityControls = true,
  showAsIcons = false
}: Props) {
  return (
    <div className={"channel-list" + (showAsIcons ? " channel-list-icons" : "") }>
      {channels.map((ch) => (
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
                {ch.logo ? (
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
    </div>
  );
}
