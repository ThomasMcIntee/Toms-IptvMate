export type PlaylistType = "m3u" | "xtream" | "stalker";

export type PlaylistEntry = {
  id: string;
  name: string;
  type: PlaylistType;
  data: any;
};

const KEY = "iptvmate_playlists";

export function loadPlaylists(): PlaylistEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function savePlaylist(entry: PlaylistEntry) {
  const all = loadPlaylists();
  all.push(entry);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function updatePlaylist(id: string, updated: PlaylistEntry) {
  const all = loadPlaylists().map((p) => (p.id === id ? updated : p));
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function deletePlaylist(id: string) {
  const all = loadPlaylists().filter((p) => p.id !== id);
  localStorage.setItem(KEY, JSON.stringify(all));
}
