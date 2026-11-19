// `GET /api/agent/backfill` (H7, DESIGN §5.5.6): the backfill's counts. Read-only, and counts only:
// no turn text, phrase or name leaves this function (CLAUDE.md › Privacy).
import { card, event, job, phrase, pinyinJob, reviewLog, turn, type Db } from "@bamboo/db";
import type { BackfillReport } from "@bamboo/shared";
import { and, count, eq, gte, inArray, isNotNull, like, sql } from "drizzle-orm";
import { config } from "../config";
import { atReplyCap, sumRerunEvents } from "../domain/backfill";
import { openReextractions, staleTurnIds } from "./capture";

const num = (v: unknown) => Number(v ?? 0);

export async function backfillReport(db: Db, since: number): Promise<BackfillReport> {
  const cap = config.imports.replyMaxChars;
  const turnsRes = await db.$client.execute(`
    with latest as (
      select prompt_version v from job
      where status = 'done' and prompt_version is not null
      order by finished_at desc, id desc limit 1
    ),
    last as (
      select json_extract(input, '$.turn_id') tid, prompt_version v, reextract,
        row_number() over (
          partition by json_extract(input, '$.turn_id') order by finished_at desc, id desc
        ) rn
      from job where status = 'done'
    )
    select
      (select v from latest) newest,
      (select count(*) from turn) stored,
      (select count(*) from last where rn = 1 and v = (select v from latest)) on_newest,
      (select count(*) from last where rn = 1 and v = (select v from latest) and reextract = 1) reread,
      (select count(*) from turn where id not in (select tid from last)) no_finished`);
  const t = turnsRes.rows[0]!;

  // A reply cut at `cap` UTF-16 units has between cap/2 and cap characters (SQLite's length);
  // only those candidates are read, and only to measure them.
  const candidates = await db
    .select({ replyText: turn.replyText })
    .from(turn)
    .where(
      and(
        gte(sql`length(${turn.replyText})`, Math.ceil(cap / 2)),
        sql`length(${turn.replyText}) <= ${cap}`,
      ),
    );
  const replyAtCap = candidates.filter((c) => atReplyCap(c.replyText, cap)).length;

  const [remaining, open, events, disagreements, pinyinDone, pinyinFailed, referee, failed] =
    await Promise.all([
      staleTurnIds(db, { all: true }),
      openReextractions(db),
      db
        .select({ data: event.data })
        .from(event)
        .where(and(eq(event.type, "extraction"), gte(event.at, since)))
        .orderBy(event.at, event.id),
      db
        .select({ n: count() })
        .from(event)
        .where(and(eq(event.type, "pinyin_disagreement"), gte(event.at, since))),
      pinyinCount(db, since, "done"),
      pinyinCount(db, since, "failed"),
      db
        .select({ n: count() })
        .from(pinyinJob)
        .where(
          and(
            eq(pinyinJob.status, "done"),
            gte(pinyinJob.finishedAt, since),
            like(pinyinJob.promptVersion, "%referee%"),
          ),
        ),
      db
        .select({ n: count() })
        .from(job)
        .where(and(eq(job.reextract, true), eq(job.status, "failed"), gte(job.finishedAt, since))),
    ]);

  const [reported, logRows, reviewed] = await Promise.all([
    db
      .select({ n: count() })
      .from(phrase)
      .where(and(isNotNull(phrase.unpickedAt), inArray(phrase.status, ["queued", "active"]))),
    db.select({ n: count() }).from(reviewLog),
    db.select({ n: count() }).from(card).where(isNotNull(card.lastReview)),
  ]);

  const sums = sumRerunEvents(events.map((e) => e.data));
  return {
    since,
    newest_prompt: t.newest == null ? null : String(t.newest),
    turns: {
      stored: num(t.stored),
      on_newest_prompt: num(t.on_newest),
      reread_on_newest_prompt: num(t.reread),
      remaining: remaining.length,
      no_finished_job: num(t.no_finished),
      open_reextract: open,
      reply_at_cap: replyAtCap,
      reply_max_chars: cap,
    },
    run: {
      ...sums,
      failed: failed[0]!.n,
      pinyin_disagreements: disagreements[0]!.n,
      pinyin_jobs_done: pinyinDone,
      pinyin_jobs_failed: pinyinFailed,
      referee_calls: referee[0]!.n,
    },
    phrases_reported_open: reported[0]!.n,
    review: { review_log_rows: logRows[0]!.n, reviewed_cards: reviewed[0]!.n },
  };
}

async function pinyinCount(db: Db, since: number, status: "done" | "failed"): Promise<number> {
  const r = await db
    .select({ n: count() })
    .from(pinyinJob)
    .where(and(eq(pinyinJob.status, status), gte(pinyinJob.finishedAt, since)));
  return r[0]!.n;
}
