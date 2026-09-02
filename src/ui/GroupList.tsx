import { useEffect, useMemo, useRef, useState } from "react";
import { sortGroupNames, type GroupSortDirection } from "./groupSorting";

const SORT_DIRECTION_KEY = "iptvmate_group_sort_direction";

type Props = {
  groups: string[];
  groupCounts?: Record<string, number>;
  activeGroup: string;
  onSelect: (group: string) => void;
  isGroupVisible: (group: string) => boolean;
  onToggleGroupVisible: (group: string, visible: boolean) => void;
  showVisibilityControls?: boolean;
  className?: string;
  onSetAllVisible?: (visible: boolean) => void;
  batchSize?: number;
  autoLoadOnScroll?: boolean;
};

export function GroupList({
  groups,
  groupCounts = {},
  activeGroup,
  onSelect,
  isGroupVisible = () => true,
  onToggleGroupVisible = () => {},
  showVisibilityControls = true,
  className = "",
  onSetAllVisible,
  batchSize,
  autoLoadOnScroll = false
}: Props) {
  const effectiveBatchSize = Math.max(1, batchSize ?? 120);
  const [visibleCount, setVisibleCount] = useState(effectiveBatchSize);
  const listRef = useRef<HTMLDivElement | null>(null);

  const [sortDirection, setSortDirection] = useState<GroupSortDirection>(() => {
    try {
      const saved = localStorage.getItem(SORT_DIRECTION_KEY);
      if (saved === "asc" || saved === "desc") return saved;
    } catch {
      // Ignore localStorage errors
    }
    return null;
  });

  useEffect(() => {
    try {
      if (sortDirection) {
        localStorage.setItem(SORT_DIRECTION_KEY, sortDirection);
      } else {
        localStorage.removeItem(SORT_DIRECTION_KEY);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [sortDirection]);

  const sortedGroups = useMemo(() => {
    if (!sortDirection && groups.length > 150) {
      if (!activeGroup || groups.includes(activeGroup)) {
        return groups;
      }
      return [activeGroup, ...groups];
    }
    const sorted = sortGroupNames(groups, sortDirection, ["Favorites"]);
    if (!activeGroup || sorted.includes(activeGroup)) {
      return sorted;
    }
    return [activeGroup, ...sorted];
  }, [groups, sortDirection, activeGroup]);

  const groupListSignature = useMemo(() => sortedGroups.join("\n"), [sortedGroups]);

  useEffect(() => {
    setVisibleCount(effectiveBatchSize);
    const listEl = listRef.current;
    if (listEl) {
      listEl.scrollTop = 0;
    }
  }, [groupListSignature, effectiveBatchSize]);

  const renderedGroups = useMemo(() => {
    if (!batchSize && !autoLoadOnScroll) {
      return sortedGroups;
    }
    return sortedGroups.slice(0, visibleCount);
  }, [sortedGroups, visibleCount, batchSize, autoLoadOnScroll]);

  const hasMoreGroups = renderedGroups.length < sortedGroups.length;

  const loadNextBatch = () => {
    setVisibleCount((count) => Math.min(sortedGroups.length, count + effectiveBatchSize));
  };

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!autoLoadOnScroll || !hasMoreGroups) return;

    const element = event.currentTarget;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining <= 160) {
      loadNextBatch();
    }
  };

  const sortButtonLabel = sortDirection === "asc" ? "Sort Z-A" : "Sort A-Z";

  return (
    <div
      ref={listRef}
      className={`group-list${className ? ` ${className}` : ""}`}
      onScroll={handleScroll}
    >
      <div className="list-header group-list-toolbar">
        <div className="group-list-bulk-actions">
          {showVisibilityControls && onSetAllVisible && (
            <>
              <button
                type="button"
                className="group-list-bulk-btn"
                onClick={() => onSetAllVisible(false)}
              >
                Hide All
              </button>
              <button
                type="button"
                className="group-list-bulk-btn"
                onClick={() => onSetAllVisible(true)}
              >
                Unhide All
              </button>
            </>
          )}
        </div>
        <button
          type="button"
          className="group-list-bulk-btn"
          onClick={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
          aria-label={sortButtonLabel}
        >
          {sortButtonLabel}
        </button>
      </div>
      {renderedGroups.map((g) => (
        <div
          key={g}
          className={
            "group-item" +
            (activeGroup === g ? " active" : "") +
            (isGroupVisible(g) ? "" : " hidden")
          }
        >
          {showVisibilityControls ? (
            <div className="list-toggle-row">
              <input
                type="checkbox"
                checked={isGroupVisible(g)}
                disabled={g === "Favorites"}
                aria-label={`Show or hide ${g}`}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onToggleGroupVisible(g, e.target.checked)}
              />
              <button
                type="button"
                className="group-select-btn"
                onClick={() => onSelect(g)}
              >
                <span>{g}</span>
                <span className="group-item-count" aria-label={`${groupCounts[g] ?? 0} items`}>
                  {groupCounts[g] ?? 0}
                </span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="group-select-btn"
              onClick={() => onSelect(g)}
            >
              <span>{g}</span>
              <span className="group-item-count" aria-label={`${groupCounts[g] ?? 0} items`}>
                {groupCounts[g] ?? 0}
              </span>
            </button>
          )}
        </div>
      ))}
      {hasMoreGroups && (batchSize || autoLoadOnScroll) && (
        <button type="button" className="group-list-bulk-btn" onClick={loadNextBatch}>
          Load more groups ({renderedGroups.length}/{sortedGroups.length})
        </button>
      )}
    </div>
  );
}
