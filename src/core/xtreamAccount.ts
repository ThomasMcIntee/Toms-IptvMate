export type XtreamAccountInfo = {
  maxConnections: number | null;
  activeConnections: number | null;
  expDateMs: number | null;
  unlimited: boolean;
  status: string;
};

type PlaylistLike = {
  type?: string;
  data?: {
    url?: string;
    user?: string;
    pass?: string;
    account?: XtreamAccountInfo | null;
  };
};

export function parseXtreamAccountInfo(payload: unknown): XtreamAccountInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const userInfo = (payload as { user_info?: unknown }).user_info;
  if (!userInfo || typeof userInfo !== "object") return null;

  const info = userInfo as Record<string, unknown>;
  const maxConnections = coerceInt(info.max_connections ?? info.max_connection);
  const activeConnections = coerceInt(info.active_cons ?? info.active_connections);
  const { ms, unlimited } = parseExpDate(info.exp_date ?? info.expire_date ?? info.expDate);
  const status = String(info.status || "").trim();

  if (maxConnections == null && activeConnections == null && ms == null && !unlimited && !status) {
    return null;
  }

  return {
    maxConnections,
    activeConnections,
    expDateMs: ms,
    unlimited,
    status
  };
}

export function sanitizeXtreamAccount(value: unknown): XtreamAccountInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const info = value as Record<string, unknown>;
  const maxConnections = typeof info.maxConnections === "number" && Number.isFinite(info.maxConnections)
    ? info.maxConnections
    : null;
  const activeConnections =
    typeof info.activeConnections === "number" && Number.isFinite(info.activeConnections)
      ? info.activeConnections
      : null;
  const expDateMs =
    typeof info.expDateMs === "number" && Number.isFinite(info.expDateMs) ? info.expDateMs : null;
  const unlimited = info.unlimited === true;
  const status = typeof info.status === "string" ? info.status : "";
  if (maxConnections == null && activeConnections == null && expDateMs == null && !unlimited && !status) {
    return undefined;
  }
  return { maxConnections, activeConnections, expDateMs, unlimited, status };
}

export function formatXtreamAccountExpiry(info: XtreamAccountInfo): string | null {
  if (info.unlimited) return "Unlimited";
  if (info.expDateMs == null) return null;
  const date = new Date(info.expDateMs);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function isXtreamAccountExpired(info: XtreamAccountInfo): boolean {
  if (info.unlimited || info.expDateMs == null) return false;
  if (String(info.status || "").toLowerCase() === "expired") return true;
  return info.expDateMs < Date.now();
}

export function resolveXtreamApiCredentials(playlist: PlaylistLike | null | undefined): {
  url: string;
  user: string;
  pass: string;
} | null {
  if (!playlist) return null;
  const data = playlist.data || {};

  if (playlist.type === "xtream") {
    const url = String(data.url || "").trim();
    const user = String(data.user || "").trim();
    const pass = String(data.pass || "").trim();
    if (url && user && pass) return { url, user, pass };
    return null;
  }

  if (playlist.type === "m3u") {
    return parseXtreamCredentialsFromM3uUrl(String(data.url || ""));
  }

  return null;
}

export function parseXtreamCredentialsFromM3uUrl(rawUrl: string): { url: string; user: string; pass: string } | null {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    const user = String(parsed.searchParams.get("username") || "").trim();
    const pass = String(parsed.searchParams.get("password") || "").trim();
    const path = parsed.pathname.toLowerCase();
    const looksLikeXtream = /\/(get|player_api)\.php$/i.test(path) || path.includes("/get.php");
    if (!user || !pass || !looksLikeXtream) return null;
    return {
      url: `${parsed.protocol}//${parsed.host}`,
      user,
      pass
    };
  } catch {
    return null;
  }
}

function coerceInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseExpDate(raw: unknown): { ms: number | null; unlimited: boolean } {
  if (raw == null || raw === "" || raw === "null" || raw === "undefined") {
    return { ms: null, unlimited: true };
  }

  const asString = String(raw).trim().toLowerCase();
  if (
    asString === "0" ||
    asString === "null" ||
    asString === "unlimited" ||
    asString === "never" ||
    asString === "false"
  ) {
    return { ms: null, unlimited: true };
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw <= 0) return { ms: null, unlimited: true };
    return { ms: raw > 1e12 ? raw : raw * 1000, unlimited: false };
  }

  if (/^\d+$/.test(asString)) {
    const numeric = Number.parseInt(asString, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) return { ms: null, unlimited: true };
    return { ms: numeric > 1e12 ? numeric : numeric * 1000, unlimited: false };
  }

  const parsed = Date.parse(String(raw));
  if (Number.isFinite(parsed)) return { ms: parsed, unlimited: false };
  return { ms: null, unlimited: false };
}
