const SERVICE_URI = "luna://tv.toms.iptvmate.relay";
const START_TIMEOUT_MS = 4000;
const DOWNLOAD_TIMEOUT_MS = 20000;
const DOWNLOAD_URIS = [
  "luna://com.webos.service.downloadmanager",
  "luna://com.palm.downloadmanager"
];

type LunaResponse = {
  returnValue?: boolean;
  origin?: string;
  port?: number;
  errorText?: string;
  errorCode?: number | string;
  completed?: boolean;
  interrupted?: boolean;
  ticket?: number | string;
  destFile?: string;
  destPath?: string;
  destination?: string;
  destinationPath?: string;
  fullPath?: string;
  target?: string;
  url?: string;
  sourceUrl?: string;
};

type WebOsServiceBridge = {
  service?: {
    request: (
      uri: string,
      options: {
        method: string;
        parameters: Record<string, unknown>;
        subscribe?: boolean;
        onSuccess?: (res: LunaResponse) => void;
        onFailure?: (res: LunaResponse) => void;
      }
    ) => { cancel?: () => void } | unknown;
  };
};

type PalmServiceBridgeCtor = new () => {
  onservicecallback: ((msg: string) => void) | null;
  call: (uri: string, params: string) => void;
  cancel?: () => void;
};

let cachedOrigin: string | null = null;
let startPromise: Promise<string | null> | null = null;
let jsServiceMissing = false;

function debugLog(message: string): void {
  const log = (window as { webosDebugLog?: (msg: string) => void }).webosDebugLog;
  if (log) log(message);
  console.log(`[webos-relay] ${message}`);
}

function getLunaService(): NonNullable<WebOsServiceBridge["service"]> | null {
  if (typeof window === "undefined") return null;
  const webos = (window as Window & { webOS?: WebOsServiceBridge }).webOS;
  if (webos?.service && typeof webos.service.request === "function") {
    return webos.service;
  }
  return null;
}

function getPalmBridge(): PalmServiceBridgeCtor | null {
  if (typeof window === "undefined") return null;
  const Bridge = (window as Window & { PalmServiceBridge?: PalmServiceBridgeCtor }).PalmServiceBridge;
  return typeof Bridge === "function" ? Bridge : null;
}

export function isWebOsRelayUrl(url: string): boolean {
  return /^http:\/\/127\.0\.0\.1:\d+\/\?u=/i.test(url);
}

export function isWebOsRelayUnavailable(): boolean {
  return jsServiceMissing;
}

export function toWebOsRelayUrl(origin: string, targetUrl: string): string {
  if (isWebOsRelayUrl(targetUrl)) return targetUrl;
  return `${origin.replace(/\/$/, "")}/?u=${encodeURIComponent(targetUrl)}`;
}

function originFromResponse(res: LunaResponse | null | undefined): string | null {
  const origin = String(res?.origin || "").replace(/\/$/, "");
  if (res?.returnValue && /^http:\/\/127\.0\.0\.1:\d+$/i.test(origin)) return origin;
  return null;
}

function summarizeLuna(res: LunaResponse | null | undefined): string {
  return String(res?.errorText || res?.errorCode || JSON.stringify(res || {})).substring(0, 140);
}

function lunaStartViaWebOsService(): Promise<string | null> {
  const service = getLunaService();
  if (!service) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(value);
    };
    const timeout = window.setTimeout(() => finish(null), START_TIMEOUT_MS);
    try {
      service.request(SERVICE_URI, {
        method: "start",
        parameters: {},
        onSuccess: (res) => finish(originFromResponse(res)),
        onFailure: (res) => {
          debugLog(`PLAYER: relay webOS.service failed ${summarizeLuna(res)}`);
          finish(null);
        }
      });
    } catch (err) {
      debugLog(`PLAYER: relay webOS.service threw ${err instanceof Error ? err.message : "error"}`);
      finish(null);
    }
  });
}

function lunaStartViaPalmBridge(): Promise<string | null> {
  const Bridge = getPalmBridge();
  if (!Bridge) {
    debugLog("PLAYER: PalmServiceBridge missing");
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    let bridge: InstanceType<PalmServiceBridgeCtor>;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      try {
        bridge.cancel?.();
      } catch {
        // ignore
      }
      resolve(value);
    };
    const timeout = window.setTimeout(() => {
      debugLog("PLAYER: relay PalmServiceBridge timed out");
      finish(null);
    }, START_TIMEOUT_MS);

    try {
      bridge = new Bridge();
    } catch (err) {
      debugLog(`PLAYER: PalmServiceBridge construct failed ${err instanceof Error ? err.message : "error"}`);
      finish(null);
      return;
    }

    bridge.onservicecallback = (msg) => {
      let res: LunaResponse = {};
      try {
        res = typeof msg === "string" ? JSON.parse(msg) : (msg as LunaResponse) || {};
      } catch {
        debugLog(`PLAYER: relay luna parse failed ${String(msg).substring(0, 80)}`);
        finish(null);
        return;
      }
      const origin = originFromResponse(res);
      if (origin) {
        finish(origin);
        return;
      }
      debugLog(`PLAYER: relay luna rejected ${summarizeLuna(res)}`);
      finish(null);
    };

    try {
      bridge.call(`${SERVICE_URI}/start`, "{}");
    } catch (err) {
      debugLog(`PLAYER: relay luna call threw ${err instanceof Error ? err.message : "error"}`);
      finish(null);
    }
  });
}

async function lunaStart(): Promise<string | null> {
  debugLog(
    `PLAYER: starting local relay webOS.service=${!!getLunaService()} PalmServiceBridge=${!!getPalmBridge()}`
  );
  const viaSdk = await lunaStartViaWebOsService();
  if (viaSdk) return viaSdk;
  return lunaStartViaPalmBridge();
}

function lunaFetchViaService(url: string): Promise<WebOsRemoteFetchResult | null> {
  const service = getLunaService();
  if (service) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: WebOsRemoteFetchResult | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(value);
      };
      const timeout = window.setTimeout(() => finish(null), DOWNLOAD_TIMEOUT_MS);
      try {
        service.request(SERVICE_URI, {
          method: "fetch",
          parameters: { url },
          onSuccess: (res) => {
            const body = String((res as LunaResponse & { body?: string }).body || "");
            if (res?.returnValue && body) {
              debugLog(`FETCH: luna-service ${body.length}b`);
              finish({ ok: true, status: Number(res.errorCode || 200) || 200, url, text: body });
              return;
            }
            debugLog(`FETCH: luna-service empty ${summarizeLuna(res)}`);
            finish(null);
          },
          onFailure: (res) => {
            debugLog(`FETCH: luna-service failed ${summarizeLuna(res)}`);
            finish(null);
          }
        });
      } catch (err) {
        debugLog(`FETCH: luna-service threw ${err instanceof Error ? err.message : "error"}`);
        finish(null);
      }
    });
  }

  const Bridge = getPalmBridge();
  if (!Bridge) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let bridge: InstanceType<PalmServiceBridgeCtor>;
    const finish = (value: WebOsRemoteFetchResult | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      try {
        bridge.cancel?.();
      } catch {
        // ignore
      }
      resolve(value);
    };
    const timeout = window.setTimeout(() => finish(null), DOWNLOAD_TIMEOUT_MS);
    try {
      bridge = new Bridge();
    } catch {
      finish(null);
      return;
    }
    bridge.onservicecallback = (msg) => {
      let res: LunaResponse & { body?: string } = {};
      try {
        res = typeof msg === "string" ? JSON.parse(msg) : (msg as LunaResponse) || {};
      } catch {
        finish(null);
        return;
      }
      const body = String(res.body || "");
      if (res.returnValue && body) {
        debugLog(`FETCH: luna-bridge ${body.length}b`);
        finish({ ok: true, status: 200, url, text: body });
        return;
      }
      debugLog(`FETCH: luna-bridge rejected ${summarizeLuna(res)}`);
      finish(null);
    };
    try {
      bridge.call(`${SERVICE_URI}/fetch`, JSON.stringify({ url }));
    } catch {
      finish(null);
    }
  });
}

export function ensureWebOsStreamRelay(): Promise<string | null> {
  if (cachedOrigin) return Promise.resolve(cachedOrigin);
  if (jsServiceMissing) return Promise.resolve(null);
  if (!startPromise) {
    startPromise = lunaStart().then((origin) => {
      cachedOrigin = origin;
      startPromise = null;
      if (origin) debugLog(`PLAYER: local relay ${origin}`);
      else {
        jsServiceMissing = true;
        debugLog("PLAYER: local JS service missing; using system downloader");
      }
      return origin;
    });
  }
  return startPromise;
}

function completedFilePath(res: LunaResponse): string | null {
  const candidates = [
    res.fullPath,
    res.destinationPath,
    res.destination,
    res.destPath && res.destFile ? `${String(res.destPath).replace(/\/$/, "")}/${res.destFile}` : "",
    res.destFile,
    res.target
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value.startsWith("/") || value.startsWith("file:")) return value;
  }
  return null;
}

function readLocalFile(path: string, asText: boolean): Promise<string | ArrayBuffer> {
  const fileUrl = path.startsWith("file:") ? path : `file://${path}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", fileUrl, true);
    xhr.responseType = asText ? "text" : "arraybuffer";
    xhr.onload = () => {
      if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
        resolve(xhr.response);
        return;
      }
      reject(new Error(`local read HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("local read failed"));
    xhr.ontimeout = () => reject(new Error("local read timeout"));
    xhr.timeout = DOWNLOAD_TIMEOUT_MS;
    xhr.send();
  });
}

function downloadViaUri(serviceUri: string, url: string): Promise<LunaResponse> {
  const service = getLunaService();
  const filename = `iptvmate-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const parameters: Record<string, unknown> = {
    target: url,
    subscribe: true,
    targetFilename: filename
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, res?: LunaResponse) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      try {
        handle?.cancel?.();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(res || {});
    };
    const timeout = window.setTimeout(() => finish(new Error("download timeout")), DOWNLOAD_TIMEOUT_MS);

    if (!service) {
      finish(new Error("webOS.service missing"));
      return;
    }

    let handle: { cancel?: () => void } | null = null;
    try {
      handle = service.request(serviceUri, {
        method: "download",
        parameters,
        subscribe: true,
        onSuccess: (res) => {
          if (res?.interrupted) {
            finish(new Error(`download interrupted ${summarizeLuna(res)}`));
            return;
          }
          if (res?.completed || completedFilePath(res)) {
            finish(null, res);
          }
        },
        onFailure: (res) => finish(new Error(summarizeLuna(res)))
      }) as { cancel?: () => void };
    } catch (err) {
      finish(err instanceof Error ? err : new Error("download threw"));
    }
  });
}

const XHR_TIMEOUT_MS = 18000;
const WEBOS_PC_RELAY_ORIGIN_KEY = "iptvmate_webos_relay_origin";

function rewriteHttpsToHttp(url: string): string {
  return String(url || "").replace(/^https:\/\//i, "http://");
}

function targetCandidates(url: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string) => {
    const next = String(value || "").trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
    out.push(next);
  };
  // HTTP first: old webOS TLS often hangs on https:// instead of failing fast.
  push(rewriteHttpsToHttp(url));
  push(url);
  return out;
}

function pcRelayOrigins(): string[] {
  if (typeof window === "undefined") return [];
  const found: string[] = [];
  const push = (value: string | null | undefined) => {
    const origin = String(value || "").trim().replace(/\/$/, "");
    if (/^https?:\/\//i.test(origin) && !found.includes(origin)) found.push(origin);
  };
  try {
    push(window.localStorage.getItem(WEBOS_PC_RELAY_ORIGIN_KEY));
  } catch {
    // Ignore storage errors.
  }
  const scoped = window as Window & { __IPTV_RELAY_ORIGIN__?: string; __IPTV_RELAY_CANDIDATES__?: string[] };
  push(scoped.__IPTV_RELAY_ORIGIN__);
  if (Array.isArray(scoped.__IPTV_RELAY_CANDIDATES__)) {
    scoped.__IPTV_RELAY_CANDIDATES__.forEach(push);
  }
  return found;
}

function xhrGetText(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "text";
      xhr.timeout = XHR_TIMEOUT_MS;
      xhr.onload = () => {
        resolve({ status: Number(xhr.status || 0), text: String(xhr.responseText || "") });
      };
      xhr.onerror = () => reject(new Error("xhr network error"));
      xhr.ontimeout = () => reject(new Error("xhr timeout"));
      xhr.send();
    } catch (err) {
      reject(err instanceof Error ? err : new Error("xhr threw"));
    }
  });
}

async function tryTextUrl(
  fetchUrl: string,
  sourceUrl: string,
  label: string
): Promise<WebOsRemoteFetchResult | null> {
  try {
    const res = await xhrGetText(fetchUrl);
    if (res.status >= 200 && res.status < 300 && res.text) {
      debugLog(`FETCH: ${label} ${res.status} ${sourceUrl.substring(0, 80)}`);
      return { ok: true, status: res.status, url: sourceUrl, text: res.text };
    }
    debugLog(`FETCH: ${label} HTTP ${res.status || 0}`);
  } catch (err) {
    debugLog(`FETCH: ${label} fail ${String((err as Error)?.message || err).substring(0, 80)}`);
  }

  try {
    const res = await fetch(fetchUrl);
    if (res.ok) {
      const text = await res.text();
      if (text) {
        debugLog(`FETCH: ${label}-fetch ${res.status} ${sourceUrl.substring(0, 80)}`);
        return { ok: true, status: res.status, url: sourceUrl, text };
      }
    }
    debugLog(`FETCH: ${label}-fetch HTTP ${res.status}`);
  } catch (err) {
    debugLog(`FETCH: ${label}-fetch fail ${String((err as Error)?.message || err).substring(0, 80)}`);
  }

  return null;
}

export type WebOsRemoteFetchResult = {
  ok: true;
  status: number;
  url: string;
  text: string;
};

export async function fetchWebOsRemote(url: string): Promise<WebOsRemoteFetchResult | null> {
  const candidates = targetCandidates(url);
  debugLog(`FETCH: start ${candidates[0]?.substring(0, 80) || url.substring(0, 80)}`);

  for (const candidate of candidates) {
    const direct = await tryTextUrl(candidate, candidate, "direct");
    if (direct) return direct;
  }

  const origin = await ensureWebOsStreamRelay();
  if (origin) {
    for (const candidate of candidates) {
      const relayed = await tryTextUrl(toWebOsRelayUrl(origin, candidate), candidate, "relay");
      if (relayed) return relayed;
    }
  }

  for (const candidate of candidates) {
    const viaLunaFetch = await lunaFetchViaService(candidate);
    if (viaLunaFetch) return viaLunaFetch;
  }

  for (const pcOrigin of pcRelayOrigins()) {
    for (const candidate of candidates) {
      const pcUrl = `${pcOrigin}/__stream?url=${encodeURIComponent(candidate)}`;
      const viaPc = await tryTextUrl(pcUrl, candidate, `pc ${pcOrigin}`);
      if (viaPc) return viaPc;
    }
  }

  for (const candidate of candidates) {
    try {
      const luna = await fetchWebOsViaLuna(candidate, true);
      const text = String(luna.data || "");
      if (text) {
        debugLog(`FETCH: luna ok ${candidate.substring(0, 80)}`);
        return { ok: true, status: 200, url: luna.finalUrl || candidate, text };
      }
    } catch (err) {
      debugLog(`FETCH: luna fail ${String((err as Error)?.message || err).substring(0, 80)}`);
    }
  }

  debugLog("FETCH: all methods failed");
  return null;
}

export async function fetchWebOsRemoteJson(url: string): Promise<unknown | null> {
  const result = await fetchWebOsRemote(url);
  if (!result?.text) return null;
  try {
    return JSON.parse(result.text);
  } catch {
    debugLog("FETCH: JSON parse failed");
    return null;
  }
}

export async function fetchWebOsViaLuna(
  url: string,
  asText: boolean
): Promise<{ finalUrl: string; data: string | ArrayBuffer }> {
  let lastError: Error | null = null;
  for (const serviceUri of DOWNLOAD_URIS) {
    try {
      debugLog(`PLAYER: luna download via ${serviceUri.replace("luna://", "")}`);
      const res = await downloadViaUri(serviceUri, url);
      const path = completedFilePath(res);
      if (!path) throw new Error(`no dest path ${summarizeLuna(res)}`);
      debugLog(`PLAYER: luna downloaded ${path.substring(0, 80)}`);
      const data = await readLocalFile(path, asText);
      const finalUrl = String(res.sourceUrl || res.url || url);
      if (asText) {
        let text = String(data);
        if (/#EXTM3U/i.test(text)) text = text.replace(/https:\/\//gi, "http://");
        return { finalUrl, data: text };
      }
      return { finalUrl, data };
    } catch (err) {
      lastError = err as Error;
      debugLog(`PLAYER: luna download failed ${String((err as Error).message || err).substring(0, 100)}`);
    }
  }
  throw lastError || new Error("luna download failed");
}
