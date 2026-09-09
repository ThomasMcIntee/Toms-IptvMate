/**
 * Cooperative main-thread priorities for TV/WebView:
 *   1. input  — remote, mouse, keyboard must stay instant
 *   2. playback — start/stop/seek may wait for a quiet input burst
 *   3. background — catalog reload, EPG, cache persist run last
 *
 * The browser/WebView has one JS thread. This module does not create OS
 * threads; it yields heavy work whenever the user is interacting or a
 * stream is starting so input handlers can run.
 */

export type TaskPriority = "input" | "playback" | "background";

const INPUT_BURST_MS = 90;
const INPUT_QUIET_MS = 220;
const PLAYBACK_IDLE_TIMEOUT_MS = 120;
const BACKGROUND_IDLE_TIMEOUT_MS = 50;

let initialized = false;
let lastInputAt = 0;
let playbackBusy = false;

type SchedulerPostTask = (
  callback: () => void,
  options?: { priority?: "user-blocking" | "user-visible" | "background" }
) => Promise<void>;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function getSchedulerPostTask(): SchedulerPostTask | null {
  const scheduler = (globalThis as { scheduler?: { postTask?: SchedulerPostTask } }).scheduler;
  return typeof scheduler?.postTask === "function" ? scheduler.postTask.bind(scheduler) : null;
}

export function noteUserInput(): void {
  lastInputAt = now();
}

export function isUserInputActive(windowMs = INPUT_QUIET_MS): boolean {
  return lastInputAt > 0 && now() - lastInputAt < windowMs;
}

export function setPlaybackActive(active: boolean): void {
  playbackBusy = active;
}

export function isPlaybackActive(): boolean {
  return playbackBusy;
}

/** How many parallel background fetches to run right now. */
export function getBackgroundConcurrency(max: number): number {
  const safeMax = Math.max(1, max);
  if (isUserInputActive(INPUT_BURST_MS)) return 1;
  if (playbackBusy) return Math.min(2, safeMax);
  return safeMax;
}

function yieldTimeout(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function yieldAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 16);
  });
}

function yieldIdle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: timeoutMs });
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

async function postOrFallback(
  priority: "user-blocking" | "user-visible" | "background",
  fallback: () => Promise<void>
): Promise<void> {
  const postTask = getSchedulerPostTask();
  if (!postTask) {
    await fallback();
    return;
  }
  try {
    await postTask(() => undefined, { priority });
  } catch {
    await fallback();
  }
}

/**
 * Yield so higher-priority work can run.
 * Background callers wait out remote/keyboard bursts, then idle.
 */
export async function yieldToPriority(priority: TaskPriority = "background"): Promise<void> {
  if (priority === "input") {
    await postOrFallback("user-blocking", async () => undefined);
    return;
  }

  if (priority === "playback") {
    while (isUserInputActive(INPUT_BURST_MS)) {
      await yieldAnimationFrame();
    }
    await postOrFallback("user-visible", () => yieldAnimationFrame());
    return;
  }

  while (isUserInputActive(INPUT_QUIET_MS)) {
    await yieldAnimationFrame();
  }
  const idleTimeout = playbackBusy ? PLAYBACK_IDLE_TIMEOUT_MS : BACKGROUND_IDLE_TIMEOUT_MS;
  await postOrFallback("background", () => yieldIdle(idleTimeout));
}

/** Drop-in replacement for `setTimeout(0)` catalog yields. */
export function yieldToMain(): Promise<void> {
  return yieldToPriority("background");
}

export async function waitForBackgroundSlot(): Promise<void> {
  await yieldToPriority("background");
}

export async function waitForPlaybackSlot(): Promise<void> {
  await yieldToPriority("playback");
}

export function initTaskScheduler(): void {
  if (initialized || typeof document === "undefined") return;
  initialized = true;

  const mark = () => {
    noteUserInput();
  };
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  document.addEventListener("keydown", mark, opts);
  document.addEventListener("keyup", mark, opts);
  document.addEventListener("pointerdown", mark, opts);
  document.addEventListener("mousedown", mark, opts);
  document.addEventListener("touchstart", mark, opts);
  document.addEventListener("wheel", mark, opts);
}
