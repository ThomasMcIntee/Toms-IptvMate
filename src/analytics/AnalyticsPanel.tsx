export default function AnalyticsPanel({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="side-panel">
      <h2>Analytics</h2>
      <p>Analytics system stub — viewing history, recommendations, etc.</p>
    </div>
  );
}
