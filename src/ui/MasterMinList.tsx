import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  collectMasterBouquetEntries,
  extractMasterBouquetKey,
  getMasterMinListVersion,
  isLiveMasterBouquetKey,
  setMasterMinKeyEnabled,
  subscribeMasterMinList
} from "../core/masterMinList";

export function MasterMinList({
  groups,
  groupCounts = {},
  selectedKey,
  isGroupVisible,
  onToggleCategory,
  onSelectKey
}: {
  groups: string[];
  groupCounts?: Record<string, number>;
  selectedKey: string | null;
  isGroupVisible: (group: string) => boolean;
  onToggleCategory: (groups: string[], visible: boolean) => void;
  onSelectKey: (key: string) => void;
}) {
  useSyncExternalStore(subscribeMasterMinList, getMasterMinListVersion, getMasterMinListVersion);

  const entries = useMemo(
    () => collectMasterBouquetEntries(groups, groupCounts),
    [groups, groupCounts]
  );

  return (
    <div className="master-min-list" aria-label="Master categories">
      <div className="list-header">Master</div>
      {entries.length === 0 && (
        <p className="master-min-list-empty">No (Tv:???| or (Vod:???| groups in this playlist.</p>
      )}
      {entries.map((entry) => (
        <MasterCategoryRow
          key={entry.key}
          label={entry.firstGroup}
          categoryKey={entry.key}
          selected={selectedKey === entry.key}
          categoryGroups={entry.groups}
          groupCount={entry.groupCount}
          isGroupVisible={isGroupVisible}
          onToggleCategory={onToggleCategory}
          onSelect={() => onSelectKey(entry.key)}
        />
      ))}
    </div>
  );
}

function MasterCategoryRow({
  label,
  categoryKey,
  selected,
  categoryGroups,
  groupCount,
  isGroupVisible,
  onToggleCategory,
  onSelect
}: {
  label: string;
  categoryKey: string;
  selected: boolean;
  categoryGroups: string[];
  groupCount: number;
  isGroupVisible: (group: string) => boolean;
  onToggleCategory: (groups: string[], visible: boolean) => void;
  onSelect: () => void;
}) {
  const checkboxRef = useRef<HTMLInputElement | null>(null);
  const visibleCount = categoryGroups.filter((group) => isGroupVisible(group)).length;
  const allVisible = categoryGroups.length > 0 && visibleCount === categoryGroups.length;
  const noneVisible = visibleCount === 0;

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = !allVisible && !noneVisible;
    }
  }, [allVisible, noneVisible]);

  return (
    <div className={"group-item" + (selected ? " active" : "") + (allVisible ? "" : " hidden")}>
      <div className="list-toggle-row">
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allVisible}
          aria-label={`Show or hide ${label}`}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const next = event.target.checked;
            if (isLiveMasterBouquetKey(categoryKey)) {
              setMasterMinKeyEnabled(categoryKey, next);
            }
            onToggleCategory(categoryGroups, next);
            onSelect();
          }}
        />
        <button type="button" className="group-select-btn" onClick={onSelect}>
          <span>{label}</span>
          <span className="group-item-count" aria-label={`${groupCount} groups`}>
            {groupCount}
          </span>
        </button>
      </div>
    </div>
  );
}

export function firstGroupForMasterKey(groups: string[], key: string): string | null {
  const matches = groups.filter((group) => extractMasterBouquetKey(group) === key);
  if (matches.length === 0) return null;
  matches.sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
  );
  return matches[0];
}
