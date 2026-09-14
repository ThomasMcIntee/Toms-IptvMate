import { useEffect, useRef, useState } from "react";
import packageJson from "../../package.json";
import { loadPlaylists, describeStoredPlaylists } from "../core/playlistStore";
import { getAllChannels } from "../core/channelStore";
import { webosDbSelfTest } from "../core/webosStorage";
import {
  getPlaybackBufferLevel,
  setPlaybackBufferLevel,
  type PlaybackBufferLevel
} from "../core/playerEngine";
import {
  APP_LANGUAGES,
  setAppLanguage,
  translate,
  useAppLanguage
} from "../core/appLanguage";
import {
  activateFocusedRemoteControl,
  focusRemoteControl,
  isRemoteControlVisible,
  normalizeRemoteNavKey,
  stepSpatialFocus
} from "../core/remoteKeys";
import {
  addScheduleHours,
  addScheduleMinutes,
  cycleScheduleDays,
  formatChildScheduleSummary,
  formatMinutes,
  loadChildLoginSchedules,
  saveChildLoginSchedules,
  type ChildLoginSchedule,
  type ChildScheduleDays
} from "../core/childLoginSchedule";

type Props = {
  visible: boolean;
  onOpenPlayback: () => void;
  onOpenStorage: () => void;
  onExit: () => void;
};

export default function RecordingLibrary({ visible, onOpenPlayback, onOpenStorage, onExit }: Props) {
  const appVersion = String((packageJson as { version?: string }).version || "dev");
  const [storageSummary, setStorageSummary] = useState("");
  const [savedDataInfo, setSavedDataInfo] = useState("");
  const [dbStatus, setDbStatus] = useState("testing…");

  // Storage health readout so persistence issues can be diagnosed on the TV
  // without the hidden overlay.
  useEffect(() => {
    if (!visible) return;

    try {
      const playlistCount = loadPlaylists().length;
      const channelCount = getAllChannels().length;
      let lsPlaylists = "missing";
      let lsChannels = "missing";
      try {
        const rawPlaylists = localStorage.getItem("iptvmate_playlists");
        if (rawPlaylists !== null) lsPlaylists = `${rawPlaylists.length} chars`;
        const rawChannels = localStorage.getItem("iptvmate_channels_cache");
        if (rawChannels !== null) lsChannels = `${rawChannels.length} chars`;
      } catch {
        lsPlaylists = "error";
        lsChannels = "error";
      }
      setStorageSummary(
        `${playlistCount} playlists, ${channelCount} channels loaded | saved: playlists ${lsPlaylists}, channels ${lsChannels}`
      );
    } catch {
      setStorageSummary("unavailable");
    }

    try {
      setSavedDataInfo(describeStoredPlaylists());
    } catch {
      setSavedDataInfo("unavailable");
    }

    let cancelled = false;
    setDbStatus("testing…");
    void webosDbSelfTest().then((result) => {
      if (!cancelled) setDbStatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const [masterCode, setMasterCode] = useState(() => {
    try {
      return localStorage.getItem("iptvmate_setup_master_code") || "";
    } catch {
      return "";
    }
  });
  const [adultCode, setAdultCode] = useState(() => {
    try {
      return localStorage.getItem("iptvmate_setup_adult_code") || "";
    } catch {
      return "";
    }
  });
  const [childCode, setChildCode] = useState(() => {
    try {
      return localStorage.getItem("iptvmate_setup_child_code") || "";
    } catch {
      return "";
    }
  });
  const [loginRequired, setLoginRequired] = useState(() => {
    try {
      return localStorage.getItem("iptvmate_setup_login_required") === "1";
    } catch {
      return false;
    }
  });
  const [lightMode, setLightMode] = useState(() => {
    try {
      return localStorage.getItem("iptvmate_setup_light_mode") === "1";
    } catch {
      return false;
    }
  });
  const [bufferLevel, setBufferLevel] = useState<PlaybackBufferLevel>(() => getPlaybackBufferLevel());
  const [childSchedules, setChildSchedules] = useState<ChildLoginSchedule[]>(() => loadChildLoginSchedules());
  const [editingScheduleIndex, setEditingScheduleIndex] = useState<number | null>(null);
  const language = useAppLanguage();
  const t = (key: Parameters<typeof translate>[0]) => translate(key, language);
  const overlayRef = useRef<HTMLDivElement>(null);
  const didInitialFocusRef = useRef(false);
  const lastEditedHoursRef = useRef<number | null>(null);

  useEffect(() => {
    document.body.classList.toggle("theme-light", lightMode);
  }, [lightMode]);

  useEffect(() => {
    try {
      localStorage.setItem("iptvmate_setup_login_required", loginRequired ? "1" : "0");
    } catch {
      // Ignore storage errors in restricted environments.
    }
  }, [loginRequired]);

  useEffect(() => {
    try {
      localStorage.setItem("iptvmate_setup_light_mode", lightMode ? "1" : "0");
    } catch {
      // Ignore storage errors in restricted environments.
    }
  }, [lightMode]);

  useEffect(() => {
    try {
      localStorage.setItem("iptvmate_setup_master_code", masterCode);
      localStorage.setItem("iptvmate_setup_adult_code", adultCode);
      localStorage.setItem("iptvmate_setup_child_code", childCode);
    } catch {
      // Ignore storage errors in restricted environments.
    }
  }, [masterCode, adultCode, childCode]);

  useEffect(() => {
    saveChildLoginSchedules(childSchedules);
  }, [childSchedules]);

  useEffect(() => {
    if (!visible) {
      didInitialFocusRef.current = false;
      lastEditedHoursRef.current = null;
      return;
    }
    if (editingScheduleIndex !== null) return;

    const focusInitial = () => {
      if (didInitialFocusRef.current) return;
      const first = overlayRef.current?.querySelector<HTMLButtonElement>(".recording-setup-btn");
      if (!first) return;
      focusRemoteControl(first);
      if (document.activeElement === first) {
        didInitialFocusRef.current = true;
      }
    };
    const timers = [40, 160, 400].map((ms) => window.setTimeout(focusInitial, ms));

    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector(".child-hours-editor-overlay")) return;
      const overlay = overlayRef.current;
      if (!overlay) return;

      const key = normalizeRemoteNavKey(event);
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key)) return;

      const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".recording-setup-btn")).filter(
        (btn) => isRemoteControlVisible(btn)
      );
      if (buttons.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      if (active && !overlay.contains(active) && active !== document.body && active !== document.documentElement) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (key === "Enter") {
        if (event.repeat) return;
        activateFocusedRemoteControl(active && overlay.contains(active) ? active : buttons[0]);
        return;
      }

      const next = stepSpatialFocus(
        buttons,
        active && overlay.contains(active) ? active : null,
        key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
      );
      focusRemoteControl(next);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [visible, editingScheduleIndex]);

  useEffect(() => {
    if (!visible || editingScheduleIndex !== null) return;
    const hoursId = lastEditedHoursRef.current;
    lastEditedHoursRef.current = null;
    if (hoursId === null) return;
    const setupId = hoursId === 0 ? "child-hours-1" : "child-hours-2";
    const timer = window.setTimeout(() => {
      overlayRef.current
        ?.querySelector<HTMLButtonElement>(`.recording-setup-btn[data-setup-id="${setupId}"]`)
        ?.focus();
    }, 40);
    return () => window.clearTimeout(timer);
  }, [visible, editingScheduleIndex]);

  function daysLabel(days: ChildScheduleDays) {
    if (days === "weekdays") return t("childHoursWeekdays");
    if (days === "weekends") return t("childHoursWeekends");
    return t("childHoursAllDays");
  }

  function setFourCharCode(
    title: string,
    currentCode: string,
    apply: (value: string) => void
  ) {
    const raw = prompt(`Enter 4 letters/numbers for ${title}:`, currentCode || "");
    if (raw === null) return;

    const value = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(value)) {
      alert(`${title} must be exactly 4 letters/numbers.`);
      return;
    }

    apply(value);
  }

  function cycleBufferLevel() {
    const nextLevel: PlaybackBufferLevel =
      bufferLevel === "off"
        ? "low"
        : bufferLevel === "low"
        ? "medium"
        : bufferLevel === "medium"
        ? "high"
        : "off";
    setPlaybackBufferLevel(nextLevel);
    setBufferLevel(nextLevel);
  }

  function cycleLanguage() {
    const currentIndex = APP_LANGUAGES.findIndex((option) => option.code === language);
    const nextLanguage = APP_LANGUAGES[(currentIndex + 1) % APP_LANGUAGES.length];
    setAppLanguage(nextLanguage.code);
  }

  if (!visible) return null;

  const scheduleTitles = [t("childHours1"), t("childHours2")];
  const setupButtons = [
    {
      id: "login",
      label: loginRequired ? t("loginRequired") : t("enableLogin"),
      onClick: () => setLoginRequired((current) => !current)
    },
    {
      id: "master",
      label: `${t("masterCode")}${masterCode ? ` (${t("set")})` : ""}`,
      onClick: () => setFourCharCode("Master Code", masterCode, setMasterCode)
    },
    {
      id: "adult",
      label: `${t("adultCode")}${adultCode ? ` (${t("set")})` : ""}`,
      onClick: () => setFourCharCode("Adult Code", adultCode, setAdultCode)
    },
    {
      id: "child",
      label: `${t("childCode")}${childCode ? ` (${t("set")})` : ""}`,
      onClick: () => setFourCharCode("Child Code", childCode, setChildCode)
    },
    {
      id: "child-hours-1",
      label: `${scheduleTitles[0]}: ${formatChildScheduleSummary(childSchedules[0], t("childHoursOff"), daysLabel)}`,
      onClick: () => {
        lastEditedHoursRef.current = 0;
        setEditingScheduleIndex(0);
      }
    },
    {
      id: "child-hours-2",
      label: `${scheduleTitles[1]}: ${formatChildScheduleSummary(childSchedules[1], t("childHoursOff"), daysLabel)}`,
      onClick: () => {
        lastEditedHoursRef.current = 1;
        setEditingScheduleIndex(1);
      }
    },
    {
      id: "theme",
      label: lightMode ? t("darkMode") : t("lightMode"),
      onClick: () => setLightMode((current) => !current)
    },
    {
      id: "buffer",
      label: `${t("buffer")}: ${bufferLevel === "off" ? t("off") : bufferLevel === "low" ? `${t("low")} (10s)` : bufferLevel === "medium" ? `${t("medium")} (30s)` : `${t("high")} (60s)`}`,
      onClick: cycleBufferLevel
    },
    {
      id: "language",
      label: `${t("language")}: ${APP_LANGUAGES.find((option) => option.code === language)?.label || "English"}`,
      onClick: cycleLanguage
    },
    { id: "exit", label: t("exitSetup"), onClick: onExit }
  ];

  return (
    <div className="recording-setup-overlay" ref={overlayRef}>
      <div className="side-panel recording-setup-panel">
        <h2>{t("setupTitle")}</h2>

        <div className="recording-setup-grid">
          {setupButtons.map((button) => (
            <button
              key={button.id}
              type="button"
              className="btn-secondary recording-setup-btn"
              data-setup-id={button.id}
              onClick={button.onClick}
            >
              {button.label}
            </button>
          ))}
        </div>

        <div className="recording-setup-version" aria-label={t("programVersion")}>
          {t("programVersion")}: v{appVersion}
        </div>
        <div className="recording-setup-version" aria-label="Storage status">
          Storage: {storageSummary}
        </div>
        <div className="recording-setup-version" aria-label="Saved playlist data">
          Saved data: {savedDataInfo}
        </div>
        <div className="recording-setup-version" aria-label="TV database status">
          TV database: {dbStatus}
        </div>
      </div>

      {editingScheduleIndex !== null && childSchedules[editingScheduleIndex] && (
        <ChildHoursEditor
          title={scheduleTitles[editingScheduleIndex] || t("childHoursTitle")}
          help={t("childHoursHelp")}
          schedule={childSchedules[editingScheduleIndex]}
          daysLabel={daysLabel}
          saveLabel={t("childHoursSave")}
          disableLabel={t("childHoursDisable")}
          cancelLabel={t("childHoursCancel")}
          startLabel={t("childHoursStart")}
          endLabel={t("childHoursEnd")}
          daysTitle={t("childHoursDays")}
          onSave={(next) => {
            setChildSchedules((current) =>
              current.map((schedule, index) => (index === editingScheduleIndex ? next : schedule))
            );
            setEditingScheduleIndex(null);
          }}
          onCancel={() => setEditingScheduleIndex(null)}
        />
      )}
    </div>
  );
}

function TimeStepper({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="child-hours-time-block">
      <div className="child-hours-time-label">{label}</div>
      <div className="child-hours-time-controls">
        <button type="button" className="btn-secondary child-hours-step-btn" onClick={() => onChange(addScheduleHours(value, 1))}>
          Hour +
        </button>
        <button type="button" className="btn-secondary child-hours-step-btn" onClick={() => onChange(addScheduleMinutes(value, 15))}>
          Min +
        </button>
      </div>
      <div className="child-hours-time-value">{formatMinutes(value)}</div>
      <div className="child-hours-time-controls">
        <button type="button" className="btn-secondary child-hours-step-btn" onClick={() => onChange(addScheduleHours(value, -1))}>
          Hour −
        </button>
        <button type="button" className="btn-secondary child-hours-step-btn" onClick={() => onChange(addScheduleMinutes(value, -15))}>
          Min −
        </button>
      </div>
    </div>
  );
}

function ChildHoursEditor({
  title,
  help,
  schedule,
  daysLabel,
  saveLabel,
  disableLabel,
  cancelLabel,
  startLabel,
  endLabel,
  daysTitle,
  onSave,
  onCancel
}: {
  title: string;
  help: string;
  schedule: ChildLoginSchedule;
  daysLabel: (days: ChildScheduleDays) => string;
  saveLabel: string;
  disableLabel: string;
  cancelLabel: string;
  startLabel: string;
  endLabel: string;
  daysTitle: string;
  onSave: (schedule: ChildLoginSchedule) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ChildLoginSchedule>(() => ({ ...schedule }));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }, 40);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;

      const key = normalizeRemoteNavKey(event);
      if (key === "Escape" || key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }

      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
      if (buttons.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const index = active ? buttons.indexOf(active as HTMLButtonElement) : -1;

      if (key === "Enter") {
        if (event.repeat) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        activateFocusedRemoteControl(active || buttons[0]);
        return;
      }

      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;
      if (event.repeat) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const current = index < 0 ? 0 : index;
      const nextIndex =
        key === "ArrowRight" || key === "ArrowDown"
          ? (current + 1) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  return (
    <div className="child-hours-editor-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="child-hours-editor" ref={rootRef}>
        <h3>{title}</h3>
        <p className="child-hours-help">{help}</p>
        <button
          type="button"
          className="btn-secondary child-hours-days-btn"
          onClick={() => setDraft((current) => ({ ...current, days: cycleScheduleDays(current.days) }))}
        >
          {daysTitle}: {daysLabel(draft.days)}
        </button>
        <div className="child-hours-times">
          <TimeStepper
            label={startLabel}
            value={draft.startMinutes}
            onChange={(startMinutes) => setDraft((current) => ({ ...current, startMinutes }))}
          />
          <TimeStepper
            label={endLabel}
            value={draft.endMinutes}
            onChange={(endMinutes) => setDraft((current) => ({ ...current, endMinutes }))}
          />
        </div>
        <div className="child-hours-editor-actions">
          <button type="button" className="btn-primary" onClick={() => onSave({ ...draft, enabled: true })}>
            {saveLabel}
          </button>
          <button type="button" className="btn-secondary" onClick={() => onSave({ ...draft, enabled: false })}>
            {disableLabel}
          </button>
          <button type="button" className="btn-secondary child-hours-editor-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
