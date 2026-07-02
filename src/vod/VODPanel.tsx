export default function VODPanel({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="side-panel">
      <h2>Movies</h2>
      <p>Movie browsing goes here.</p>
    </div>
  );
}
