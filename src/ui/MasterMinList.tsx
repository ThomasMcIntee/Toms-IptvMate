import { useMemo, useSyncExternalStore } from "react";
import {
  collectMasterBouquetEntries,
  extractMasterBouquetKey,
  getMasterMinListVersion,
  isMasterMinKeyEnabled,
  setMasterMinKeyEnabled,
  subscribeMasterMinList
} from "../core/masterMinList";

export function MasterMinList({
  groups,
  groupCounts = {},
  onSelectKey
}: {
  groups: string[];
  groupCounts?: Record<string, number>;
  onSelectKey: (key: string) => void;
}) {
  useSyncExternalStore(subscribeMasterMinList, getMasterMinListVersion, getMasterMinListVersion);

  const entries = useMemo(
    () => collectMasterBouquetEntries(groups, groupCounts),
    [groups, groupCounts]
  );

  return (
    <div className="master-min-list" aria-label="Master min list">
      <div className="list-header">Master</div>
      {entries.length === 0 && (
        <p className="master-min-list-empty">No (Tv:???| groups in this playlist.</p>
      )}
      {entries.map((entry) => (
        <div
          key={entry.key}
          className={"group-item" + (isMasterMinKeyEnabled(entry.key) ? "" : " hidden")}
        >
          <div className="list-toggle-row">
            <input
              type="checkbox"
              checked={isMasterMinKeyEnabled(entry.key)}
              aria-label={`Include ${entry.label} in master min list`}
              onChange={(event) => setMasterMinKeyEnabled(entry.key, event.target.checked)}
            />
            <button
              type="button"
              className="group-select-btn"
              onClick={() => onSelectKey(entry.key)}
            >
              <span>{entry.label}</span>
              <span className="group-item-count" aria-label={`${entry.groupCount} groups`}>
                {entry.groupCount}
              </span>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function firstGroupForMasterKey(groups: string[], key: string): string | null {
  return groups.find((group) => extractMasterBouquetKey(group) === key) || null;
}
