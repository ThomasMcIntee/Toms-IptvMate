import { useMemo, useState } from "react";
import { sortGroupNames } from "./groupSorting";
import { ALL_MAIN_CATEGORIES, buildMainCategories } from "./mainCategories";

type Props = {
  groups: string[];
  groupCounts?: Record<string, number>;
  activeCategory: string;
  onSelect: (category: string) => void;
  excludedGroups?: string[];
  className?: string;
};

export function MainCategoryList({
  groups,
  groupCounts = {},
  activeCategory,
  onSelect,
  excludedGroups = [],
  className = ""
}: Props) {
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const categories = useMemo(() => {
    const built = buildMainCategories(groups, groupCounts, excludedGroups);
    const sortedNames = sortGroupNames(built.map((category) => category.name), sortDirection);
    const order = new Map(sortedNames.map((name, index) => [name, index]));
    return [...built].sort(
      (left, right) => (order.get(left.name) ?? 0) - (order.get(right.name) ?? 0)
    );
  }, [groups, groupCounts, excludedGroups, sortDirection]);

  const totalCount = useMemo(
    () => categories.reduce((sum, category) => sum + category.count, 0),
    [categories]
  );

  const sortButtonLabel = sortDirection === "asc" ? "Sort Z-A" : "Sort A-Z";

  return (
    <div className={`main-category-list${className ? ` ${className}` : ""}`}>
      <div className="list-header main-category-list-toolbar">
        <span className="main-category-list-title">Main Categories</span>
        <button
          type="button"
          className="group-list-bulk-btn"
          onClick={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
          aria-label={sortButtonLabel}
        >
          {sortButtonLabel}
        </button>
      </div>

      <div
        className={`main-category-item${activeCategory === ALL_MAIN_CATEGORIES ? " active" : ""}`}
      >
        <button
          type="button"
          className="main-category-select-btn"
          onClick={() => onSelect(ALL_MAIN_CATEGORIES)}
        >
          <span>{ALL_MAIN_CATEGORIES}</span>
          <span className="group-item-count" aria-label={`${totalCount} items`}>
            {totalCount}
          </span>
        </button>
      </div>

      {categories.map((category) => (
        <div
          key={category.name}
          className={`main-category-item${activeCategory === category.name ? " active" : ""}`}
        >
          <button
            type="button"
            className="main-category-select-btn"
            onClick={() => onSelect(category.name)}
          >
            <span>{category.name}</span>
            <span className="group-item-count" aria-label={`${category.count} items`}>
              {category.count}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
