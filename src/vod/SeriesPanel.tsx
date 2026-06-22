export default function SeriesPanel({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div className="side-panel">
      <h2>Series</h2>
      <p>Series browsing goes here.</p>
    </div>
  );
}

