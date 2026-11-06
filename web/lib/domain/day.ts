// The household day (DESIGN §4.3): it starts at `config.day.startHour` (04:00) in HOUSEHOLD_TZ,
// so bedtime practice after midnight still counts for the evening before. DST-safe.
import { config } from "../config";

export interface DayOptions {
  timeZone: string;
  startHour?: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of `ms` in `timeZone`. */
export function localParts(ms: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Offset of `timeZone` from UTC at instant `ms`, in ms (local − UTC). */
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (ms % 1000));
}

/** The instant at which the wall clock in `timeZone` reads y-m-d h:00 (month 1-based). */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  let t = wall - offsetAt(wall, timeZone);
  t = wall - offsetAt(t, timeZone);
  return t;
}

/** The calendar date the household day containing `now` is named after. */
function householdDate(
  now: number,
  opts: DayOptions,
): { year: number; month: number; day: number } {
  const startHour = opts.startHour ?? config.day.startHour;
  const p = localParts(now, opts.timeZone);
  if (p.hour >= startHour) return p;
  const prev = new Date(Date.UTC(p.year, p.month - 1, p.day - 1));
  return { year: prev.getUTCFullYear(), month: prev.getUTCMonth() + 1, day: prev.getUTCDate() };
}

/** Start of the household day containing `now`. */
export function dayStart(now: number, opts: DayOptions): number {
  const d = householdDate(now, opts);
  return zonedTime(d.year, d.month, d.day, opts.startHour ?? config.day.startHour, opts.timeZone);
}

/** Start of the next household day after the one containing `now`. */
export function nextDayStart(now: number, opts: DayOptions): number {
  const d = householdDate(now, opts);
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return zonedTime(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    opts.startHour ?? config.day.startHour,
    opts.timeZone,
  );
}

/** `YYYY-MM-DD` naming the household day containing `now`. */
export function dayKey(now: number, opts: DayOptions): string {
  const d = householdDate(now, opts);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}
