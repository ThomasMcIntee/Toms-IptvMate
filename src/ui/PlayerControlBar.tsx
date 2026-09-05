import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getEPGForChannel, getEPGVersion, subscribeEPG } from "../core/epgStore";
import { formatEpgTime } from "../core/epgTime";
import { setNativePlayerGuide } from "../core/nativePlayerBridge";

const CONTROLS_HIDE_MS = 3500;

type PlayerChannel = {
  id?: string;
  name?: string;
  number?: string | number;
  epgChannelId?: string;
} | null;

export function PlayerControlBar({
  channel,
  paused,
  muted,
  fullscreen,
  isFavorite = false,
  onPlayPause,
  onMute,
  onFullscreen,
  onToggleFavorite
}: {
  channel: PlayerChannel;
  paused: boolean;
  muted: boolean;
  fullscreen: boolean;
  isFavorite?: boolean;
  onPlayPause: () => void;
  onMute: () => void;
  onFullscreen: () => void;
  onToggleFavorite?: () => void;
}) {
  useSyncExternalStore(subscribeEPG, getEPGVersion, getEPGVersion);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [revealed, setRevealed] = useState(true);
  const barRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const focusedRef = useRef(false);
  const ignoreFocusUntilRef = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const currentProgram = useMemo(() => {
    if (!channel) return null;
    const events = getEPGForChannel(channel);
    return events.find((event) => event.start <= nowMs && event.end >= nowMs) || null;
  }, [channel, nowMs]);

  useEffect(() => {
    if (!channel) {
      setNativePlayerGuide(null);
      return;
    }
    setNativePlayerGuide({
      title: currentProgram?.title || String(channel.name || ""),
      startMs: currentProgram?.start || 0,
      endMs: currentProgram?.end || 0
    });
  }, [channel, currentProgram?.title, currentProgram?.start, currentProgram?.end]);

  useEffect(() => {
    return () => setNativePlayerGuide(null);
  }, []);

  useEffect(() => {
    const clearHideTimer = () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    const hideBar = () => {
      focusedRef.current = false;
      ignoreFocusUntilRef.current = Date.now() + 450;
      setRevealed(false);
      const active = document.activeElement;
      if (active instanceof HTMLElement && barRef.current?.contains(active)) {
        active.blur();
      }
    };

    const scheduleHide = () => {
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        hideBar();
      }, CONTROLS_HIDE_MS);
    };

    const reveal = () => {
      ignoreFocusUntilRef.current = 0;
      setRevealed(true);
      scheduleHide();
    };

    reveal();

    const shell =
      barRef.current?.closest(".live-preview-shell") ??
      document.querySelector(".live-preview-shell");
    // webOS Magic Remote streams mousemove over the video; only clicks/taps
    // should keep the bar visible. Listen for mouse too — some webOS builds
    // never emit PointerEvents.
    const onPointer = () => reveal();
    shell?.addEventListener("pointerdown", onPointer);
    shell?.addEventListener("mousedown", onPointer);

    const onPlayerReveal = () => reveal();
    window.addEventListener("playerRevealControls", onPlayerReveal);

    return () => {
      clearHideTimer();
      shell?.removeEventListener("pointerdown", onPointer);
      shell?.removeEventListener("mousedown", onPointer);
      window.removeEventListener("playerRevealControls", onPlayerReveal);
    };
  }, [channel?.id, fullscreen]);

  if (!channel) return null;

  const duration = currentProgram ? currentProgram.end - currentProgram.start : 0;
  const progress =
    currentProgram && duration > 0
      ? Math.max(0, Math.min(1, (nowMs - currentProgram.start) / duration))
      : 0;
  const title = currentProgram?.title || String(channel.name || "Live TV");
  const timeLabel = currentProgram
    ? `${formatEpgTime(currentProgram.start)} – ${formatEpgTime(currentProgram.end)}`
    : "Live";

  return (
    <div
      ref={barRef}
      className={`player-control-bar${revealed ? "" : " player-control-bar-hidden"}`}
      role="group"
      aria-label="Player controls"
      inert={!revealed || undefined}
      onFocusCapture={(event) => {
        if (
          Date.now() < ignoreFocusUntilRef.current ||
          barRef.current?.classList.contains("player-control-bar-hidden")
        ) {
          if (event.target instanceof HTMLElement) event.target.blur();
          return;
        }
        focusedRef.current = true;
        setRevealed(true);
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
        }
        hideTimerRef.current = window.setTimeout(() => {
          hideTimerRef.current = null;
          focusedRef.current = false;
          ignoreFocusUntilRef.current = Date.now() + 450;
          setRevealed(false);
          const active = document.activeElement;
          if (active instanceof HTMLElement && barRef.current?.contains(active)) {
            active.blur();
          }
        }, CONTROLS_HIDE_MS);
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget as Node | null;
        const staying = !!(next && barRef.current?.contains(next));
        focusedRef.current = staying;
        if (!staying) {
          if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null;
            if (!focusedRef.current) {
              ignoreFocusUntilRef.current = Date.now() + 450;
              setRevealed(false);
            }
          }, CONTROLS_HIDE_MS);
        }
      }}
    >
      <div className="player-control-bar-progress" aria-hidden="true">
        <div className="player-control-bar-progress-track">
          <div
            className="player-control-bar-progress-fill"
            style={{ width: `${Math.round(progress * 1000) / 10}%` }}
          />
        </div>
      </div>
      <div className="player-control-bar-row">
        <button
          type="button"
          className="player-control-bar-btn"
          tabIndex={revealed ? 0 : -1}
          onClick={onPlayPause}
          aria-label={paused ? "Play" : "Pause"}
        >
          {paused ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z" />
            </svg>
          )}
        </button>
        <span className="player-control-bar-time">{timeLabel}</span>
        <span className="player-control-bar-title">{title}</span>
        <span className="player-control-bar-live">LIVE</span>
        <button
          type="button"
          className="player-control-bar-btn"
          tabIndex={revealed ? 0 : -1}
          onClick={onMute}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M16.5 12a4.5 4.5 0 0 0-2.5-4V6.05A6.5 6.5 0 0 1 18.5 12c0 .9-.18 1.76-.5 2.54l-1.16-1.16c.1-.44.16-.9.16-1.38zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25A6.47 6.47 0 0 1 12 18.95v-2.02c.46-.11.9-.3 1.3-.54l1.42 1.42A8.5 8.5 0 0 1 12 19.95 8.5 8.5 0 0 1 7.5 18H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2.73L4.27 3zM14 3.05v2.02c1.76.7 3 2.4 3 4.43 0 .34-.03.67-.1.99L14 7.64V3.05z"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.05v7.9A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
              />
            </svg>
          )}
        </button>
        {onToggleFavorite && (
          <button
            type="button"
            className={`player-control-bar-btn player-control-bar-favorite${isFavorite ? " is-favorite" : ""}`}
            tabIndex={revealed ? 0 : -1}
            onClick={onToggleFavorite}
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            {isFavorite ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"
                />
              </svg>
            )}
          </button>
        )}
        <button
          type="button"
          className="player-control-bar-btn"
          tabIndex={revealed ? 0 : -1}
          onClick={onFullscreen}
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {fullscreen ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm12 5h-5v-2h3v-3h2v5zM7 7h3V5H5v5h2V7zm12 3h-2V7h-3V5h5v5z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm12 0h-2v3h-3v2h5v-5zM7 7h3V5H5v5h2V7zm7-2v2h3v3h2V5h-5z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export function VodExitButton({
  visible,
  onExit
}: {
  visible: boolean;
  onExit: () => void;
}) {
  const [revealed, setRevealed] = useState(true);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      setRevealed(true);
      return;
    }

    const clearHideTimer = () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    const scheduleHide = () => {
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        if (focusedRef.current) return;
        setRevealed(false);
        const active = document.activeElement;
        if (active instanceof HTMLElement && buttonRef.current === active) {
          active.blur();
        }
      }, CONTROLS_HIDE_MS);
    };

    const reveal = () => {
      setRevealed(true);
      if (focusedRef.current) {
        clearHideTimer();
        return;
      }
      scheduleHide();
    };

    reveal();

    const onPointer = () => reveal();
    document.addEventListener("mousemove", onPointer);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("playerRevealControls", reveal);

    return () => {
      clearHideTimer();
      document.removeEventListener("mousemove", onPointer);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("playerRevealControls", reveal);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`vod-exit-btn${revealed ? "" : " vod-exit-btn-hidden"}`}
      onClick={onExit}
      aria-label="Exit movie playback"
      onFocus={() => {
        focusedRef.current = true;
        setRevealed(true);
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = window.setTimeout(() => {
          hideTimerRef.current = null;
          if (!focusedRef.current) setRevealed(false);
        }, CONTROLS_HIDE_MS);
      }}
    >
      Back
    </button>
  );
}
