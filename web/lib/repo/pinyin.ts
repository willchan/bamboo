// `pinyin` jobs and the merge's writes (DESIGN §5.5.3b, H4). The rules are pure
// (`domain/pinyin.ts`, `@bamboo/shared` pinyin-merge); this layer queues, leases and applies them.
// A pinyin job asks the worker for Gemini's reading of one phrase (unless the extraction already
// sent one) and the referee's choice for each real dispute; the engine re-checks every answer.
import { event, phrase, pinyinJob, type Db, type PinyinJob } from "@bamboo/db";
import { PinyinJobInput, PinyinJobResult, type ClaimedPinyinJob } from "@bamboo/shared";
import { and, asc, eq, lt } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { isLeaseExpired, leaseExpiresAt, statusAfterFailure } from "../domain/jobs";
import {
  disagreementEvent,
  mergedPinyin,
  pinyinJobInput,
  type PhrasePinyin,
} from "../domain/pinyin";
import { eventRow, newId, runBatch } from "./db";

type PhraseForJob = { id: string; hanzi: string; examples: readonly { hanzi: string }[] };

/** Insert a queued `pinyin` job for the phrase. */
export function queuePinyinJob(
  db: Db,
  p: PhraseForJob,
  gemini: readonly string[] | null,
  now: number,
): BatchItem<"sqlite"> {
  return db.insert(pinyinJob).values({
    id: newId(),
    phraseId: p.id,
    status: "queued",
    input: pinyinJobInput(p, gemini) as unknown as Record<string, unknown>,
    createdAt: now,
  });
}

/**
 * The writes that go with a phrase's merged pinyin: the `pinyin_disagreement` event for settled
 * disputes, and a `pinyin` job when the referee is needed (with Gemini's reading) or there was no
 * usable reading to merge (Ollama fallback, a promoted sentence, a misaligned reading).
 */
export function pinyinFollowUps(
  db: Db,
  p: PhraseForJob,
  merged: PhrasePinyin,
  gemini: readonly string[] | null,
  now: number,
): { writes: BatchItem<"sqlite">[]; queued: boolean } {
  const writes: BatchItem<"sqlite">[] = [];
  if (merged.pending === 0) {
    const ev = disagreementEvent(p.id, merged.pinyinSources);
    if (ev) writes.push(db.insert(event).values(eventRow("pinyin_disagreement", ev, now)));
  }
  const queued = merged.pending > 0 || merged.pinyinSources === null;
  if (queued) writes.push(queuePinyinJob(db, p, merged.pending > 0 ? gemini : null, now));
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

/** Lease the oldest queued pinyin job, or null. */
export async function claimPinyinJob(db: Db, now: number): Promise<ClaimedPinyinJob | null> {
  for (let tries = 0; tries < 3; tries++) {
    const next = await db
      .select()
      .from(pinyinJob)
      .where(eq(pinyinJob.status, "queued"))
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
    const gemini = parsed.data.gemini ?? input.gemini;
    const referee = new Map(parsed.data.referee.map((r) => [r.index, r.reading]));
    const merged = mergedPinyin(p.hanzi, gemini, referee, { final: true });
    writes.push(
      db
        .update(phrase)
        .set({
          pinyin: merged.pinyin,
          // A reading that didn't line up still counts as checked, so it isn't asked again.
          pinyinSources: merged.pinyinSources ?? [],
          updatedAt: now,
        })
        .where(eq(phrase.id, p.id)),
    );
    const ev = disagreementEvent(p.id, merged.pinyinSources);
    if (ev) writes.push(db.insert(event).values(eventRow("pinyin_disagreement", ev, now)));
  }
  await runBatch(db, writes);
  return { ok: true, jobStatus: "done" };
}
