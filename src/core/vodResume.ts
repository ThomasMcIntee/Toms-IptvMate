const VOD_RESUME_KEY = "iptvmate_vod_resume";
const MAX_RESUME_ENTRIES = 80;
const MIN_RESUME_SECONDS = 30;
const NEAR_END_SECONDS = 60;
const NEAR_END_RATIO = 0.96;

export type VodResumeEntry = {
  position: number;
  duration: number;
  updatedAt: number;
  name?: string;
};

type VodResumeMap = Record<string, VodResumeEntry>;

export function vodResumeKey(channel: any): string | null {
  const id = String(channel?.id || "").trim();
  if (id) return `id:${id}`;
  const url = String(channel?.url || "").trim();
  return url ? `url:${url}` : null;
}

function loadResumeMap(): VodResumeMap {
  try {
    const raw = localStorage.getItem(VOD_RESUME_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as VodResumeMap) : {};
  } catch {
    return {};
  }
}

function saveResumeMap(map: VodResumeMap) {
  try {
    const entries = Object.entries(map);
    if (entries.length > MAX_RESUME_ENTRIES) {
      entries.sort((left, right) => (right[1]?.updatedAt || 0) - (left[1]?.updatedAt || 0));
      map = Object.fromEntries(entries.slice(0, MAX_RESUME_ENTRIES));
    }
    localStorage.setItem(VOD_RESUME_KEY, JSON.stringify(map));
  } catch {
    // Ignore persistence failures.
  }
}

export function getVodResume(channel: any): VodResumeEntry | null {
  const key = vodResumeKey(channel);
  if (!key) return null;
  const entry = loadResumeMap()[key];
  if (!entry || typeof entry.position !== "number") return null;
  return entry;
}

export function saveVodResume(channel: any, position: number, duration = 0) {
  const key = vodResumeKey(channel);
  if (!key) return;
  if (!Number.isFinite(position) || position < 5) return;

  const map = loadResumeMap();
  map[key] = {
    position,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    updatedAt: Date.now(),
    name: String(channel?.name || "")
  };
  saveResumeMap(map);
}

export function clearVodResume(channel: any) {
  const key = vodResumeKey(channel);
  if (!key) return;
  const map = loadResumeMap();
  if (!map[key]) return;
  delete map[key];
  saveResumeMap(map);
}

export function shouldOfferVodResume(entry: VodResumeEntry | null | undefined): boolean {
  if (!entry) return false;
  const position = entry.position;
  if (!Number.isFinite(position) || position < MIN_RESUME_SECONDS) return false;

  const duration = entry.duration;
  if (Number.isFinite(duration) && duration > MIN_RESUME_SECONDS) {
    if (position >= duration - NEAR_END_SECONDS) return false;
    if (position / duration >= NEAR_END_RATIO) return false;
  }

  return true;
}

export function formatResumeTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function readVideoPlaybackPosition(player: HTMLVideoElement | null): {
  position: number;
  duration: number;
} | null {
  if (!player) return null;
  const position = player.currentTime;
  const duration = player.duration;
  if (!Number.isFinite(position) || position < 1) return null;
  return {
    position,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0
  };
}
