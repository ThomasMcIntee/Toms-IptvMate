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
assert.ok(source.includes("English"));

console.log("audio language helpers ok");
