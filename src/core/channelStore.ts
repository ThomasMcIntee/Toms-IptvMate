export type ContentType = "live" | "movie" | "series";

export type Channel = {
  id: string;
  name: string;
  logo?: string;
  url: string;
  group?: string;
  contentType?: ContentType;
  parentGroup?: string; // For series: group that contains this series
  episodeInfo?: {
    season?: number;
    episode?: number;
    title?: string;
  };
};

let channels: Channel[] = [];
let activeGroup: string = "All";
const VISIBILITY_KEY = "iptvmate_visibility";
const CHANNELS_CACHE_KEY = "iptvmate_channels_cache";

type VisibilityState = {
  groups: Record<string, boolean>;
  channels: Record<string, boolean>;
};

let visibilityState: VisibilityState = loadVisibilityState();

function loadCachedChannels(): Channel[] {
  try {
    const raw = localStorage.getItem(CHANNELS_CACHE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is Channel => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<Channel>;
        return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.url === "string";
      })
      .map((item) => ({
        ...item,
        group: normalizeGroupName(item.group)
      }));
  } catch {
    return [];
  }
}

function saveCachedChannels(list: Channel[]) {
  try {
    localStorage.setItem(CHANNELS_CACHE_KEY, JSON.stringify(list));
  } catch {
    // Ignore persistence errors.
  }
}

channels = loadCachedChannels();
if (channels.length > 0) {
  const firstGroup = channels.find((c) => c.group && c.group !== "All")?.group;
  activeGroup = firstGroup || "All";
}

function loadVisibilityState(): VisibilityState {
  try {
    const raw = localStorage.getItem(VISIBILITY_KEY);
    if (!raw) {
      return { groups: {}, channels: {} };
    }

    const parsed = JSON.parse(raw) as Partial<VisibilityState>;
    return {
      groups: parsed.groups ?? {},
      channels: parsed.channels ?? {}
    };
  } catch {
    return { groups: {}, channels: {} };
  }
}

function saveVisibilityState() {
  try {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify(visibilityState));
  } catch {
    // Ignore persistence errors.
  }
}

function normalizeGroupName(group?: string): string {
  return (group && group.trim()) || "Uncategorized";
}

export function setChannels(list: Channel[]) {
  channels = list.map((c) => ({
    ...c,
    group: normalizeGroupName(c.group)
  }));
  saveCachedChannels(channels);

  const currentIds = new Set(channels.map((c) => c.id));
  const nextChannelVisibility: Record<string, boolean> = {};

  Object.entries(visibilityState.channels).forEach(([id, visible]) => {
    if (currentIds.has(id)) {
      nextChannelVisibility[id] = visible;
    }
  });

  visibilityState = {
    ...visibilityState,
    channels: nextChannelVisibility
  };
  saveVisibilityState();

  const firstGroup = channels.find((c) => c.group && c.group !== "All")?.group;
  activeGroup = firstGroup || "All";
}

export function getChannels(): Channel[] {
  if (activeGroup === "All") return channels;
  return channels.filter((c) => c.group === activeGroup);
}

export function getAllChannels(): Channel[] {
  return channels;
}

export function getGroups(): string[] {
  const groups = new Set<string>();
  groups.add("All");

  channels.forEach((c) => {
    if (c.group) groups.add(c.group);
  });

  return Array.from(groups);
}

export function isGroupVisible(group: string): boolean {
  if (group === "All") return true;
  return visibilityState.groups[group] !== false;
}

export function setGroupVisible(group: string, visible: boolean) {
  if (group === "All") return;
  visibilityState = {
    ...visibilityState,
    groups: {
      ...visibilityState.groups,
      [group]: visible
    }
  };
  saveVisibilityState();
}

export function isChannelVisible(channelId: string): boolean {
  return visibilityState.channels[channelId] !== false;
}

export function setChannelVisible(channelId: string, visible: boolean) {
  visibilityState = {
    ...visibilityState,
    channels: {
      ...visibilityState.channels,
      [channelId]: visible
    }
  };
  saveVisibilityState();
}

export function setActiveGroup(group: string) {
  activeGroup = group;
}

export function getActiveGroup(): string {
  return activeGroup;
}
