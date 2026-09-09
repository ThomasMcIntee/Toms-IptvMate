import { useEffect, useRef, useState } from "react";
import { activateFocusedRemoteControl, normalizeRemoteNavKey } from "../core/remoteKeys";

const LETTER_KEYS = [
  "A", "B", "C", "D", "E", "F",
  "G", "H", "I", "J", "K", "L",
  "M", "N", "O", "P", "Q", "R",
  "S", "T", "U", "V", "W", "X",
  "Y", "Z", "0", "1", "2", "3",
  "4", "5", "6", "7", "8", "9"
];

const SYMBOL_KEYS = [".", ":", "/", "-", "_", "@", "?", "=", "&", "%", "+", "#"];

export function isRemoteTextComposerOpen(): boolean {
  return !!document.querySelector(".remote-text-composer");
}

export default function RemoteTextComposer({
  label,
  value,
  onChange,
  onDone,
  masked = false,
  maxLength = 256
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onDone: () => void;
  masked?: boolean;
  maxLength?: number;
}) {
  const [lower, setLower] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  const append = (chunk: string) => {
    if (value.length >= maxLength) return;
    onChange((value + chunk).slice(0, maxLength));
  };

  const backspace = () => {
    if (!value) return;
    onChange(value.slice(0, -1));
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      rootRef.current?.querySelector<HTMLButtonElement>(".remote-text-composer-actions button")?.focus();
    }, 40);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;

      const key = normalizeRemoteNavKey(event);
      const active = document.activeElement as HTMLElement | null;
      if (active && !root.contains(active) && active !== document.body && active !== document.documentElement) {
        if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight" || key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          root.querySelector<HTMLButtonElement>("button")?.focus();
        }
        return;
      }

      if (key === "Enter") {
        if (event.repeat) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        activateFocusedRemoteControl(active || root.querySelector("button"));
        return;
      }

      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;
      if (event.repeat) {
        event.preventDefault();
        return;
      }

      const actionButtons = Array.from(
        root.querySelectorAll<HTMLButtonElement>(".remote-text-composer-actions button")
      ).filter((btn) => !btn.disabled && btn.offsetParent !== null);
      const keyButtons = Array.from(
        root.querySelectorAll<HTMLButtonElement>(".remote-text-composer-grid button")
      ).filter((btn) => !btn.disabled && btn.offsetParent !== null);
      const actionIndex = active ? actionButtons.indexOf(active as HTMLButtonElement) : -1;
      const keyIndex = active ? keyButtons.indexOf(active as HTMLButtonElement) : -1;
      const firstKeyRect = keyButtons[0]?.getBoundingClientRect();
      const gridRect = keyButtons[0]?.closest(".remote-text-composer-grid")?.getBoundingClientRect();
      const keyColumns = firstKeyRect && gridRect
        ? Math.max(1, Math.floor((gridRect.width + 8) / (firstKeyRect.width + 8)))
        : 6;

      event.preventDefault();
      event.stopPropagation();

      const focus = (el: HTMLElement | null | undefined) => el?.focus();

      if (actionIndex >= 0) {
        if (key === "ArrowRight") focus(actionButtons[Math.min(actionButtons.length - 1, actionIndex + 1)]);
        else if (key === "ArrowLeft") focus(actionButtons[Math.max(0, actionIndex - 1)]);
        else if (key === "ArrowDown") focus(keyButtons[0] || actionButtons[actionIndex]);
        return;
      }

      if (keyIndex >= 0) {
        if (key === "ArrowRight") focus(keyButtons[Math.min(keyButtons.length - 1, keyIndex + 1)]);
        else if (key === "ArrowLeft") focus(keyButtons[Math.max(0, keyIndex - 1)]);
        else if (key === "ArrowDown") focus(keyButtons[Math.min(keyButtons.length - 1, keyIndex + keyColumns)]);
        else if (key === "ArrowUp") {
          if (keyIndex < keyColumns) focus(actionButtons[actionButtons.length - 1] || actionButtons[0]);
          else focus(keyButtons[keyIndex - keyColumns]);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const shown = !value ? " " : masked ? "•".repeat(Math.min(value.length, 24)) : value;
  const keys = [...LETTER_KEYS, ...SYMBOL_KEYS].map((key) =>
    /[A-Z]/.test(key) && lower ? key.toLowerCase() : key
  );

  return (
    <div className="remote-text-composer-layer">
      <div className="remote-text-composer-backdrop" aria-hidden="true" />
      <div
        ref={rootRef}
        className="remote-text-composer"
        role="dialog"
        aria-label={`Edit ${label}`}
      >
        <div className="remote-text-composer-label">{label}</div>
        <div className="remote-text-composer-value">{shown}</div>
        <div className="remote-text-composer-actions">
          <button
            type="button"
            className="series-main-search-btn remote-text-composer-backspace"
            onClick={backspace}
            disabled={value.length === 0}
          >
            Backspace
          </button>
          <button
            type="button"
            className="series-main-search-btn"
            onClick={() => onChange("")}
            disabled={value.length === 0}
          >
            Clear
          </button>
          <button
            type="button"
            className="series-main-search-btn"
            onClick={() => append(" ")}
            disabled={value.length >= maxLength}
          >
            Space
          </button>
          <button type="button" className="series-main-search-btn" onClick={() => setLower((current) => !current)}>
            {lower ? "ABC" : "abc"}
          </button>
          <button
            type="button"
            className="series-main-search-btn"
            onClick={() => append("://")}
            disabled={value.length >= maxLength}
          >
            ://
          </button>
          <button type="button" className="series-main-search-btn remote-text-composer-done" onClick={onDone}>
            Done
          </button>
        </div>
        <div className="remote-text-composer-grid">
          {keys.map((key) => (
            <button
              key={key}
              type="button"
              className="series-search-key"
              onClick={() => append(key)}
              disabled={value.length >= maxLength}
            >
              {key}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
