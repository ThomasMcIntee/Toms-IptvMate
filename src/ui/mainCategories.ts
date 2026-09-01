export const ALL_MAIN_CATEGORIES = "All";

const CONTENT_TYPE_PREFIXES = ["TV:", "Movies:", "Series:"];

export type MainCategory = {
  name: string;
  groups: string[];
  count: number;
};

/**
 * Derives the "main" category from a group name such as "TV: USA | Sports".
 * The content-type prefix is dropped and only the portion before the first
 * separator ("|") is kept, so every group that shares that portion collapses
 * into a single category.
 */
export function deriveMainCategory(group: string): string {
  let name = String(group || "").trim();
  if (!name) return "Uncategorized";

  for (const prefix of CONTENT_TYPE_PREFIXES) {
    if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
      name = name.slice(prefix.length).trim();
      break;
    }
  }

  const separatorIndex = name.indexOf("|");
  if (separatorIndex >= 0) {
    name = name.slice(0, separatorIndex).trim();
  }

  return name || "Uncategorized";
}

/**
 * Builds the deduplicated list of main categories for the supplied group names.
 * Groups whose main category matches (ignoring case) are merged into one entry.
 */
export function buildMainCategories(
  groups: string[],
  groupCounts: Record<string, number> = {},
  excludedGroups: string[] = []
): MainCategory[] {
  const excluded = new Set(excludedGroups);
  const byKey = new Map<string, MainCategory>();

  for (const group of groups) {
    if (excluded.has(group)) continue;

    const name = deriveMainCategory(group);
    const key = name.toLowerCase();
    const existing = byKey.get(key);
    const count = groupCounts[group] ?? 0;

    if (existing) {
      existing.groups.push(group);
      existing.count += count;
    } else {
      byKey.set(key, { name, groups: [group], count });
    }
  }

  return Array.from(byKey.values());
}

export function groupMatchesMainCategory(group: string, mainCategory: string): boolean {
  if (!mainCategory || mainCategory === ALL_MAIN_CATEGORIES) return true;
  return deriveMainCategory(group).toLowerCase() === mainCategory.toLowerCase();
}
