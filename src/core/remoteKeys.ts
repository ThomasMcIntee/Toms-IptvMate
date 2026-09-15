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

// webOS Magic Remote OK often delivers a real click AND keydown Enter.
// Playlist-manager screens also have two Enter handlers. Either path toggles
// a checkbox twice (off, then straight back on) unless we collapse them.
const REMOTE_ACTIVATE_DEBOUNCE_MS = 450;
const lastRemoteActivateAt = new WeakMap<EventTarget, number>();

export function resolveRemoteActivateTarget(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return el instanceof HTMLElement ? el : null;
  const control = el.closest("button, [role='button'], a, input, select, textarea, label");
  if (!(control instanceof HTMLElement)) return el;
  if (control instanceof HTMLLabelElement) {
    const htmlFor = String(control.htmlFor || "").trim();
    if (htmlFor) {
      const labeled = document.getElementById(htmlFor);
      if (labeled instanceof HTMLElement) return labeled;
    }
    const nested = control.querySelector("input, button, select, textarea");
    if (nested instanceof HTMLElement) return nested;
  }
  return control;
}

export function noteRemoteActivate(target: EventTarget | null): void {
  const el = resolveRemoteActivateTarget(target);
  if (!el) return;
  lastRemoteActivateAt.set(el, Date.now());
}

export function consumeRemoteActivate(target: EventTarget | null): boolean {
  const el = resolveRemoteActivateTarget(target);
  if (!el) return false;
  const now = Date.now();
  const prev = lastRemoteActivateAt.get(el) || 0;
  if (now - prev < REMOTE_ACTIVATE_DEBOUNCE_MS) return false;
  lastRemoteActivateAt.set(el, now);
  return true;
}

export function activateFocusedRemoteControl(target: EventTarget | null): boolean {
  const el = resolveRemoteActivateTarget(target);
  if (!el || !consumeRemoteActivate(el)) return false;
  el.click();
  return true;
}

const COMPOSER_EDIT_DEBOUNCE_MS = 700;
let lastComposerEditAt = 0;
let lastComposerEditToken = "";

// webOS OK delivers click + Enter (and sometimes the letter key too). Those
// land as two appends of the same character, which looks like "L" → "LL".
export function beginComposerTextEdit(token: string): boolean {
  const now = Date.now();
  if (token === lastComposerEditToken && now - lastComposerEditAt < COMPOSER_EDIT_DEBOUNCE_MS) {
    return false;
  }
  lastComposerEditAt = now;
  lastComposerEditToken = token;
  return true;
}

export function resetComposerTextEditGuard(): void {
  lastComposerEditAt = 0;
  lastComposerEditToken = "";
}
