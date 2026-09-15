// Remote-control key normalization for handlers that read arrow/Enter keys.
//
// webOS TV remotes deliver nonstandard KeyboardEvent values ("Up" instead of
// "ArrowUp", sometimes only a keyCode with key "Unidentified"). main.tsx tries
// to rewrite event.key globally via Object.defineProperty, but some webOS
// Chromium builds silently refuse that, so navigation handlers must not trust
// event.key alone. MainMenuScreen has always self-normalized for this reason —
// this is the shared equivalent for the other screens.

const KEYCODE_MAP: Record<number, string> = {
  13: "Enter",
  23: "Enter",
  66: "Enter",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  29443: "Enter",
  29460: "ArrowLeft",
  29461: "ArrowRight",
  29462: "ArrowUp",
  29463: "ArrowDown"
};

const KEY_ALIASES: Record<string, string> = {
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  OK: "Enter",
  Select: "Enter",
  NumpadEnter: "Enter"
};

export function normalizeRemoteNavKey(event: KeyboardEvent): string {
  const raw = String(event.key || "");
  if (KEY_ALIASES[raw]) return KEY_ALIASES[raw];
  if (raw && raw !== "Unidentified") return raw;
  return KEYCODE_MAP[Number(event.keyCode || 0)] || raw;
}

const MEDIA_KEYCODE_MAP: Record<number, string> = {
  19: "MediaPause",
  412: "MediaRewind",
  413: "MediaStop",
  415: "MediaPlay",
  417: "MediaFastForward",
  463: "MediaPlayPause",
  10252: "MediaPlayPause"
};

const MEDIA_KEY_ALIASES: Record<string, string> = {
  Play: "MediaPlay",
  Pause: "MediaPause",
  PlayPause: "MediaPlayPause",
  Rewind: "MediaRewind",
  FastForward: "MediaFastForward",
  FastFwd: "MediaFastForward",
  Stop: "MediaStop"
};

export function normalizeRemoteMediaKey(event: KeyboardEvent): string | null {
  const raw = String(event.key || "");
  if (MEDIA_KEY_ALIASES[raw]) return MEDIA_KEY_ALIASES[raw];
  if (raw.startsWith("Media")) return raw;
  return MEDIA_KEYCODE_MAP[Number(event.keyCode || 0)] || null;
}
