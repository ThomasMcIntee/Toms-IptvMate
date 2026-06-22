type Props = {
  groups: string[];
  activeGroup: string;
  onSelect: (group: string) => void;
  isGroupVisible: (group: string) => boolean;
  onToggleGroupVisible: (group: string, visible: boolean) => void;
  showVisibilityControls?: boolean;
};

export function GroupList({
  groups,
  activeGroup,
  onSelect,
  isGroupVisible = () => true,
  onToggleGroupVisible = () => {},
  showVisibilityControls = true
}: Props) {
  return (
    <div className="group-list">
      {groups.map((g) => (
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
                disabled={g === "All"}
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
