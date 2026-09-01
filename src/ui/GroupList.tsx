import { useEffect, useMemo, useRef, useState } from "react";
import { sortGroupNames, type GroupSortDirection } from "./groupSorting";
import {
  extractMasterBouquetKey,
  masterBouquetDisplayLabel,
  sortGroupsByMasterCategory
} from "../core/masterMinList";

const SORT_DIRECTION_KEY = "iptvmate_group_sort_direction";

type Props = {
  groups: string[];
  groupCounts?: Record<string, number>;
  activeGroup: string;
  onSelect: (group: string) => void;
  isGroupVisible: (group: string) => boolean;
  onToggleGroupVisible: (group: string, visible: boolean) => void;
  onToggleGroupsVisible?: (groups: string[], visible: boolean) => void;
  showVisibilityControls?: boolean;
  showCategoryHeaders?: boolean;
  className?: string;
  onSetAllVisible?: (visible: boolean) => void;
  batchSize?: number;
  autoLoadOnScroll?: boolean;
};

function CategoryHeader({
  label,
  groups,
  isGroupVisible,
  onToggle
}: {
  label: string;
  groups: string[];
  isGroupVisible: (group: string) => boolean;
  onToggle: (groups: string[], visible: boolean) => void;
}) {
  const checkboxRef = useRef<HTMLInputElement | null>(null);
  const visibleCount = groups.filter((group) => isGroupVisible(group)).length;
  const allVisible = groups.length > 0 && visibleCount === groups.length;
  const noneVisible = visibleCount === 0;

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = !allVisible && !noneVisible;
    }
  }, [allVisible, noneVisible]);

  return (
    <div className={"group-category-header" + (allVisible ? "" : " hidden")}>
      <div className="list-toggle-row">
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allVisible}
          aria-label={`Show or hide ${label}`}
          onChange={(event) => onToggle(groups, event.target.checked)}
        />
        <span className="group-category-header-label">{label}</span>
        <span className="group-item-count" aria-label={`${groups.length} groups`}>
          {groups.length}
        </span>
      </div>
    </div>
  );
}

export function GroupList({
  groups,
  groupCounts = {},
  activeGroup,
  onSelect,
  isGroupVisible = () => true,
  onToggleGroupVisible = () => {},
  onToggleGroupsVisible,
  showVisibilityControls = true,
  showCategoryHeaders = false,
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
    let nextGroups: string[];
    if (showCategoryHeaders) {
      nextGroups = sortGroupsByMasterCategory(groups, sortDirection === "desc" ? "desc" : "asc");
    } else if (!sortDirection && groups.length > 150) {
      nextGroups = groups;
    } else {
      nextGroups = sortGroupNames(groups, sortDirection, ["Favorites"]);
    }
    if (!activeGroup || nextGroups.includes(activeGroup)) {
      return nextGroups;
    }
    return [activeGroup, ...nextGroups];
  }, [groups, sortDirection, activeGroup, showCategoryHeaders]);

  const groupsByCategory = useMemo(() => {
    const byKey = new Map<string, string[]>();
    for (const group of sortedGroups) {
      const key = extractMasterBouquetKey(group);
      if (!key) continue;
      const list = byKey.get(key);
      if (list) list.push(group);
      else byKey.set(key, [group]);
    }
    return byKey;
  }, [sortedGroups]);

  const categoryLeaders = useMemo(() => {
    const leaders = new Set<string>();
    for (const categoryGroups of groupsByCategory.values()) {
      if (categoryGroups[0]) leaders.add(categoryGroups[0]);
    }
    return leaders;
  }, [groupsByCategory]);

  useEffect(() => {
    setVisibleCount(effectiveBatchSize);
    const listEl = listRef.current;
    if (listEl) {
      listEl.scrollTop = 0;
    }
  }, [sortedGroups, effectiveBatchSize]);

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
      {renderedGroups.map((g) => {
        const categoryKey = extractMasterBouquetKey(g);
        const categoryGroups = categoryKey ? groupsByCategory.get(categoryKey) || [] : [];
        const showHeader =
          showCategoryHeaders &&
          showVisibilityControls &&
          !!categoryKey &&
          categoryLeaders.has(g);

        return (
          <div key={g}>
            {showHeader && categoryKey && (
              <CategoryHeader
                label={masterBouquetDisplayLabel(categoryKey)}
                groups={categoryGroups}
                isGroupVisible={isGroupVisible}
                onToggle={onToggleGroupsVisible || ((items, visible) => {
                  items.forEach((item) => onToggleGroupVisible(item, visible));
                })}
              />
            )}
            <div
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
          </div>
        );
      })}
      {hasMoreGroups && (batchSize || autoLoadOnScroll) && (
        <button type="button" className="group-list-bulk-btn" onClick={loadNextBatch}>
          Load more groups ({renderedGroups.length}/{sortedGroups.length})
        </button>
      )}
    </div>
  );
}
