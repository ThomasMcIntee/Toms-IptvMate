export function getEpgTimeOffsetMinutes(): number {
  return -120;
}

export function formatEpgTime(ts: number): string {
  const safeTs = Number(ts);
  if (!Number.isFinite(safeTs)) return "--:--";

  const adjusted = new Date(safeTs + getEpgTimeOffsetMinutes() * 60 * 1000);
  if (Number.isNaN(adjusted.getTime())) return "--:--";
  return adjusted.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
