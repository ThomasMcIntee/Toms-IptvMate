import { useEffect, useState } from "react";

type Props = {
  visible: boolean;
  onOpenPlayback: () => void;
  onOpenStorage: () => void;
};

export default function RecordingLibrary({ visible, onOpenPlayback, onOpenStorage }: Props) {
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

  if (!visible) return null;

  const setupButtons = [
    {
      label: loginRequired ? "Login Required" : "Enable Login",
      onClick: () => setLoginRequired((current) => !current)
    },
    {
      label: `Master Code${masterCode ? " (Set)" : ""}`,
      onClick: () => setFourCharCode("Master Code", masterCode, setMasterCode)
    },
    {
      label: `Adult Code${adultCode ? " (Set)" : ""}`,
      onClick: () => setFourCharCode("Adult Code", adultCode, setAdultCode)
    },
    {
      label: `Child Code${childCode ? " (Set)" : ""}`,
      onClick: () => setFourCharCode("Child Code", childCode, setChildCode)
    },
    {
      label: lightMode ? "Dark Mode" : "Light Mode",
      onClick: () => setLightMode((current) => !current)
    },
    { label: "Buffer", onClick: () => {} }
  ];

  return (
    <div className="recording-setup-overlay">
      <div className="side-panel recording-setup-panel">
        <h2>Recording Setup</h2>

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
      </div>
    </div>
  );
}
