type Props = {
  visible: boolean;
  hasPlaylists: boolean;
  onStartLive: () => void;
  onOpenPanel: (panel: string) => void;
};

const menuItems = [
  { label: "Add Playlist", panel: "playlist" },
  { label: "Playlist Manager", panel: "playlistManager" },
  { label: "TV Guide Search", panel: "epgSearch" },
  { label: "Recordings", panel: "recordings" },
  { label: "Timeline Guide", panel: "timeline" }
];

export default function MainMenuScreen({ visible, hasPlaylists, onStartLive, onOpenPanel }: Props) {
  if (!visible) return null;

  return (
    <div className="opening-screen" role="dialog" aria-modal="true" aria-label="Main menu">
      <div className="opening-glow" />
      <div className="opening-card">
        <div className="opening-badge">Welcome</div>
        <h1 className="opening-title">Toms IPTVmate</h1>
        <p className="opening-subtitle">Choose an action to start your session</p>

        <div className="opening-actions">
          <button className="opening-btn opening-btn-primary" onClick={onStartLive}>
            {hasPlaylists ? "Start Live TV" : "Add Your First Playlist"}
          </button>
        </div>

        <div className="opening-quick-actions" aria-label="Content shortcuts">
          <button className="opening-btn opening-btn-secondary opening-btn-quick" onClick={() => onOpenPanel("vod")}>
            Movies
          </button>
          <button className="opening-btn opening-btn-secondary opening-btn-quick" onClick={() => onOpenPanel("series")}>
            Series
          </button>
        </div>

        {!hasPlaylists && (
          <div className="opening-warning">
            No playlists found. Add one first to load channels.
          </div>
        )}

        <div className="opening-menu">
          {menuItems.map((item) => (
            <button
              key={item.panel}
              className="opening-btn opening-btn-secondary"
              onClick={() => onOpenPanel(item.panel)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="opening-hint">Press Esc anytime to reopen this menu.</div>
      </div>
    </div>
  );
}
