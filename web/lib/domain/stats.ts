// The Stats page's measures (PRD §6, DESIGN §7), computed from rows the repo loads. Pure.
import { config } from "../config";
import { dayKey, dayStart, nextDayStart, type DayOptions } from "./day";
import { State } from "./state";

export interface Week {
  /** Start of its first household day (inclusive). */
  start: number;
  /** Start of the day after its last (exclusive). */
  end: number;
  /** `dayKey` of its first and last days. */
  firstDay: string;
  lastDay: string;
}

/**
 * The last `n` weeks of household days, newest first. Week 0 is the 7 days ending today, so
 * "this week" is always a whole week and never looks bad on a Monday.
 */
export function recentWeeks(now: number, opts: DayOptions, n: number = config.stats.weeks): Week[] {
  const weeks: Week[] = [];
  let end = nextDayStart(now, opts);
  for (let w = 0; w < n; w++) {
    let start = end;
    for (let d = 0; d < 7; d++) start = dayStart(start - 1, opts);
    weeks.push({
      start,
      end,
      firstDay: dayKey(start, opts),
      lastDay: dayKey(end - 1, opts),
    });
    end = start;
  }
  return weeks;
}

/** Habit: per week, the number of household days with a finished round. */
export function practiceDaysPerWeek(
  weeks: readonly Week[],
  roundsFinishedAt: readonly number[],
  opts: DayOptions,
): number[] {
  return weeks.map((w) => {
    const days = new Set<string>();
    for (const t of roundsFinishedAt) if (t >= w.start && t < w.end) days.add(dayKey(t, opts));
    return days.size;
  });
}

export interface Rate {
  /** Matching cases. */
  hits: number;
  /** All cases. */
  total: number;
  /** hits / total, or null with no cases. */
  rate: number | null;
}

export const rate = (hits: number, total: number): Rate => ({
  hits,
  total,
  rate: total ? hits / total : null,
});

export interface ReviewRow {
  rating: number;
  stateBefore: number;
  source: string;
}

/**
 * True retention: of the reviews Will graded on cards in the Review state (not learning steps,
 * not "Already know", not the automatic Again from asking again), the share that weren't Again.
 */
export function trueRetention(reviews: readonly ReviewRow[]): Rate {
  const graded = reviews.filter((r) => r.source === "session" && r.stateBefore === State.Review);
  return rate(graded.filter((r) => r.rating > 1).length, graded.length);
}

export interface AskedAgainEvent {
  /** The phrase's status before the import asked about it again. */
  status: string;
}

/** The forgetting signal: imports that asked again about a phrase he was already learning. */
export const askedAgainOnActive = (events: readonly AskedAgainEvent[]) =>
  events.filter((e) => e.status === "active").length;

export interface FirstSight {
  kind: string;
  usefulness: number | null;
  notUseful: boolean;
}

export interface NotUsefulRates {
  all: Rate;
  byKind: Record<string, Rate>;
  /** Keyed by the model's usefulness 1–5, or "manual" for hand-added phrases. */
  byUsefulness: Record<string, Rate>;
}

/**
 * Ranking quality: of the phrases shown for the first time (introduced, or dropped with
 * Not useful on first sight), the share marked Not useful.
 */
export function notUsefulRates(seen: readonly FirstSight[]): NotUsefulRates {
  const group = (key: (s: FirstSight) => string) => {
    const out: Record<string, Rate> = {};
    const keys = [...new Set(seen.map(key))].sort();
    for (const k of keys) {
      const g = seen.filter((s) => key(s) === k);
      out[k] = rate(g.filter((s) => s.notUseful).length, g.length);
    }
    return out;
  };
  return {
    all: rate(seen.filter((s) => s.notUseful).length, seen.length),
    byKind: group((s) => s.kind),
    byUsefulness: group((s) => (s.usefulness === null ? "manual" : String(s.usefulness))),
  };
}

export interface ExtractionEvent {
  items: number;
  dropped_not_verbatim: number;
}

/** Extraction quality: items the model returned that failed the verbatim check. */
export function extractionDropRate(events: readonly ExtractionEvent[]): Rate {
  let items = 0;
  let dropped = 0;
  for (const e of events) {
    items += Number(e.items) || 0;
    dropped += Number(e.dropped_not_verbatim) || 0;
  }
  return rate(dropped, items);
}
