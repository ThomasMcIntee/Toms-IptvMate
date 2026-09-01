const MASTER_MIN_LIST_KEY = "iptvmate_master_min_list";

let selectedKeys = new Set<string>(readStoredKeys());
let masterMinListVersion = 0;
const listeners = new Set<() => void>();

function readStoredKeys(): string[] {
  try {
    const raw = localStorage.getItem(MASTER_MIN_LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function persistKeys(): void {
  try {
    localStorage.setItem(MASTER_MIN_LIST_KEY, JSON.stringify(Array.from(selectedKeys)));
  } catch {
    // Ignore quota errors on TV storage.
  }
}

function notifyMasterMinList(): void {
  masterMinListVersion += 1;
  listeners.forEach((listener) => listener());
}

export function subscribeMasterMinList(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMasterMinListVersion(): number {
  return masterMinListVersion;
}

/**
 * Collapse provider bouquets that share the same `(Tv:???|` (or `TV: ???|`)
 * prefix into one master-min-list key.
 */
export function extractMasterBouquetKey(groupName: string): string | null {
  const raw = String(groupName || "").trim();
  if (!raw || raw === "Favorites") return null;

  const parenTv = raw.match(/\(\s*Tv\s*:\s*([^)|]+)\|/i);
  if (parenTv) {
    return `(Tv:${parenTv[1].trim()}|`;
  }

  const prefixed = raw.match(/^TV:\s*([^|]+)\|/i);
  if (prefixed) {
    return `TV: ${prefixed[1].trim()}|`;
  }

  return null;
}

export function masterBouquetDisplayLabel(key: string): string {
  const paren = String(key || "").match(/Tv:\s*([^)|]+)/i);
  if (paren) return paren[1].trim();
  const prefixed = String(key || "").match(/^TV:\s*([^|]+)\|/i);
  if (prefixed) return prefixed[1].trim();
  return String(key || "").replace(/\|$/, "");
}

export function hasMasterMinList(): boolean {
  return selectedKeys.size > 0;
}

export function isMasterMinKeyEnabled(key: string): boolean {
  return selectedKeys.has(key);
}

export function setMasterMinKeyEnabled(key: string, enabled: boolean): void {
  const next = new Set(selectedKeys);
  if (enabled) next.add(key);
  else next.delete(key);
  selectedKeys = next;
  persistKeys();
  notifyMasterMinList();
}

export function groupMatchesMasterMinList(groupName: string): boolean {
  if (selectedKeys.size === 0) return true;
  if (String(groupName || "") === "Favorites") return true;
  const key = extractMasterBouquetKey(groupName);
  return !!key && selectedKeys.has(key);
}

export function sortGroupsByMasterCategory(
  groups: string[],
  direction: "asc" | "desc" = "asc"
): string[] {
  const pinned = groups.filter((group) => group === "Favorites");
  const rest = groups.filter((group) => group !== "Favorites");
  rest.sort((left, right) => {
    const leftKey = extractMasterBouquetKey(left) || `\uFFFF${left}`;
    const rightKey = extractMasterBouquetKey(right) || `\uFFFF${right}`;
    let comparison = leftKey.localeCompare(rightKey, undefined, { numeric: true, sensitivity: "base" });
    if (comparison === 0) {
      comparison = left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
    }
    return direction === "asc" ? comparison : -comparison;
  });
  return [...pinned, ...rest];
}

export function collectMasterBouquetEntries(
  groups: string[],
  groupCounts: Record<string, number> = {}
): Array<{ key: string; label: string; groupCount: number; channelCount: number }> {
  const byKey = new Map<string, { groupCount: number; channelCount: number }>();

  for (const group of groups) {
    const key = extractMasterBouquetKey(group);
    if (!key) continue;
    const current = byKey.get(key) || { groupCount: 0, channelCount: 0 };
    current.groupCount += 1;
    current.channelCount += Number(groupCounts[group] || 0);
    byKey.set(key, current);
  }

  return Array.from(byKey.entries())
    .map(([key, counts]) => ({
      key,
      label: masterBouquetDisplayLabel(key),
      groupCount: counts.groupCount,
      channelCount: counts.channelCount
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
}
