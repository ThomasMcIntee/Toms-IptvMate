import { useMemo, useState } from "react";
import { sortGroupNames, type GroupSortDirection } from "./groupSorting";

type Props = {
  groups: string[];
  activeGroup: string;
  onSelect: (group: string) => void;
  isGroupVisible: (group: string) => boolean;
  onToggleGroupVisible: (group: string, visible: boolean) => void;
  showVisibilityControls?: boolean;
  className?: string;
  onSetAllVisible?: (visible: boolean) => void;
};

export function GroupList({
  groups,
  activeGroup,
  onSelect,
  isGroupVisible = () => true,
  onToggleGroupVisible = () => {},
  showVisibilityControls = true,
  className = "",
  onSetAllVisible
}: Props) {
  const [sortDirection, setSortDirection] = useState<GroupSortDirection>(null);

  const sortedGroups = useMemo(() => {
    return sortGroupNames(groups, sortDirection, ["Favorites"]);
  }, [groups, sortDirection]);

  const sortButtonLabel = sortDirection === "asc" ? "Sort Z-A" : "Sort A-Z";

  return (
    <div className={`group-list${className ? ` ${className}` : ""}`}>
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
      {sortedGroups.map((g) => (
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
                {g}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="group-select-btn"
              onClick={() => onSelect(g)}
            >
              {g}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
