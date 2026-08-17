// webOS Luna DB8 key/value storage.
//
// LG TVs purge per-app web storage (localStorage/IndexedDB) on some firmware
// builds when the app process is fully closed or the TV power-cycles, and
// document.cookie is a no-op on the file:// origin packaged apps run from.
// DB8 (luna://com.webos.service.db) lives outside the web-app storage
// partition, so records survive those purges. Values are stored as JSON
// strings under a string key in a single app-owned kind.

const DB_KIND = "tv.toms.iptvmate.store:1";
const DB_OWNER = "tv.toms.iptvmate";
const LUNA_DB_URI = "luna://com.webos.service.db";
const CALL_TIMEOUT_MS = 4000;

type LunaResponse = {
  returnValue?: boolean;
  results?: Array<{ key?: string; value?: string }>;
  errorText?: string;
  errorCode?: number;
};

type WebOsServiceBridge = {
  service?: {
    request: (
      uri: string,
      options: {
        method: string;
        parameters: Record<string, unknown>;
        onSuccess?: (res: LunaResponse) => void;
        onFailure?: (res: LunaResponse) => void;
      }
    ) => unknown;
  };
};

function debugLog(message: string): void {
  const log = (window as any).webosDebugLog;
  if (log) log(message);
}

function getLunaService(): NonNullable<WebOsServiceBridge["service"]> | null {
  if (typeof window === "undefined") return null;
  const webos = (window as Window & { webOS?: WebOsServiceBridge }).webOS;
  if (webos?.service && typeof webos.service.request === "function") {
    return webos.service;
  }
  return null;
}

// Once DB8 proves broken on this TV (permission denial, timeouts), stop
// calling it for the rest of the session — every failed call otherwise costs
// multi-second timeouts that make playlist loads crawl.
let dbMarkedBroken = false;
let lastDbActivity = "untested";

export function isWebOsDbAvailable(): boolean {
  return !dbMarkedBroken && getLunaService() !== null;
}

// Small write/read roundtrip for the Setup screen's status line.
export async function webosDbSelfTest(): Promise<string> {
  if (typeof window === "undefined") return "no window";
  if (!getLunaService()) return "webOS service API not present";
  if (dbMarkedBroken) return `disabled (${lastDbActivity})`;

  const stamp = String(Date.now() % 1000000);
  const wrote = await webosDbSet("iptvmate_diag", stamp);
  if (!wrote) return `write failed (${lastDbActivity})`;
  const read = await webosDbGet("iptvmate_diag");
  if (read === stamp) return "working";
  return `read mismatch (${read === null ? "null" : "stale value"})`;
}

function lunaCall(method: string, parameters: Record<string, unknown>): Promise<LunaResponse | null> {
  const service = getLunaService();
  if (!service) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: LunaResponse | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(value);
    };

    const timeout = window.setTimeout(() => {
      lastDbActivity = `${method} timed out`;
      finish(null);
    }, CALL_TIMEOUT_MS);

    try {
      service.request(LUNA_DB_URI, {
        method,
        parameters,
        onSuccess: (res) => {
          lastDbActivity = `${method} ok`;
          finish(res || {});
        },
        onFailure: (res) => {
          lastDbActivity = `${method} failed: ${res?.errorText || res?.errorCode || "unknown"}`;
          debugLog(`db8 ${lastDbActivity}`);
          finish(null);
        }
      });
    } catch (err) {
      lastDbActivity = `${method} threw: ${err instanceof Error ? err.message : "error"}`;
      debugLog(`db8 ${lastDbActivity}`);
      finish(null);
    }
  });
}

let kindEnsured: Promise<boolean> | null = null;

function ensureKind(): Promise<boolean> {
  if (!kindEnsured) {
    kindEnsured = (async () => {
      const res = await lunaCall("putKind", {
        id: DB_KIND,
        owner: DB_OWNER,
        indexes: [{ name: "key", props: [{ name: "key" }] }]
      });
      if (res === null) {
        // No response at all (denied service or bus timeout): disable DB8 for
        // this session so nothing else waits on dead calls.
        dbMarkedBroken = true;
        debugLog("db8 disabled for session: putKind got no response");
        return false;
      }
      return true;
    })();
  }
  return kindEnsured;
}

export async function webosDbSet(key: string, value: string): Promise<boolean> {
  if (!isWebOsDbAvailable()) return false;
  if (!(await ensureKind())) return false;

  // Replace any previous record for this key, then insert the new one.
  await lunaCall("del", {
    query: {
      from: DB_KIND,
      where: [{ prop: "key", op: "=", val: key }]
    },
    purge: true
  });

  const res = await lunaCall("put", {
    objects: [{ _kind: DB_KIND, key, value }]
  });

  const ok = !!res && res.returnValue !== false;
  debugLog(`db8 set "${key}": ${ok ? "ok" : "FAILED"} (${value.length} chars)`);
  return ok;
}

export async function webosDbGet(key: string): Promise<string | null> {
  if (!isWebOsDbAvailable()) return null;
  if (!(await ensureKind())) return null;

  const res = await lunaCall("find", {
    query: {
      from: DB_KIND,
      where: [{ prop: "key", op: "=", val: key }]
    }
  });

  if (!res || res.returnValue === false || !Array.isArray(res.results)) {
    debugLog(`db8 get "${key}": no response`);
    return null;
  }

  const record = res.results.find((item) => item && item.key === key);
  const value = typeof record?.value === "string" ? record.value : null;
  debugLog(`db8 get "${key}": ${value === null ? "empty" : `${value.length} chars`}`);
  return value;
}

// Large values (e.g. the cached channel list) are split into chunk records so
// each Luna bus message stays well under the service payload limits.
const LARGE_CHUNK_SIZE = 200_000;
const LARGE_MAX_LENGTH = 4_000_000;

type ChunkRecord = { key?: string; seq?: number; value?: string };

export async function webosDbSetLarge(key: string, value: string): Promise<boolean> {
  if (!isWebOsDbAvailable()) return false;
  if (value.length > LARGE_MAX_LENGTH) {
    debugLog(`db8 setLarge "${key}": skipped, ${value.length} chars exceeds cap`);
    return false;
  }
  if (!(await ensureKind())) return false;

  // Drop all previous chunks for this key (prefix match covers meta too).
  await lunaCall("del", {
    query: {
      from: DB_KIND,
      where: [{ prop: "key", op: "%", val: `${key}#` }]
    },
    purge: true
  });

  const chunkCount = Math.max(1, Math.ceil(value.length / LARGE_CHUNK_SIZE));
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = value.slice(index * LARGE_CHUNK_SIZE, (index + 1) * LARGE_CHUNK_SIZE);
    const res = await lunaCall("put", {
      objects: [{ _kind: DB_KIND, key: `${key}#${index}`, seq: index, value: chunk }]
    });
    if (!res || res.returnValue === false) {
      debugLog(`db8 setLarge "${key}": chunk ${index}/${chunkCount} FAILED`);
      return false;
    }
  }

  const metaRes = await lunaCall("put", {
    objects: [{ _kind: DB_KIND, key: `${key}#meta`, value: String(chunkCount) }]
  });
  const ok = !!metaRes && metaRes.returnValue !== false;
  debugLog(`db8 setLarge "${key}": ${ok ? "ok" : "FAILED"} (${value.length} chars, ${chunkCount} chunks)`);
  return ok;
}

export async function webosDbGetLarge(key: string): Promise<string | null> {
  if (!isWebOsDbAvailable()) return null;
  if (!(await ensureKind())) return null;

  const res = await lunaCall("find", {
    query: {
      from: DB_KIND,
      where: [{ prop: "key", op: "%", val: `${key}#` }],
      limit: 500
    }
  });

  if (!res || res.returnValue === false || !Array.isArray(res.results) || res.results.length === 0) {
    debugLog(`db8 getLarge "${key}": empty`);
    return null;
  }

  const records = res.results as ChunkRecord[];
  const meta = records.find((item) => item?.key === `${key}#meta`);
  const expected = Number(meta?.value || 0);
  const chunks = records
    .filter((item) => item?.key !== `${key}#meta` && typeof item?.value === "string")
    .sort((a, b) => {
      const seqA = typeof a.seq === "number" ? a.seq : Number(String(a.key || "").split("#")[1] || 0);
      const seqB = typeof b.seq === "number" ? b.seq : Number(String(b.key || "").split("#")[1] || 0);
      return seqA - seqB;
    });

  if (!expected || chunks.length !== expected) {
    debugLog(`db8 getLarge "${key}": incomplete (${chunks.length}/${expected || "?"} chunks)`);
    return null;
  }

  const value = chunks.map((item) => item.value).join("");
  debugLog(`db8 getLarge "${key}": ${value.length} chars from ${chunks.length} chunks`);
  return value;
}
