// `pinyin` jobs and the merge's writes (DESIGN §5.5.3b, H4). The rules are pure
// (`domain/pinyin.ts`, `@bamboo/shared` pinyin-merge); this layer queues, leases and applies them.
// A pinyin job asks the worker for Gemini's reading of one phrase (unless the extraction already
// sent one) and the referee's choice for each real dispute; the engine re-checks every answer.
import { event, phrase, pinyinJob, type Db, type PhraseExample, type PinyinJob } from "@bamboo/db";
import {
  PinyinJobInput,
  PinyinJobResult,
  sharedConfig,
  type ClaimedPinyinJob,
} from "@bamboo/shared";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { isLeaseExpired, leaseExpiresAt, statusAfterFailure } from "../domain/jobs";
import {
  applyExampleResults,
  disagreementEvent,
  exampleNeedsPinyin,
  mergedPinyin,
  pinyinJobInput,
  type PhrasePinyin,
} from "../domain/pinyin";
import { eventRow, newId, runBatch } from "./db";

type PhraseForJob = {
  id: string;
  hanzi: string;
  examples: readonly Pick<PhraseExample, "hanzi" | "pinyin" | "pinyin_sources">[];
};

type JobOptions = Parameters<typeof pinyinJobInput>[2];

/** Insert a queued `pinyin` job for the phrase. */
export function queuePinyinJob(
  db: Db,
  p: PhraseForJob,
  gemini: readonly string[] | null,
  now: number,
  opts: JobOptions = {},
): BatchItem<"sqlite"> {
  return db.insert(pinyinJob).values({
    id: newId(),
    phraseId: p.id,
    status: "queued",
    input: pinyinJobInput(p, gemini, opts) as unknown as Record<string, unknown>,
    createdAt: now,
  });
}

/** An example's settled disputes, for the `example_pinyin_disagreement` event (§10 #107). */
function exampleDisagreement(
  db: Db,
  phraseId: string,
  index: number,
  sources: PhraseExample["pinyin_sources"],
  now: number,
): BatchItem<"sqlite">[] {
  const ev = disagreementEvent(phraseId, sources ?? null);
  return ev
    ? [
        db
          .insert(event)
          .values(eventRow("example_pinyin_disagreement", { ...ev, example: index }, now)),
      ]
    : [];
}

/**
 * The writes that go with a phrase's merged pinyin: the `pinyin_disagreement` event for settled
 * disputes, and a `pinyin` job when the referee is needed (with Gemini's reading) or there was no
 * usable reading to merge (Ollama fallback, a promoted sentence, a misaligned reading).
 *
 * Since §10 #107 the examples count too: `fresh` (the examples this write added, default all of
 * them) log their settled disputes, and one whose pinyin isn't settled (`exampleNeedsPinyin`)
 * queues the job as well, with the phrase marked settled when only examples need it.
 * `exampleGemini` holds the extraction's example readings by hanzi, so a pending dispute needs
 * only the referee. `merged` is null when the phrase's pinyin is left as it is.
 */
export function pinyinFollowUps(
  db: Db,
  p: PhraseForJob,
  merged: PhrasePinyin | null,
  gemini: readonly string[] | null,
  now: number,
  opts: {
    fresh?: readonly string[];
    exampleGemini?: ReadonlyMap<string, readonly string[] | null | undefined>;
  } = {},
): { writes: BatchItem<"sqlite">[]; queued: boolean } {
  const writes: BatchItem<"sqlite">[] = [];
  if (merged && merged.pending === 0) {
    const ev = disagreementEvent(p.id, merged.pinyinSources);
    if (ev) writes.push(db.insert(event).values(eventRow("pinyin_disagreement", ev, now)));
  }
  const fresh = new Set(opts.fresh ?? p.examples.map((e) => e.hanzi));
  const context = p.examples.slice(0, sharedConfig.pinyin.maxContextExamples);
  let examplesNeed = false;
  context.forEach((e, i) => {
    if (!fresh.has(e.hanzi)) return;
    if (exampleNeedsPinyin(e)) examplesNeed = true;
    else writes.push(...exampleDisagreement(db, p.id, i, e.pinyin_sources, now));
  });
  const phraseNeeds = !!merged && (merged.pending > 0 || merged.pinyinSources === null);
  const queued = phraseNeeds || examplesNeed;
  if (queued)
    writes.push(
      queuePinyinJob(db, p, merged && merged.pending > 0 ? gemini : null, now, {
        phraseSettled: !phraseNeeds,
        exampleGemini: opts.exampleGemini,
      }),
    );
  return { writes, queued };
}

/** Requeue (or fail) pinyin jobs whose lease ran out. */
export async function sweepPinyinLeases(db: Db, now: number): Promise<number> {
  const leased = await db
    .select()
    .from(pinyinJob)
    .where(and(eq(pinyinJob.status, "leased"), lt(pinyinJob.leaseExpiresAt, now + 1)));
  let n = 0;
  for (const j of leased.filter((x) => isLeaseExpired(x, now))) {
    await runBatch(db, [failWrite(db, j, statusAfterFailure(j.attempt), "lease expired", now)]);
    n += 1;
  }
  return n;
}

function failWrite(
  db: Db,
  j: PinyinJob,
  next: "queued" | "failed",
  error: string,
  now: number,
  meta: { model?: string | null; promptVersion?: string | null } = {},
): BatchItem<"sqlite"> {
  return db
    .update(pinyinJob)
    .set({
      status: next,
      error,
      leaseExpiresAt: null,
      finishedAt: next === "failed" ? now : null,
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.promptVersion !== undefined ? { promptVersion: meta.promptVersion } : {}),
    })
    .where(
      and(eq(pinyinJob.id, j.id), eq(pinyinJob.attempt, j.attempt), eq(pinyinJob.status, "leased")),
    );
}

/** A job the example-pinyin backfill queued (§10 #107). */
const isBackfillJob = sql`coalesce(json_extract(${pinyinJob.input}, '$.backfill'), 0) = 1`;

/**
 * Lease the oldest queued pinyin job, or null. Backfill jobs (§10 #107) only with `backfill`:
 * the backfill run on the paid key, so the everyday worker's free quota is never spent on them.
 */
export async function claimPinyinJob(
  db: Db,
  now: number,
  opts: { backfill?: boolean } = {},
): Promise<ClaimedPinyinJob | null> {
  for (let tries = 0; tries < 3; tries++) {
    const next = await db
      .select()
      .from(pinyinJob)
      .where(
        opts.backfill
          ? eq(pinyinJob.status, "queued")
          : and(eq(pinyinJob.status, "queued"), sql`not (${isBackfillJob})`),
      )
      .orderBy(asc(pinyinJob.createdAt), asc(pinyinJob.id))
      .limit(1)
      .get();
    if (!next) return null;
    const input = PinyinJobInput.safeParse(next.input);
    if (!input.success) {
      // Can't happen for rows this engine wrote; don't let one bad row block the queue.
      await db
        .update(pinyinJob)
        .set({ status: "failed", error: "bad input", finishedAt: now })
        .where(eq(pinyinJob.id, next.id));
      continue;
    }
    const lease = leaseExpiresAt(now);
    const res = await db
      .update(pinyinJob)
      .set({ status: "leased", attempt: next.attempt + 1, leaseExpiresAt: lease })
      .where(and(eq(pinyinJob.id, next.id), eq(pinyinJob.status, "queued")));
    if (res.rowsAffected === 0) continue;
    return {
      job_id: next.id,
      type: "pinyin",
      attempt: next.attempt + 1,
      lease_expires_at: lease,
      input: input.data,
    };
  }
  return null;
}

export type PinyinCompleteResult =
  | { ok: true; jobStatus: "queued" | "done" | "failed" }
  | { ok: false; error: "not_found" | "stale_attempt" }
  | {
      ok: false;
      error: "invalid_result";
      jobStatus: "queued" | "failed";
      issues: { path: string; message: string }[];
    };

/**
 * Complete a pinyin job: merge Gemini's reading and the referee's choices into the phrase, unless
 * its hanzi changed since the job was queued (a newer job covers it) or it was deleted.
 */
export async function completePinyinJob(
  db: Db,
  j: PinyinJob,
  body: {
    attempt: number;
    status: "done" | "failed";
    result?: unknown;
    error?: string;
    model?: string | null;
    prompt_version?: string | null;
  },
  now: number,
): Promise<PinyinCompleteResult> {
  if (j.status !== "leased" || j.attempt !== body.attempt) {
    return { ok: false, error: "stale_attempt" };
  }
  const meta = { model: body.model ?? null, promptVersion: body.prompt_version ?? null };
  if (body.status === "failed") {
    const next = statusAfterFailure(j.attempt);
    await runBatch(db, [failWrite(db, j, next, body.error ?? "failed", now, meta)]);
    return { ok: true, jobStatus: next };
  }
  const parsed = PinyinJobResult.safeParse(body.result);
  if (!parsed.success) {
    const next = statusAfterFailure(j.attempt);
    await runBatch(db, [failWrite(db, j, next, "invalid_result", now, meta)]);
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { ok: false, error: "invalid_result", jobStatus: next, issues };
  }

  const input = j.input as unknown as PinyinJobInput;
  const writes: BatchItem<"sqlite">[] = [
    db
      .update(pinyinJob)
      .set({
        status: "done",
        result: parsed.data as unknown as Record<string, unknown>,
        model: meta.model,
        promptVersion: meta.promptVersion,
        error: null,
        leaseExpiresAt: null,
        finishedAt: now,
      })
      .where(
        and(
          eq(pinyinJob.id, j.id),
          eq(pinyinJob.attempt, j.attempt),
          eq(pinyinJob.status, "leased"),
        ),
      ),
  ];
  const p = await db.query.phrase.findFirst({ where: eq(phrase.id, j.phraseId) });
  if (p && p.hanzi === input.hanzi) {
    const set: Partial<typeof phrase.$inferInsert> = {};
    if (!input.phrase_settled) {
      const gemini = parsed.data.gemini ?? input.gemini;
      const referee = new Map(parsed.data.referee.map((r) => [r.index, r.reading]));
      const merged = mergedPinyin(p.hanzi, gemini, referee, { final: true });
      set.pinyin = merged.pinyin;
      // A reading that didn't line up still counts as checked, so it isn't asked again.
      set.pinyinSources = merged.pinyinSources ?? [];
      const ev = disagreementEvent(p.id, merged.pinyinSources);
      if (ev) writes.push(db.insert(event).values(eventRow("pinyin_disagreement", ev, now)));
    }
    // The examples (§10 #107): each one still in its place with the same hanzi is merged.
    const ex = applyExampleResults(p.examples, input, parsed.data);
    if (ex.changed) {
      set.examples = ex.examples;
      for (const s of ex.settled)
        writes.push(...exampleDisagreement(db, p.id, s.index, s.sources, now));
    }
    if (Object.keys(set).length)
      writes.push(
        db
          .update(phrase)
          .set({ ...set, updatedAt: now })
          .where(eq(phrase.id, p.id)),
      );
  }
  await runBatch(db, writes);
  return { ok: true, jobStatus: "done" };
}

// --- The example-pinyin backfill (§10 #107) ----------------------------------------------------

/** Phrase ids with a queued or leased pinyin job. */
async function openPinyinPhrases(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ id: pinyinJob.phraseId })
    .from(pinyinJob)
    .where(inArray(pinyinJob.status, ["queued", "leased"]));
  return new Set(rows.map((r) => r.id));
}

/**
 * Current terms (queued or active) with an example whose pinyin isn't settled, oldest first:
 * `missing` all of them, `queueable` those without an open pinyin job.
 */
export async function examplePinyinCandidates(db: Db) {
  const rows = await db
    .select({
      id: phrase.id,
      hanzi: phrase.hanzi,
      examples: phrase.examples,
      pinyinSources: phrase.pinyinSources,
    })
    .from(phrase)
    .where(and(eq(phrase.kind, "term"), inArray(phrase.status, ["queued", "active"])))
    .orderBy(asc(phrase.createdAt), asc(phrase.id));
  const open = await openPinyinPhrases(db);
  const missing = rows.filter((r) =>
    r.examples.slice(0, sharedConfig.pinyin.maxContextExamples).some(exampleNeedsPinyin),
  );
  return { missing, queueable: missing.filter((r) => !open.has(r.id)) };
}

/** Open (queued or leased) backfill jobs. */
export async function openBackfillPinyinJobs(db: Db): Promise<number> {
  const rows = await db
    .select({ id: pinyinJob.id })
    .from(pinyinJob)
    .where(and(inArray(pinyinJob.status, ["queued", "leased"]), isBackfillJob));
  return rows.length;
}

/**
 * `POST /api/agent/example-pinyin`: queue a backfill `pinyin` job for each queueable phrase, at
 * most `limit`. Nothing calls Gemini here: the jobs wait for the backfill run on the paid key,
 * which takes them one at a time under its rate limits (§5.5.6). A phrase whose own pinyin was
 * merged keeps it (`phrase_settled`); one never read by Gemini is read too.
 */
export async function queueExamplePinyin(
  db: Db,
  now: number,
  opts: { limit?: number } = {},
): Promise<{ queued: number; remaining: number }> {
  const { queueable } = await examplePinyinCandidates(db);
  const take = queueable.slice(0, opts.limit ?? queueable.length);
  const writes = take.map((r) => {
    const settled = !!r.pinyinSources && !r.pinyinSources.some((s) => s.rule === "pending");
    return queuePinyinJob(db, r, null, now, { phraseSettled: settled, backfill: true });
  });
  await runBatch(db, writes);
  return { queued: take.length, remaining: queueable.length - take.length };
}
