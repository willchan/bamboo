// The Stats page (DESIGN §7): loads the last few weeks of rounds, reviews and events, and hands
// them to the pure measures in domain/stats.ts.
import { event, phrase, reviewLog, round, type Db } from "@bamboo/db";
import { and, count, eq, gte, inArray, isNotNull, max } from "drizzle-orm";
import {
  askedAgainOnActive,
  extractionDropRate,
  notUsefulRates,
  practiceDaysPerWeek,
  recentWeeks,
  trueRetention,
  type NotUsefulRates,
  type Rate,
  type Week,
} from "../domain/stats";
import type { Clock } from "./review";

export interface StatsView {
  weeks: (Week & { practiceDays: number })[];
  retention: Rate;
  askedAgainActive: number;
  notUseful: NotUsefulRates;
  extractionDrop: Rate;
  queueSize: number;
  lastHeartbeatAt: number | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : null);

export async function getStats(db: Db, clock: Clock): Promise<StatsView> {
  const opts = { timeZone: clock.timeZone };
  const weeks = recentWeeks(clock.now, opts);
  const from = weeks[weeks.length - 1]!.start;

  const [rounds, reviews, events, [queued], [beat]] = await Promise.all([
    db
      .select({ finishedAt: round.finishedAt })
      .from(round)
      .where(and(isNotNull(round.finishedAt), gte(round.finishedAt, from))),
    db
      .select({
        rating: reviewLog.rating,
        stateBefore: reviewLog.stateBefore,
        source: reviewLog.source,
      })
      .from(reviewLog)
      .where(gte(reviewLog.reviewedAt, from)),
    db
      .select({ type: event.type, data: event.data })
      .from(event)
      .where(
        and(
          inArray(event.type, ["asked_again", "phrase_introduced", "phrase_dropped", "extraction"]),
          gte(event.at, from),
        ),
      ),
    db.select({ n: count() }).from(phrase).where(eq(phrase.status, "queued")),
    db
      .select({ at: max(event.at) })
      .from(event)
      .where(eq(event.type, "worker_heartbeat")),
  ]);

  const ofType = (t: string) => events.filter((e) => e.type === t).map((e) => e.data);
  // First sights: introduced phrases, plus phrases dropped with Not useful (those never become
  // active). Drops from Up next or the editor aren't first sights.
  const seen = [
    ...ofType("phrase_introduced").map((d) => ({
      kind: str(d.kind),
      usefulness: num(d.usefulness),
      notUseful: false,
    })),
    ...ofType("phrase_dropped")
      .filter((d) => d.via === "not_useful")
      .map((d) => ({ kind: str(d.kind), usefulness: num(d.usefulness), notUseful: true })),
  ];

  const practice = practiceDaysPerWeek(
    weeks,
    rounds.map((r) => r.finishedAt!),
    opts,
  );
  return {
    weeks: weeks.map((w, i) => ({ ...w, practiceDays: practice[i]! })),
    retention: trueRetention(reviews),
    askedAgainActive: askedAgainOnActive(
      ofType("asked_again").map((d) => ({ status: str(d.status) })),
    ),
    notUseful: notUsefulRates(seen),
    extractionDrop: extractionDropRate(
      ofType("extraction").map((d) => ({
        items: num(d.items) ?? 0,
        dropped_not_verbatim: num(d.dropped_not_verbatim) ?? 0,
      })),
    ),
    queueSize: queued?.n ?? 0,
    lastHeartbeatAt: beat?.at ?? null,
  };
}
