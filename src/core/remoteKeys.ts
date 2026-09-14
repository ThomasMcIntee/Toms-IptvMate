// Remote-control key normalization for handlers that read arrow/Enter keys.
//
// webOS TV remotes deliver nonstandard KeyboardEvent values ("Up" instead of
// "ArrowUp", sometimes only a keyCode with key "Unidentified"). main.tsx tries
// to rewrite event.key globally via Object.defineProperty, but some webOS
// Chromium builds silently refuse that, so navigation handlers must not trust
// event.key alone. MainMenuScreen has always self-normalized for this reason —
// this is the shared equivalent for the other screens.

import { isAndroidRuntime } from "./player/platformDetection";

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

// Android/Fire TV KeyEvent codes. Chromium often leaves these on keyCode
// even when event.key is already Arrow*. HTML's 19 is Pause, so Android must
// win on Fire Stick or D-pad Up is treated as MediaPause.
export const ANDROID_DPAD_KEYCODE_MAP: Record<number, string> = {
  19: "ArrowUp",
  20: "ArrowDown",
  21: "ArrowLeft",
  22: "ArrowRight"
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
  const keyCode = Number(event.keyCode || 0);
  if (isAndroidRuntime() && ANDROID_DPAD_KEYCODE_MAP[keyCode]) {
    if (!raw || raw === "Unidentified" || raw.startsWith("Arrow") || raw === "MediaPause") {
      return ANDROID_DPAD_KEYCODE_MAP[keyCode];
    }
  }
  if (raw && raw !== "Unidentified") return raw;
  return KEYCODE_MAP[keyCode] || raw;
}

const MEDIA_KEYCODE_MAP: Record<number, string> = {
  19: "MediaPause",
  85: "MediaPlayPause",
  86: "MediaStop",
  89: "MediaRewind",
  90: "MediaFastForward",
  126: "MediaPlay",
  127: "MediaPause",
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
  const navKey = normalizeRemoteNavKey(event);
  if (
    navKey === "ArrowUp" ||
    navKey === "ArrowDown" ||
    navKey === "ArrowLeft" ||
    navKey === "ArrowRight" ||
    navKey === "Enter"
  ) {
    return null;
  }
  const raw = String(event.key || "");
  if (MEDIA_KEY_ALIASES[raw]) return MEDIA_KEY_ALIASES[raw];
  if (raw.startsWith("Media")) return raw;
  const keyCode = Number(event.keyCode || 0);
  if (isAndroidRuntime() && ANDROID_DPAD_KEYCODE_MAP[keyCode]) return null;
  return MEDIA_KEYCODE_MAP[keyCode] || null;
}

export function focusRemoteControl(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.focus();
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    try {
      el.scrollIntoView();
    } catch {
      // Older WebViews may not support scrollIntoView.
    }
  }
}

export function isRemoteControlVisible(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement | HTMLInputElement).disabled) return false;
  if (el.offsetParent === null) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= 2 && rect.height >= 2;
}

export function stepSpatialFocus(
  stops: HTMLElement[],
  active: HTMLElement | null,
  key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
): HTMLElement | null {
  if (stops.length === 0) return null;
  const index = active ? stops.indexOf(active) : -1;
  if (index < 0) return stops[0] || null;

  const current = stops[index];
  const currentRect = current.getBoundingClientRect();
  const currentCenterX = currentRect.left + currentRect.width / 2;
  const currentCenterY = currentRect.top + currentRect.height / 2;
  const sameRow = (el: HTMLElement) =>
    Math.abs(el.getBoundingClientRect().top - currentRect.top) < 18;

  if (key === "ArrowLeft" || key === "ArrowRight") {
    const goingRight = key === "ArrowRight";
    const row = stops.filter(sameRow);
    const rowIndex = row.indexOf(current);
    const inline = goingRight ? row[rowIndex + 1] : row[rowIndex - 1];
    if (inline) return inline;

    const sideways = stops.filter((el) => {
      const rect = el.getBoundingClientRect();
      return goingRight
        ? rect.left >= currentRect.right - 8
        : rect.right <= currentRect.left + 8;
    });
    if (sideways.length === 0) return current;
    sideways.sort((a, b) => spatialScore(a, currentCenterX, currentCenterY) - spatialScore(b, currentCenterX, currentCenterY));
    return sideways[0] || current;
  }

  const downward = key === "ArrowDown";
  const candidates = stops.filter((el) => {
    const top = el.getBoundingClientRect().top;
    return downward ? top > currentRect.top + 10 : top < currentRect.top - 10;
  });
  if (candidates.length === 0) {
    return (downward ? stops[index + 1] : stops[index - 1]) || current;
  }
  candidates.sort((a, b) => spatialScore(a, currentCenterX, currentCenterY) - spatialScore(b, currentCenterX, currentCenterY));
  return candidates[0] || current;
}

function spatialScore(el: HTMLElement, originX: number, originY: number): number {
  const rect = el.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  return Math.abs(centerY - originY) * 8 + Math.abs(centerX - originX);
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
