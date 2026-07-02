export type GroupSortDirection = "asc" | "desc" | null;
export type ItemSortDirection = GroupSortDirection;

export function sortGroupNames(groups: string[], direction: GroupSortDirection, pinnedGroups: string[] = []): string[] {
  if (!direction) {
    return groups;
  }

  const pinnedSet = new Set(pinnedGroups);
  const pinned = groups.filter((group) => pinnedSet.has(group));
  const sortable = groups.filter((group) => !pinnedSet.has(group));

  sortable.sort((left, right) => {
    const comparison = left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
    return direction === "asc" ? comparison : -comparison;
  });

  return [...pinned, ...sortable];
}

export function sortChannelsByName(channels: any[], direction: ItemSortDirection): any[] {
  if (!direction) {
    return channels;
  }

  return [...channels].sort((left, right) => {
    const leftName = String(left?.name || "");
    const rightName = String(right?.name || "");
    const comparison = leftName.localeCompare(rightName, undefined, { sensitivity: "base", numeric: true });
    if (comparison !== 0) {
      return direction === "asc" ? comparison : -comparison;
    }

    const leftNumber = String(left?.number || "");
    const rightNumber = String(right?.number || "");
    const numberComparison = leftNumber.localeCompare(rightNumber, undefined, { sensitivity: "base", numeric: true });
    return direction === "asc" ? numberComparison : -numberComparison;
  });
}