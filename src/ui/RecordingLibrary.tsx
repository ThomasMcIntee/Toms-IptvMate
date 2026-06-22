import { getRecordings } from "../core/recordingEngine";

export default function RecordingLibrary({ visible }: { visible: boolean }) {
  if (!visible) return null;

  const recs = getRecordings();

  return (
    <div className="side-panel">
      <h2>Recordings</h2>

      {recs.length === 0 && <p>No recordings yet.</p>}

      {recs.map((r) => (
        <div key={r.id} className="recording-item recording-item-static">
          <strong>{r.channelName}</strong>
          <div className="recording-meta">
            {new Date(r.start).toLocaleString()}
          </div>
          <div>Status: {r.status}</div>
        </div>
      ))}
    </div>
  );
}
