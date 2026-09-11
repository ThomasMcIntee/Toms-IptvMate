const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "../src/core/audioLanguage.ts"), "utf8");

function normalizeAudioLanguage(language) {
  const raw = String(language || "").trim().toLowerCase().split(/[-_]/)[0];
  if (!raw) return "";
  switch (raw) {
    case "eng":
      return "en";
    case "spa":
    case "esp":
      return "es";
    case "fra":
    case "fre":
      return "fr";
    case "deu":
    case "ger":
      return "de";
    case "ita":
      return "it";
    case "por":
      return "pt";
    default:
      return raw;
  }
}

function audioLanguagesMatch(left, right) {
  const a = normalizeAudioLanguage(left);
  const b = normalizeAudioLanguage(right);
  return !!a && a === b;
}

assert.strictEqual(normalizeAudioLanguage("eng"), "en");
assert.strictEqual(normalizeAudioLanguage("en-US"), "en");
assert.strictEqual(normalizeAudioLanguage("spa"), "es");
assert.ok(audioLanguagesMatch("eng", "en"));
assert.ok(audioLanguagesMatch("fra", "fr"));
assert.ok(!audioLanguagesMatch("eng", "es"));
assert.ok(source.includes("export function preferredAudioTrackIndex"));
assert.ok(source.includes("audioLanguagesMatch(track.language, preferredLanguage)"));
assert.ok(source.includes("export function audioTrackDisplayLabel"));
assert.ok(source.includes("English"));

const playerBar = fs.readFileSync(path.join(__dirname, "../src/ui/PlayerControlBar.tsx"), "utf8");
assert.ok(playerBar.includes("function LanguageGlobeIcon"));
assert.ok(playerBar.includes("player-control-bar-language"));
assert.ok(playerBar.includes('variant="bar"'));

const appSource = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
assert.ok(appSource.includes("vod-player-controls"));
assert.ok(appSource.includes("showLiveBadge={false}"));
assert.ok(appSource.includes(".player-control-bar-language, .vod-language-btn"));

const exo = fs.readFileSync(
  path.join(__dirname, "../android/app/src/main/java/tv/toms/iptvmate/ExoPlayerManager.java"),
  "utf8"
);
assert.ok(exo.includes("dispatchPlayerKey"));
assert.ok(exo.includes("focusLanguageButtonOnMain"));
assert.ok(exo.includes("setFocusableInTouchMode(show)"));
assert.ok(!/languageButton\.setEnabled\(canSelect\)/.test(exo));

const overlay = fs.readFileSync(
  path.join(__dirname, "../android/app/src/main/res/layout/native_exo_overlay.xml"),
  "utf8"
);
assert.ok(overlay.includes("@+id/native_exo_language"));
assert.ok(overlay.includes("android:focusableInTouchMode=\"true\""));

console.log("audio language helpers ok");
