export default function SubtitlePanel({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="side-panel">
      <h2>Subtitles</h2>
      <p>Subtitle selection + styling stub.</p>
    </div>
  );
}
