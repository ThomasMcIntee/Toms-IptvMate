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

function normalizeContentPrefix(kind: string): "TV" | "Movies" | "Series" {
  if (/^tv$/i.test(kind)) return "TV";
  if (/^movies$/i.test(kind)) return "Movies";
  return "Series";
}

function normalizeParenBouquetKind(kind: string): string {
  if (/^tv$/i.test(kind)) return "Tv";
  if (/^vod$/i.test(kind)) return "Vod";
  if (/^movies?$/i.test(kind)) return "Movies";
  if (/^series$/i.test(kind)) return "Series";
  return kind;
}

/**
 * Collapse provider bouquets that share the same `(Tv:???|` / `(Vod:???|`
 * (or `TV: ???|` / `Movies: EN -` / `Series: NETFLIX`) prefix into one key.
 */
export function extractMasterBouquetKey(groupName: string): string | null {
  const raw = String(groupName || "").trim();
  if (!raw || raw === "Favorites") return null;

  const paren = raw.match(/\(\s*(Tv|Vod|Movies?|Series)\s*:\s*([^)|]+)\|/i);
  if (paren) {
    return `(${normalizeParenBouquetKind(paren[1])}:${paren[2].trim()}|`;
  }

  const pipePrefixed = raw.match(/^(TV|Movies|Series):\s*([^|]+)\|/i);
  if (pipePrefixed) {
    return `${normalizeContentPrefix(pipePrefixed[1])}: ${pipePrefixed[2].trim()}|`;
  }

  const vodToken = raw.match(/^(Movies|Series):\s*(\S+)/i);
  if (vodToken) {
    return `${normalizeContentPrefix(vodToken[1])}: ${vodToken[2]}`;
  }

  return null;
}

export function masterBouquetDisplayLabel(key: string): string {
  const paren = String(key || "").match(/\(\s*(?:Tv|Vod|Movies?|Series)\s*:\s*([^)|]+)/i);
  if (paren) return paren[1].trim();
  const pipePrefixed = String(key || "").match(/^(?:TV|Movies|Series):\s*([^|]+)\|/i);
  if (pipePrefixed) return pipePrefixed[1].trim();
  const vodToken = String(key || "").match(/^(?:Movies|Series):\s*(.+)$/i);
  if (vodToken) return vodToken[1].trim();
  return String(key || "").replace(/\|$/, "");
}

export function isLiveMasterBouquetKey(key: string): boolean {
  const raw = String(key || "").trim();
  return /^\(\s*Tv\s*:/i.test(raw) || /^TV\s*:/i.test(raw);
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
): Array<{
  key: string;
  label: string;
  firstGroup: string;
  groups: string[];
  groupCount: number;
  channelCount: number;
}> {
  const byKey = new Map<
    string,
    { firstGroup: string; groups: string[]; channelCount: number }
  >();

  for (const group of groups) {
    const key = extractMasterBouquetKey(group);
    if (!key) continue;
    const current = byKey.get(key);
    if (current) {
      current.groups.push(group);
      current.channelCount += Number(groupCounts[group] || 0);
    } else {
      byKey.set(key, {
        firstGroup: group,
        groups: [group],
        channelCount: Number(groupCounts[group] || 0)
      });
    }
  }

  return Array.from(byKey.entries())
    .map(([key, entry]) => {
      const groupsInCategory = [...entry.groups].sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
      );
      const firstGroup = groupsInCategory[0] || entry.firstGroup;
      return {
        key,
        label: firstGroup,
        firstGroup,
        groups: groupsInCategory,
        groupCount: groupsInCategory.length,
        channelCount: entry.channelCount
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
}
