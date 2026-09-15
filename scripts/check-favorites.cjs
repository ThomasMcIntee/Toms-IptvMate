const assert = require("assert");
const fs = require("fs");
const path = require("path");

const store = fs.readFileSync(path.join(__dirname, "../src/core/channelStore.ts"), "utf8");
const platform = fs.readFileSync(
  path.join(__dirname, "../src/core/player/platformDetection.ts"),
  "utf8"
);
const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");

assert.ok(store.includes("FAVORITES_STORE"));
assert.ok(store.includes("persistFavoritesToIndexedDb"));
assert.ok(store.includes("hydrateFavoritesFromIndexedDb"));
assert.ok(store.includes("saveFavoriteEntriesToLocalStorage"));
assert.ok(store.includes("localStorage.removeItem(CHANNELS_CACHE_KEY)"));
assert.ok(store.includes("/__(?:stream|api|proxy|cors|transcode)/"));
assert.ok(store.includes("indexedDB.open(CHANNELS_CACHE_DB, 3)"));
assert.ok(store.includes("favoriteWriteGeneration"));
assert.ok(store.includes("Never replace in-memory stars"));
assert.ok(store.includes("lastFavoriteWriteById"));
assert.ok(store.includes("isVodFavoriteChannel"));
assert.ok(store.includes('contentType === "movie"'));
assert.ok(!/favoriteEntries\s*=\s*restored/.test(store));
assert.ok(app.includes("lastFavoriteToggleAtByIdRef"));
assert.ok(app.includes("nativeBackKey"));
assert.ok(app.includes("onToggleFavorite={() => toggleFavoriteChannel(currentChannel)}"));

assert.ok(!platform.includes("return isCap || isAndroidRuntime()"));
assert.ok(platform.includes("localhost:5173"));

function unwrapFavoriteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const inner = String(parsed.searchParams.get("url") || "").trim();
    if (!inner) return raw;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || "";
    const isLocalDevHost = host === "localhost" || host === "127.0.0.1" || host === "app";
    const isProxyPath = /\/__(?:stream|api|proxy|cors|transcode)/i.test(path);
    if (isLocalDevHost || isProxyPath) return inner;
  } catch {
    return raw;
  }
  return raw;
}

assert.strictEqual(
  unwrapFavoriteUrl("http://localhost:5173/__stream?url=http://provider.example/movie.mkv"),
  "http://provider.example/movie.mkv"
);
assert.strictEqual(unwrapFavoriteUrl("http://provider.example/movie.mkv"), "http://provider.example/movie.mkv");

function buildFavoriteKey(channel) {
  const id = String(channel.id || "").trim();
  const url = unwrapFavoriteUrl(String(channel.url || ""));
  return url ? `id:${id}|url:${url}` : `id:${id}`;
}

function isVodFavorite(channel) {
  return String(channel.contentType || "") === "movie" || /^movie_\d+/i.test(String(channel.id || ""));
}

function isFavoriteById(entries, channel) {
  const key = buildFavoriteKey(channel);
  if (entries.has(key)) return true;
  const id = String(channel.id || "").trim();
  if (isVodFavorite(channel)) {
    for (const entry of entries.values()) {
      if (entry.id === id) return true;
    }
  }
  return false;
}

const movieA = {
  id: "movie_10",
  contentType: "movie",
  url: "http://provider.example/movie/10.mkv",
  name: "Demo"
};
const movieAInOtherGroup = {
  ...movieA,
  group: "Movies: Action"
};
const movieAProxied = {
  ...movieA,
  url: "http://localhost:5173/__stream?url=http://provider.example/movie/10.mkv"
};

const entries = new Map();
const addKey = buildFavoriteKey(movieA);
entries.set(addKey, { key: addKey, id: movieA.id, url: unwrapFavoriteUrl(movieA.url) });
entries.set(`id:${movieA.id}`, { key: `id:${movieA.id}`, id: movieA.id, url: "" });

assert.ok(isFavoriteById(entries, movieA));
assert.ok(isFavoriteById(entries, movieAInOtherGroup));
assert.ok(isFavoriteById(entries, movieAProxied));
assert.ok(!isFavoriteById(entries, { id: "movie_11", contentType: "movie", url: movieA.url }));

console.log("favorites persist helpers ok");
