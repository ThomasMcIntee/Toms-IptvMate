/**
 * Leave the app on webOS / the SDK simulator.
 * Back is fully intercepted (disableBackHistoryAPI + webOSTV stub), so the
 * shell will not close us unless we call PalmSystem.platformBack().
 */

const WEBOS_APP_ID = "tv.toms.iptvmate";

function lunaClose(method: "close" | "closeByAppId"): boolean {
  const request = (window as Window & {
    webOS?: { service?: { request?: (uri: string, options: Record<string, unknown>) => void } };
  }).webOS?.service?.request;
  if (typeof request !== "function") return false;
  try {
    request("luna://com.webos.applicationManager", {
      method,
      parameters: { id: WEBOS_APP_ID },
      onFailure: () => undefined
    });
    return true;
  } catch {
    return false;
  }
}

export function exitWebOsApp(): void {
  const scoped = window as Window & {
    webOS?: { platformBack?: () => unknown };
    PalmSystem?: { platformBack?: () => unknown };
  };

  try {
    if (typeof scoped.webOS?.platformBack === "function") {
      scoped.webOS.platformBack();
      return;
    }
  } catch {
    // Keep trying other exit paths.
  }

  try {
    if (typeof scoped.PalmSystem?.platformBack === "function") {
      scoped.PalmSystem.platformBack();
      return;
    }
  } catch {
    // Keep trying other exit paths.
  }

  if (lunaClose("close") || lunaClose("closeByAppId")) {
    return;
  }

  try {
    window.close();
  } catch {
    // Simulator/TV may ignore window.close().
  }
}
