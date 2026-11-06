// The evening reminder (DESIGN §4.9). `GET /api/agent/nudge` is polled every 30 minutes in the
// evening; this decides whether to answer with text. Pure: the repo loads the state.
import { config, type NudgeConfig, type SessionConfig } from "../config";
import { dayKey, dayStart, localParts, type DayOptions } from "./day";
import type { Workload } from "./session";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;

export interface NudgeOptions extends DayOptions {
  nudge?: NudgeConfig;
  session?: SessionConfig;
}

/**
 * Local minutes after midnight of the household day containing `ms`: a round at 00:30 belongs to
 * the evening before (DESIGN §4.3), so it is 24:30 (1470), not 00:30.
 */
export function eveningMinutes(ms: number, opts: DayOptions): number {
  const p = localParts(ms, opts.timeZone);
  const startHour = opts.startHour ?? config.day.startHour;
  const m = p.hour * 60 + p.minute;
  return p.hour < startHour ? m + MINUTES_PER_DAY : m;
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The start time of each practice day's first finished round in the lookback window (the days
 * before today). Extra rounds on one day don't pull the median towards that day.
 */
export function practiceStarts(
  now: number,
  roundStarts: readonly number[],
  opts: NudgeOptions,
): number[] {
  const n = opts.nudge ?? config.nudge;
  const today = dayStart(now, opts);
  const from = today - n.lookbackDays * DAY_MS;
  const first = new Map<string, number>();
  for (const t of roundStarts) {
    if (t < from || t >= today) continue;
    const k = dayKey(t, opts);
    const prev = first.get(k);
    if (prev === undefined || t < prev) first.set(k, t);
  }
  return [...first.values()];
}

/**
 * When to remind, in local minutes after midnight: the median start time of the practice days in
 * the last `lookbackDays`, minus `leadMinutes`, clamped to `earliest…latestLocalTime`, once there
 * are at least `minRounds` of them; `defaultLocalTime` (21:00) until then.
 */
export function nudgeTime(now: number, roundStarts: readonly number[], opts: NudgeOptions): number {
  const n = opts.nudge ?? config.nudge;
  const starts = practiceStarts(now, roundStarts, opts);
  if (starts.length < n.minRounds) return n.defaultLocalTime;
  const t = Math.round(median(starts.map((s) => eveningMinutes(s, opts))) - n.leadMinutes);
  return Math.min(n.latestLocalTime, Math.max(n.earliestLocalTime, t));
}

/** "21:00"; "24:30" for half past midnight in the household day. */
export const formatLocalTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** `📚 1 round · ~3 min · 7 due · 2 new → <url>` (DESIGN §4.9). */
export function nudgeText(w: Workload, appUrl: string, session = config.session): string {
  const minutes = Math.max(1, Math.ceil((w.roundCards * session.secondsPerCard) / 60));
  const parts = ["📚 1 round", `~${minutes} min`];
  if (w.due > 0) parts.push(`${w.due} due`);
  if (w.newAvailable > 0) parts.push(`${w.newAvailable} new`);
  return `${parts.join(" · ")} → ${appUrl}`;
}

export interface NudgeInput {
  now: number;
  enabled: boolean;
  /** `dayKey` of the last day a reminder went out (setting `nudge_last_sent_day`). */
  lastSentDay: string | null;
  finishedRoundToday: boolean;
  workload: Workload;
  /** Start times of finished rounds (at least the lookback window's). */
  roundStarts: readonly number[];
  appUrl: string;
}

export type NudgeSkip = "disabled" | "sent_today" | "round_done" | "nothing_to_do" | "too_early";

export type NudgeDecision =
  | { send: true; text: string; day: string; nudgeAt: number }
  | { send: false; reason: NudgeSkip; nudgeAt: number };

/**
 * Text only when the reminder is on and none went out today, no round is finished today, a round
 * has something in it, and it's past `nudgeTime`. At most one a day, never a follow-up.
 */
export function decideNudge(input: NudgeInput, opts: NudgeOptions): NudgeDecision {
  const nudgeAt = nudgeTime(input.now, input.roundStarts, opts);
  const day = dayKey(input.now, opts);
  const skip = (reason: NudgeSkip): NudgeDecision => ({ send: false, reason, nudgeAt });
  if (!input.enabled) return skip("disabled");
  if (input.lastSentDay === day) return skip("sent_today");
  if (input.finishedRoundToday) return skip("round_done");
  if (input.workload.roundCards === 0) return skip("nothing_to_do");
  if (eveningMinutes(input.now, opts) < nudgeAt) return skip("too_early");
  return { send: true, text: nudgeText(input.workload, input.appUrl, opts.session), day, nudgeAt };
}
