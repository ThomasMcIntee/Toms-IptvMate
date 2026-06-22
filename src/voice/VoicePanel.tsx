export default function VoicePanel({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="side-panel">
      <h2>VOD</h2>
      <p>VOD system goes here.</p>
    </div>
  );
}
