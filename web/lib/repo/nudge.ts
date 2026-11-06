// The evening reminder (DESIGN §4.9): loads what `decideNudge` needs, and records a sent reminder
// so it goes out at most once a household day, even if two polls overlap.
import { event, round, setting, type Db } from "@bamboo/db";
import { and, eq, gte, isNotNull, ne } from "drizzle-orm";
import { config } from "../config";
import { dayStart } from "../domain/day";
import { decideNudge, formatLocalTime, nudgeTime, type NudgeDecision } from "../domain/nudge";
import { workload } from "../domain/session";
import { eventRow } from "./db";
import { loadRoundState, type Clock } from "./review";

const DAY_MS = 24 * 60 * 60 * 1000;
export const NUDGE_ENABLED = "nudge_enabled";
export const NUDGE_LAST_SENT_DAY = "nudge_last_sent_day";

async function getSetting(db: Db, key: string): Promise<string | null> {
  const row = await db.query.setting.findFirst({ where: eq(setting.key, key) });
  return row?.value ?? null;
}

/** On unless Will turned it off. */
export async function isNudgeEnabled(db: Db): Promise<boolean> {
  return (await getSetting(db, NUDGE_ENABLED)) !== "0";
}

export async function setNudgeEnabled(db: Db, enabled: boolean): Promise<void> {
  const value = enabled ? "1" : "0";
  await db
    .insert(setting)
    .values({ key: NUDGE_ENABLED, value })
    .onConflictDoUpdate({ target: setting.key, set: { value } });
}

/** Start times of rounds finished in the lookback window (and today). */
async function recentRoundStarts(db: Db, clock: Clock): Promise<number[]> {
  const from =
    dayStart(clock.now, { timeZone: clock.timeZone }) - (config.nudge.lookbackDays + 1) * DAY_MS;
  const rows = await db
    .select({ startedAt: round.startedAt })
    .from(round)
    .where(and(isNotNull(round.finishedAt), gte(round.startedAt, from)));
  return rows.map((r) => r.startedAt);
}

/** Today's reminder time, for the toggle on Today ("around 20:45"). */
export async function getNudgeTime(db: Db, clock: Clock): Promise<string> {
  const starts = await recentRoundStarts(db, clock);
  return formatLocalTime(nudgeTime(clock.now, starts, { timeZone: clock.timeZone }));
}

/** The decision, without recording anything. */
export async function evaluateNudge(db: Db, clock: Clock, appUrl: string): Promise<NudgeDecision> {
  const opts = { timeZone: clock.timeZone };
  const [enabled, lastSentDay, loaded, roundStarts] = await Promise.all([
    isNudgeEnabled(db),
    getSetting(db, NUDGE_LAST_SENT_DAY),
    loadRoundState(db, clock),
    recentRoundStarts(db, clock),
  ]);
  return decideNudge(
    {
      now: clock.now,
      enabled,
      lastSentDay,
      finishedRoundToday: loaded.finishedRoundToday,
      workload: workload(clock.now, loaded.state, { dayEnd: loaded.dayEnd }),
      roundStarts,
      appUrl,
    },
    opts,
  );
}

/**
 * `GET /api/agent/nudge`: the reminder text, or null. A non-null answer records today as sent
 * (with a conditional upsert, so of two overlapping polls only one gets the text) and logs
 * `nudge_sent`.
 */
export async function takeNudge(db: Db, clock: Clock, appUrl: string): Promise<string | null> {
  const d = await evaluateNudge(db, clock, appUrl);
  if (!d.send) return null;
  const claimed = await db
    .insert(setting)
    .values({ key: NUDGE_LAST_SENT_DAY, value: d.day })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value: d.day },
      setWhere: ne(setting.value, d.day),
    });
  if (claimed.rowsAffected === 0) return null;
  const local = new Date(clock.now).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: clock.timeZone,
  });
  await db
    .insert(event)
    .values(
      eventRow(
        "nudge_sent",
        { local_time: local, nudge_at: formatLocalTime(d.nudgeAt) },
        clock.now,
      ),
    );
  return d.text;
}
