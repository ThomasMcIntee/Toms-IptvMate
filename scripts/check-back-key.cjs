const assert = require("assert");
const fs = require("fs");
const path = require("path");

const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
const main = fs.readFileSync(
  path.join(__dirname, "../android/app/src/main/java/tv/toms/iptvmate/MainActivity.java"),
  "utf8"
);
const exo = fs.readFileSync(
  path.join(__dirname, "../android/app/src/main/java/tv/toms/iptvmate/ExoPlayerManager.java"),
  "utf8"
);

assert.ok(app.includes("nativeBackKey"));
assert.ok(app.includes("isWebOsKeyboardOpen"));
assert.ok(app.includes("handleBackNavigationRef"));
assert.ok(app.includes("isTextEntryTarget(activeField)"));
assert.ok(app.includes("isSeriesSearchComposerOpen"));
assert.ok(app.includes('key === "Return" && isWebOsRuntime()'));
assert.ok(!/key === "Return"\s*\|\|/.test(app));

assert.ok(main.includes("nativeBackKey"));
assert.ok(main.includes("handleNativeBack"));
assert.ok(main.includes("OnBackPressedCallback"));

assert.ok(exo.includes("hideControlsNowOnMain"));
assert.ok(exo.includes("controlsRevealed"));
assert.ok(exo.includes("closeLanguagePickerOnMain"));

console.log("back key helpers ok");
