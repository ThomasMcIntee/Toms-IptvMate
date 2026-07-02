import { useState } from "react";
import { getCompletedRecordings } from "../core/recordingEngine";

export default function RecordingPlayback({
  visible
}: {
  visible: boolean;
}) {
  const [selected, setSelected] = useState<any | null>(null);

  if (!visible) return null;

  const recs = getCompletedRecordings();

  return (
    <div className="side-panel">
      <h2>Recordings</h2>

      {!selected && (
        <>
          {recs.length === 0 && <p>No completed recordings.</p>}

          {recs.map((r) => (
            <div
              key={r.id}
              className="recording-item"
              onClick={() => setSelected(r)}
            >
              <strong>{r.channelName}</strong>
              <div className="recording-meta">
                {new Date(r.start).toLocaleString()}
              </div>
              <div className="recording-meta">
                Duration: {Math.round((r.end - r.start) / 60000)} min
              </div>
            </div>
          ))}
        </>
      )}

      {selected && (
        <div className="recording-player-container">
          <button
            className="btn-secondary"
            onClick={() => setSelected(null)}
          >
            <span className="recording-player-back">← Back</span>
          </button>

          <video
            controls
            autoPlay
            src={selected.filePath}
            className="recording-player"
          />

          <div className="recording-player-meta">
            <strong>{selected.channelName}</strong>
            <div className="recording-meta">
              {new Date(selected.start).toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
