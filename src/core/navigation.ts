export function initNavigation(setPanel: (p: string | null) => void) {
  window.addEventListener("keydown", (e) => {
    if (isTextEntryActive(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;

    if (e.key === "v" || e.key === "V") setPanel("vod");
    if (e.key === "a" || e.key === "A") setPanel("audio");
    if (e.key === "s" || e.key === "S") setPanel("subtitles");
    if (e.key === "n" || e.key === "N") setPanel("notifications");
    if (e.key === "h" || e.key === "H") setPanel("smarthome");
    if (e.key === "o" || e.key === "O") setPanel("offline");
    if (e.key === "Backspace") setPanel(null);
    if (e.key === "b" || e.key === "B") setPanel("recordingPlayback");
    if (e.key === "p" || e.key === "P") setPanel("playlist");
    if (e.key === "f" || e.key === "F") setPanel("epgSearch");
    if (e.key === "c" || e.key === "C") setPanel("recordingStorage");
    if (e.key === "l" || e.key === "L") setPanel("recordings");
    if (e.key === "m" || e.key === "M") setPanel("playlistManager");
    if (e.key === "r" || e.key === "R") {
    const event = new CustomEvent("refreshEPG");
    window.dispatchEvent(event);
}
 if (e.key === "t" || e.key === "T") setPanel("timeline");
    if (e.key === "i" || e.key === "I") {
    const event = new CustomEvent("showNowNext");
     window.dispatchEvent(event);
}
  });
}

function isTextEntryActive(target: EventTarget | null): boolean {
  const active = (target instanceof HTMLElement ? target : document.activeElement) as HTMLElement | null;
  if (!active) return false;
  if (active.isContentEditable) return true;
  const tag = active.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
