import { useEffect, useRef } from "react";
import { activateFocusedRemoteControl, normalizeRemoteNavKey } from "../core/remoteKeys";
import { formatResumeTime } from "../core/vodResume";

type Props = {
  visible: boolean;
  title: string;
  position: number;
  onContinue: () => void;
  onRestart: () => void;
};

export function VodResumePrompt({
  visible,
  title,
  position,
  onContinue,
  onRestart
}: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!visible) return;

    const timer = window.setTimeout(() => {
      overlayRef.current?.querySelector<HTMLButtonElement>(".vod-resume-continue")?.focus();
    }, 40);

    const onKeyDown = (event: KeyboardEvent) => {
      const overlay = overlayRef.current;
      if (!overlay) return;

      const key = normalizeRemoteNavKey(event);
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(key)) return;

      const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".vod-resume-actions button"));
      if (buttons.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      const active = document.activeElement as HTMLElement | null;
      const index = buttons.indexOf(active as HTMLButtonElement);

      if (key === "Enter") {
        if (index >= 0) {
          activateFocusedRemoteControl(buttons[index]);
        } else {
          buttons[0]?.click();
        }
        return;
      }

      const current = index >= 0 ? index : 0;
      const next =
        key === "ArrowLeft" || key === "ArrowUp"
          ? Math.max(0, current - 1)
          : Math.min(buttons.length - 1, current + 1);
      buttons[next]?.focus();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      ref={overlayRef}
      className="vod-resume-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Resume playback"
    >
      <div className="vod-resume-card">
        <h2 className="vod-resume-title">Resume playback</h2>
        <p className="vod-resume-copy">
          {title ? `${title}. ` : ""}
          Continue from {formatResumeTime(position)}, or restart from the beginning?
        </p>
        <div className="vod-resume-actions">
          <button type="button" className="vod-resume-continue" onClick={onContinue}>
            Continue
          </button>
          <button type="button" className="vod-resume-restart" onClick={onRestart}>
            Restart
          </button>
        </div>
      </div>
    </div>
  );
}
