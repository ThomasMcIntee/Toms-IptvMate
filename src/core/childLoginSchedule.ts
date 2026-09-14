export type ChildScheduleDays = "all" | "weekdays" | "weekends";

export type ChildLoginSchedule = {
  enabled: boolean;
  startMinutes: number;
  endMinutes: number;
  days: ChildScheduleDays;
};

export const CHILD_SCHEDULE_COUNT = 2;
const STORAGE_KEY = "iptvmate_setup_child_schedules";
const MINUTES_PER_DAY = 24 * 60;

const DEFAULT_SCHEDULES: ChildLoginSchedule[] = [
  { enabled: false, startMinutes: 15 * 60, endMinutes: 20 * 60, days: "weekdays" },
  { enabled: false, startMinutes: 8 * 60, endMinutes: 21 * 60, days: "weekends" }
];

const DAY_NAMES: Record<ChildScheduleDays, string> = {
  all: "every day",
  weekdays: "weekdays",
  weekends: "weekends"
};

function wrapMinutes(value: number): number {
  return ((Math.round(value) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function isScheduleDays(value: unknown): value is ChildScheduleDays {
  return value === "all" || value === "weekdays" || value === "weekends";
}

function normalizeSchedule(value: unknown, fallback: ChildLoginSchedule): ChildLoginSchedule {
  if (!value || typeof value !== "object") return { ...fallback };

  const raw = value as Partial<ChildLoginSchedule>;
  return {
    enabled: raw.enabled === true,
    startMinutes: wrapMinutes(typeof raw.startMinutes === "number" ? raw.startMinutes : fallback.startMinutes),
    endMinutes: wrapMinutes(typeof raw.endMinutes === "number" ? raw.endMinutes : fallback.endMinutes),
    days: isScheduleDays(raw.days) ? raw.days : fallback.days
  };
}

export function loadChildLoginSchedules(): ChildLoginSchedule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SCHEDULES.map((schedule) => ({ ...schedule }));

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SCHEDULES.map((schedule) => ({ ...schedule }));

    return DEFAULT_SCHEDULES.map((fallback, index) => normalizeSchedule(parsed[index], fallback));
  } catch {
    return DEFAULT_SCHEDULES.map((schedule) => ({ ...schedule }));
  }
}

export function saveChildLoginSchedules(schedules: ChildLoginSchedule[]): ChildLoginSchedule[] {
  const next = DEFAULT_SCHEDULES.map((fallback, index) => normalizeSchedule(schedules[index], fallback));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors in restricted environments.
  }
  return next;
}

export function formatMinutes(total: number): string {
  const minutes = wrapMinutes(total);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function addScheduleHours(total: number, delta: number): number {
  return wrapMinutes(total + delta * 60);
}

export function addScheduleMinutes(total: number, delta: number): number {
  return wrapMinutes(total + delta);
}

export function cycleScheduleDays(days: ChildScheduleDays): ChildScheduleDays {
  if (days === "all") return "weekdays";
  if (days === "weekdays") return "weekends";
  return "all";
}

function matchesScheduleDay(days: ChildScheduleDays, now: Date): boolean {
  const weekday = now.getDay();
  const isWeekend = weekday === 0 || weekday === 6;
  if (days === "weekdays") return !isWeekend;
  if (days === "weekends") return isWeekend;
  return true;
}

function isWithinScheduleTime(schedule: ChildLoginSchedule, now: Date): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const start = wrapMinutes(schedule.startMinutes);
  const end = wrapMinutes(schedule.endMinutes);

  if (start === end) return true;
  if (start < end) return current >= start && current <= end;
  return current >= start || current <= end;
}

export function isChildLoginAllowedNow(now = new Date()): boolean {
  const enabled = loadChildLoginSchedules().filter((schedule) => schedule.enabled);
  if (enabled.length === 0) return true;
  return enabled.some((schedule) => matchesScheduleDay(schedule.days, now) && isWithinScheduleTime(schedule, now));
}

export function formatChildScheduleSummary(
  schedule: ChildLoginSchedule,
  offLabel: string,
  daysLabel: (days: ChildScheduleDays) => string
): string {
  if (!schedule.enabled) return offLabel;
  return `${formatMinutes(schedule.startMinutes)}–${formatMinutes(schedule.endMinutes)} ${daysLabel(schedule.days)}`;
}

export function formatChildLoginWindows(): string {
  const enabled = loadChildLoginSchedules().filter((schedule) => schedule.enabled);
  if (enabled.length === 0) return "Allowed any time";
  const windows = enabled.map(
    (schedule) => `${DAY_NAMES[schedule.days]} ${formatMinutes(schedule.startMinutes)}–${formatMinutes(schedule.endMinutes)}`
  );
  return `Allowed: ${windows.join(", ")}`;
}
