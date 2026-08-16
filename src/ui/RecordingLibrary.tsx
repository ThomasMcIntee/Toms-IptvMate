import { useEffect, useState } from "react";
import packageJson from "../../package.json";
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

type Props = {
  visible: boolean;
  onOpenPlayback: () => void;
  onOpenStorage: () => void;
  onExit: () => void;
};

export default function RecordingLibrary({ visible, onOpenPlayback, onOpenStorage, onExit }: Props) {
  const appVersion = String((packageJson as { version?: string }).version || "dev");
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
  const language = useAppLanguage();
  const t = (key: Parameters<typeof translate>[0]) => translate(key, language);

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

  const setupButtons = [
    {
      label: loginRequired ? t("loginRequired") : t("enableLogin"),
      onClick: () => setLoginRequired((current) => !current)
    },
    {
      label: `${t("masterCode")}${masterCode ? ` (${t("set")})` : ""}`,
      onClick: () => setFourCharCode("Master Code", masterCode, setMasterCode)
    },
    {
      label: `${t("adultCode")}${adultCode ? ` (${t("set")})` : ""}`,
      onClick: () => setFourCharCode("Adult Code", adultCode, setAdultCode)
    },
    {
      label: `${t("childCode")}${childCode ? ` (${t("set")})` : ""}`,
      onClick: () => setFourCharCode("Child Code", childCode, setChildCode)
    },
    {
      label: lightMode ? t("darkMode") : t("lightMode"),
      onClick: () => setLightMode((current) => !current)
    },
    {
      label: `${t("buffer")}: ${bufferLevel === "off" ? t("off") : bufferLevel === "low" ? `${t("low")} (10s)` : bufferLevel === "medium" ? `${t("medium")} (30s)` : `${t("high")} (60s)`}`,
      onClick: cycleBufferLevel
    },
    {
      label: `${t("language")}: ${APP_LANGUAGES.find((option) => option.code === language)?.label || "English"}`,
      onClick: cycleLanguage
    },
    { label: t("exitSetup"), onClick: onExit }
  ];

  return (
    <div className="recording-setup-overlay">
      <div className="side-panel recording-setup-panel">
        <h2>{t("setupTitle")}</h2>

        <div className="recording-setup-grid">
          {setupButtons.map((button) => (
            <button
              key={button.label}
              className="btn-secondary recording-setup-btn"
              onClick={button.onClick}
            >
              {button.label}
            </button>
          ))}
        </div>

        <div className="recording-setup-version" aria-label={t("programVersion")}>
          {t("programVersion")}: v{appVersion}
        </div>
      </div>
    </div>
  );
}
