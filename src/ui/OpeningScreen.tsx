type Props = {
  visible: boolean;
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

export default function OpeningScreen({ visible, onStartLive, onOpenPanel }: Props) {
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
            Start Live TV
          </button>
        </div>

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
