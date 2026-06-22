import { useState } from "react";
import {
  getCompletedRecordings,
  deleteRecording,
  renameRecording,
  getStorageStats
} from "../core/recordingEngine";

export default function RecordingStorageManager({
  visible
}: {
  visible: boolean;
}) {
  const [refreshKey, setRefreshKey] = useState(0);

  if (!visible) return null;

  const recs = getCompletedRecordings();
  const stats = getStorageStats();

  function doDelete(id: string) {
    if (!confirm("Delete this recording?")) return;
    deleteRecording(id);
    setRefreshKey((k) => k + 1);
  }

  function doRename(id: string, currentTitle: string | undefined) {
    const newTitle = prompt(
      "Enter new name:",
      currentTitle || ""
    );
    if (!newTitle) return;
    renameRecording(id, newTitle);
    setRefreshKey((k) => k + 1);
  }

  function formatSize(bytes: number | undefined) {
    if (!bytes || bytes <= 0) return "Unknown";
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }

  return (
    <div className="side-panel" key={refreshKey}>
      <h2>Recording Storage</h2>

      <div className="recording-storage-summary">
        Total recordings: {stats.count} <br />
        Space used: {formatSize(stats.totalBytes)}
      </div>

      {recs.length === 0 && <p>No completed recordings.</p>}

      {recs.map((r) => (
        <div
          key={r.id}
          className="recording-item"
        >
          <strong>{r.title || r.channelName}</strong>
          <div className="recording-meta">
            {new Date(r.start).toLocaleString()} —{" "}
            {Math.round((r.end - r.start) / 60000)} min
          </div>
          <div className="recording-meta">
            Size: {formatSize(r.sizeBytes)}
          </div>

          <div className="recording-storage-actions">
            <button
              className="btn-secondary btn-flex"
              onClick={() => doRename(r.id, r.title)}
            >
              Rename
            </button>
            <button
              className="btn-danger btn-flex"
              onClick={() => doDelete(r.id)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
