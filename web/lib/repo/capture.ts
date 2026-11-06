// Capture persistence (DESIGN §2.2–2.3, §3.2, §4.5–4.7, §5.3): imports and their turns, the
// extract_turn job queue, applying extraction results to the phrase queue, notifications and the
// daily cron. Rules live in lib/domain; this layer loads, calls them and writes the results.
import {
  card,
  event,
  imports,
  job,
  phrase,
  reviewLog,
  turn,
  type Db,
  type Import,
  type ImportKind,
  type Job,
  type Phrase,
} from "@bamboo/db";
import {
  ExtractTurnResult,
  normalizeText,
  turnKey,
  type ClaimedJob,
  type ExtractTurnInput,
  type Heartbeat,
  type ImportRequest,
  type Notification,
} from "@bamboo/shared";
import { and, asc, count, desc, eq, inArray, lt, max, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { config } from "../config";
import { importSummary, workerStatus, type WorkerStatus } from "../domain/imports";
import { isLeaseExpired, isStaleAttempt, leaseExpiresAt, statusAfterFailure } from "../domain/jobs";
import { initialCardTypes } from "../domain/phrase";
import { expiredPhraseIds, planMerge, validateExtraction } from "../domain/queue";
import { askedAgainCards } from "../domain/session";
import { reviewCard } from "../domain/fsrs";
import { eventRow, newId, runBatch } from "./db";
import { listQueue, phraseRows } from "./phrases";
import { fsrsColumns } from "./review";

const OPEN_JOB = ["queued", "leased"] as const;
/** SQLite caps bound variables per statement; stay well under it. */
const IN_CHUNK = 500;

function chunks<T>(xs: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function existingKeys(db: Db, keys: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunks([...new Set(keys)])) {
    const rows = await db.select({ k: turn.turnKey }).from(turn).where(inArray(turn.turnKey, part));
    for (const r of rows) found.add(r.k);
  }
  return found;
}

// --- Imports ---------------------------------------------------------------------------------

/** `POST /api/imports/known`: the keys with no turn yet, in request order, deduplicated. */
export async function unknownKeys(db: Db, keys: readonly string[]): Promise<string[]> {
  const found = await existingKeys(db, keys);
  return [...new Set(keys)].filter((k) => !found.has(k));
}

export type ReceiveResult =
  | { ok: true; importId: string; turnsNew: number; turnsAdded: number }
  | { ok: false; error: "not_found" | "import_closed" | "conflict" };

type ParsedImport = Omit<ImportRequest, "more" | "turns"> & {
  more: boolean;
  turns: { user_text: string; reply_text: string; position: number }[];
};

const isUniqueViolation = (e: unknown) =>
  /UNIQUE constraint failed/i.test(String((e as { cause?: unknown })?.cause ?? e)) ||
  /UNIQUE constraint failed/i.test(String(e));

/**
 * `POST /api/imports` (and the paste box). Creates the import on the first call, or appends a
 * chunk to `import_id` (or to the import its idempotency key already created). The engine
 * recomputes every turn key (§4.5), stores only turns it has never seen, and queues one
 * `extract_turn` job per new turn, all in one transaction.
 */
export async function receiveImport(
  db: Db,
  req: ParsedImport,
  idempotencyKey: string | null,
  now: number,
): Promise<ReceiveResult> {
  let existing: Import | undefined;
  if (req.import_id) {
    existing = await db.query.imports.findFirst({ where: eq(imports.id, req.import_id) });
    if (!existing) return { ok: false, error: "not_found" };
  } else if (idempotencyKey) {
    existing = await db.query.imports.findFirst({
      where: eq(imports.idempotencyKey, idempotencyKey),
    });
  }
  const importId = existing?.id ?? newId();
  const kind: ImportKind = existing?.kind ?? req.kind;
  const title = existing ? existing.conversationTitle : (req.conversation_title ?? null);

  // Recompute keys; within one call the first turn with a key wins.
  const byKey = new Map<string, ParsedImport["turns"][number]>();
  for (const t of req.turns) {
    const k = turnKey(t, kind);
    if (!byKey.has(k)) byKey.set(k, t);
  }
  const known = await existingKeys(db, [...byKey.keys()]);
  const fresh = [...byKey].filter(([k]) => !known.has(k));
  if (existing?.uploadedAt != null && fresh.length > 0)
    return { ok: false, error: "import_closed" };

  const writes: BatchItem<"sqlite">[] = [];
  if (!existing) {
    writes.push(
      db.insert(imports).values({
        id: importId,
        kind,
        origin: req.origin,
        sourceRef: req.source_ref ?? null,
        conversationTitle: title,
        discordChannelId: req.discord_channel_id ?? null,
        discordMessageId: req.discord_message_id ?? null,
        idempotencyKey,
        turnsTotal: req.turns_total,
        status: "extracting",
        createdAt: now,
      }),
    );
  }
  const turnRows = fresh.map(([k, t]) => ({
    id: newId(),
    importId,
    turnKey: k,
    userText: normalizeText(t.user_text),
    replyText: normalizeText(t.reply_text).slice(0, config.imports.replyMaxChars),
    position: t.position,
    createdAt: now,
  }));
  if (turnRows.length) {
    writes.push(db.insert(turn).values(turnRows));
    writes.push(
      db.insert(job).values(
        turnRows.map((t) => ({
          id: newId(),
          type: "extract_turn" as const,
          status: "queued" as const,
          importId,
          input: {
            turn_id: t.id,
            conversation_title: title,
            user_text: t.userText,
            reply_text: t.replyText,
          } satisfies ExtractTurnInput,
          createdAt: now,
        })),
      ),
    );
  }
  writes.push(
    db
      .update(imports)
      .set({
        turnsNew: sql`${imports.turnsNew} + ${turnRows.length}`,
        ...(req.more || existing?.uploadedAt != null ? {} : { uploadedAt: now }),
      })
      .where(eq(imports.id, importId)),
  );
  try {
    await runBatch(db, writes);
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "conflict" };
    throw e;
  }
  if (!req.more) await maybeFinishImport(db, importId, now);
  const row = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  return { ok: true, importId, turnsNew: row?.turnsNew ?? 0, turnsAdded: turnRows.length };
}

/** The PWA paste box: one Gemini answer, as a text import from the web. */
export function importPastedText(db: Db, text: string, now: number): Promise<ReceiveResult> {
  return receiveImport(
    db,
    {
      kind: "text",
      origin: "web",
      turns_total: 1,
      turns: [{ user_text: "", reply_text: text, position: 0 }],
      more: false,
    },
    null,
    now,
  );
}

/**
 * Close an import once its last chunk is in and no job is open: `done`, the summary, and
 * `import_finished`. An import with nothing new needs no Discord reply (the skill already said
 * "Nothing new"), so it's marked notified too. Idempotent.
 */
export async function maybeFinishImport(db: Db, importId: string, now: number): Promise<boolean> {
  const imp = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  if (!imp || imp.status !== "extracting" || imp.uploadedAt === null) return false;
  const counts = await db
    .select({ status: job.status, n: count() })
    .from(job)
    .where(eq(job.importId, importId))
    .groupBy(job.status);
  const n = (s: Job["status"]) => counts.find((c) => c.status === s)?.n ?? 0;
  if (OPEN_JOB.some((s) => n(s) > 0)) return false;

  const jobsFailed = n("failed");
  const nextUp = (await listQueue(db, now))
    .filter((p) => p.lastAskedImportId === importId)
    .slice(0, config.imports.nextUpCount)
    .map((p) => ({ hanzi: p.hanzi, english: p.english }));
  const summary = importSummary({
    kind: imp.kind,
    turnsNew: imp.turnsNew,
    phrasesNew: imp.phrasesNew,
    phrasesAgain: imp.phrasesAgain,
    jobsFailed,
    nextUp,
  });
  const res = await db.batch([
    db
      .update(imports)
      .set({
        status: "done",
        jobsFailed,
        summary,
        finishedAt: now,
        ...(imp.turnsNew === 0 && imp.notifiedAt === null ? { notifiedAt: now } : {}),
      })
      .where(and(eq(imports.id, importId), eq(imports.status, "extracting"))),
    db.insert(event).values(
      eventRow(
        "import_finished",
        {
          import_id: importId,
          kind: imp.kind,
          turns_total: imp.turnsTotal,
          turns_new: imp.turnsNew,
          jobs_failed: jobsFailed,
          phrases_new: imp.phrasesNew,
          phrases_again: imp.phrasesAgain,
        },
        now,
      ),
    ),
  ]);
  return res[0].rowsAffected > 0;
}

/** `GET /api/agent/notifications`: finished Discord imports not yet replied to. */
export async function pendingNotifications(db: Db): Promise<Notification[]> {
  const rows = await db
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.status, "done"),
        sql`${imports.discordMessageId} is not null`,
        sql`${imports.notifiedAt} is null`,
      ),
    )
    .orderBy(asc(imports.finishedAt));
  return rows.map((r) => ({
    import_id: r.id,
    kind: r.kind,
    discord_channel_id: r.discordChannelId,
    discord_message_id: r.discordMessageId!,
    summary: r.summary ?? "",
  }));
}

/** `POST /api/imports/{id}/notified`. Idempotent; false for an unknown import. */
export async function markNotified(db: Db, importId: string, now: number): Promise<boolean> {
  const imp = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  if (!imp) return false;
  if (imp.notifiedAt === null) {
    await db.update(imports).set({ notifiedAt: now }).where(eq(imports.id, importId));
  }
  return true;
}

// --- Jobs ------------------------------------------------------------------------------------

/**
 * Requeue (or fail, after the last attempt) every lease that ran out. Called by claim and by the
 * daily cron.
 */
export async function sweepExpiredLeases(
  db: Db,
  now: number,
): Promise<{ requeued: number; failed: number }> {
  const leased = await db
    .select()
    .from(job)
    .where(and(eq(job.status, "leased"), lt(job.leaseExpiresAt, now + 1)));
  const out = { requeued: 0, failed: 0 };
  const touched = new Set<string>();
  for (const j of leased.filter((x) => isLeaseExpired(x, now))) {
    const next = statusAfterFailure(j.attempt);
    await runBatch(db, failWrites(db, j, next, "lease expired", now));
    out[next === "failed" ? "failed" : "requeued"] += 1;
    if (next === "failed") touched.add(j.importId);
  }
  for (const id of touched) await maybeFinishImport(db, id, now);
  return out;
}

function failWrites(
  db: Db,
  j: Job,
  next: "queued" | "failed",
  error: string,
  now: number,
  meta: { model?: string | null; promptVersion?: string | null } = {},
): BatchItem<"sqlite">[] {
  const writes: BatchItem<"sqlite">[] = [
    db
      .update(job)
      .set({
        status: next,
        error,
        leaseExpiresAt: null,
        finishedAt: next === "failed" ? now : null,
        ...(meta.model !== undefined ? { model: meta.model } : {}),
        ...(meta.promptVersion !== undefined ? { promptVersion: meta.promptVersion } : {}),
      })
      .where(and(eq(job.id, j.id), eq(job.attempt, j.attempt), eq(job.status, "leased"))),
  ];
  if (next === "failed") {
    writes.push(
      db
        .update(imports)
        .set({ jobsFailed: sql`${imports.jobsFailed} + 1` })
        .where(eq(imports.id, j.importId)),
    );
  }
  return writes;
}

/** `POST /api/jobs/claim`: lease the oldest queued job (attempt + 1), or null when idle. */
export async function claimJob(db: Db, now: number): Promise<ClaimedJob | null> {
  await sweepExpiredLeases(db, now);
  for (let tries = 0; tries < 3; tries++) {
    const next = await db
      .select()
      .from(job)
      .where(eq(job.status, "queued"))
      .orderBy(asc(job.createdAt), asc(job.id))
      .limit(1)
      .get();
    if (!next) return null;
    const lease = leaseExpiresAt(now);
    const res = await db
      .update(job)
      .set({ status: "leased", attempt: next.attempt + 1, leaseExpiresAt: lease })
      .where(and(eq(job.id, next.id), eq(job.status, "queued")));
    if (res.rowsAffected === 0) continue; // someone else got it
    return {
      job_id: next.id,
      type: next.type,
      attempt: next.attempt + 1,
      lease_expires_at: lease,
      input: next.input as ExtractTurnInput,
    };
  }
  return null;
}

export interface CompleteBody {
  job_id: string;
  attempt: number;
  status: "done" | "failed";
  result?: unknown;
  error?: string;
  model?: string | null;
  prompt_version?: string | null;
  latency_ms?: number | null;
  repaired?: boolean | null;
}

export type CompleteResult =
  | { ok: true; jobStatus: "queued" | "done" | "failed" }
  | { ok: false; error: "not_found" | "stale_attempt" }
  | {
      ok: false;
      error: "invalid_result";
      jobStatus: "queued" | "failed";
      issues: { path: string; message: string }[];
    };

/**
 * `POST /api/jobs/complete`. A failure (or a result that fails the contract) uses up the attempt:
 * back to `queued`, or `failed` after `maxAttempts`. A valid result is applied in one
 * transaction: the turn's kind, the phrase queue (§4.6), the job and the import's counters.
 */
export async function completeJob(
  db: Db,
  body: CompleteBody,
  now: number,
): Promise<CompleteResult> {
  const j = await db.query.job.findFirst({ where: eq(job.id, body.job_id) });
  if (!j) return { ok: false, error: "not_found" };
  if (isStaleAttempt(j, body.attempt)) return { ok: false, error: "stale_attempt" };
  const meta = { model: body.model ?? null, promptVersion: body.prompt_version ?? null };

  if (body.status === "failed") {
    const next = statusAfterFailure(j.attempt);
    await runBatch(db, failWrites(db, j, next, body.error ?? "failed", now, meta));
    await maybeFinishImport(db, j.importId, now);
    return { ok: true, jobStatus: next };
  }

  const parsed = ExtractTurnResult.safeParse(body.result);
  if (!parsed.success) {
    const next = statusAfterFailure(j.attempt);
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    await runBatch(db, failWrites(db, j, next, "invalid_result", now, meta));
    await maybeFinishImport(db, j.importId, now);
    return { ok: false, error: "invalid_result", jobStatus: next, issues };
  }

  const input = j.input as ExtractTurnInput;
  const t = await db.query.turn.findFirst({ where: eq(turn.id, input.turn_id) });
  if (!t) return { ok: false, error: "not_found" };
  const applied = await applyExtraction(db, { turn: t, importId: j.importId }, parsed.data, now);

  const writes: BatchItem<"sqlite">[] = [
    ...applied.writes,
    db.update(turn).set({ kind: parsed.data.turn_kind, extractedAt: now }).where(eq(turn.id, t.id)),
    db
      .update(job)
      .set({
        status: "done",
        result: parsed.data,
        model: meta.model,
        promptVersion: meta.promptVersion,
        error: null,
        leaseExpiresAt: null,
        finishedAt: now,
      })
      .where(and(eq(job.id, j.id), eq(job.attempt, j.attempt), eq(job.status, "leased"))),
    db
      .update(imports)
      .set({
        phrasesNew: sql`${imports.phrasesNew} + ${applied.phrasesNew}`,
        phrasesAgain: sql`${imports.phrasesAgain} + ${applied.phrasesAgain}`,
      })
      .where(eq(imports.id, j.importId)),
    db.insert(event).values(
      eventRow(
        "extraction",
        {
          turn_id: t.id,
          job_id: j.id,
          model: meta.model,
          prompt_version: meta.promptVersion,
          latency_ms: body.latency_ms ?? null,
          repaired: body.repaired ?? null,
          turn_kind: parsed.data.turn_kind,
          items: parsed.data.items.length,
          kept: applied.validation.items.length,
          dropped_not_verbatim: applied.validation.droppedNotVerbatim,
          dropped_duplicate: applied.validation.droppedDuplicate,
          examples_dropped: applied.validation.examplesDropped,
          heard_as_dropped: applied.validation.heardAsDropped,
        },
        now,
      ),
    ),
  ];
  await runBatch(db, writes);
  await maybeFinishImport(db, j.importId, now);
  return { ok: true, jobStatus: "done" };
}

/**
 * §4.6 on one result: validate, then create `queued` phrases (with cards, §4.8) or merge into
 * existing ones (asked again, revival). Returns the writes; doesn't run them.
 */
async function applyExtraction(
  db: Db,
  ctx: { turn: typeof turn.$inferSelect; importId: string },
  result: ExtractTurnResult,
  now: number,
) {
  const validation = validateExtraction(
    { userText: ctx.turn.userText, replyText: ctx.turn.replyText },
    result,
  );
  const writes: BatchItem<"sqlite">[] = [];
  let phrasesNew = 0;
  let phrasesAgain = 0;
  const keys = validation.items.map((i) => i.hanziKey);
  const existing = new Map<string, Phrase>();
  if (keys.length) {
    const rows = await db.select().from(phrase).where(inArray(phrase.hanziKey, keys));
    for (const p of rows) existing.set(p.hanziKey, p);
  }

  for (const item of validation.items) {
    const p = existing.get(item.hanziKey);
    if (!p) {
      const rows = phraseRows(
        {
          status: "queued",
          kind: item.kind,
          hanzi: item.hanzi,
          english: item.english,
          addressee: item.addressee,
          heardAs: item.heardAs,
          examples: item.example ? [{ ...item.example, turn_id: ctx.turn.id }] : [],
          tags: item.tags,
          usefulness: item.usefulness,
          turnKind: result.turn_kind,
          source: "import",
          sourceTurnId: ctx.turn.id,
          flags: item.flags,
        },
        initialCardTypes(item.kind, result.turn_kind),
        now,
      );
      writes.push(
        db.insert(phrase).values({ ...rows.phrase, lastAskedImportId: ctx.importId }),
        db.insert(card).values(rows.cards),
      );
      phrasesNew += 1;
      continue;
    }

    const plan = planMerge(p, item, { importId: ctx.importId, turnId: ctx.turn.id, now });
    writes.push(db.update(phrase).set(plan.patch).where(eq(phrase.id, p.id)));
    if (plan.bumped) {
      writes.push(
        db
          .insert(event)
          .values(
            eventRow(
              "asked_again",
              { phrase_id: p.id, status: p.status, import_id: ctx.importId },
              now,
            ),
          ),
      );
      if (plan.revived && plan.patch.status === "queued") phrasesNew += 1;
      else phrasesAgain += 1;
    }
    if (plan.revived) {
      writes.push(db.insert(event).values(eventRow("phrase_revived", { phrase_id: p.id }, now)));
    }
    if (plan.askedAgain) {
      const cards = await db.select().from(card).where(eq(card.phraseId, p.id));
      const again = askedAgainCards({ status: plan.patch.status }, cards, false);
      for (const c of cards.filter((x) => again.includes(x.id))) {
        const outcome = await reviewCard(c.id, fsrsColumns(c), 1, now);
        writes.push(
          db.update(card).set(outcome.next).where(eq(card.id, c.id)),
          db.insert(reviewLog).values({
            id: newId(),
            cardId: c.id,
            rating: 1,
            source: "asked_again",
            stateBefore: c.state,
            roundId: null,
            reviewedAt: now,
            durationMs: null,
            fsrsLog: outcome.log,
          }),
          db
            .insert(event)
            .values(
              eventRow("review", { card_type: c.type, rating: 1, source: "asked_again" }, now),
            ),
        );
      }
    }
  }
  return { writes, validation, phrasesNew, phrasesAgain };
}

/**
 * Imports › Retry failed: requeue failed jobs with `attempt` reset, and reopen their imports. An
 * import already replied to in Discord isn't replied to again.
 */
export async function retryFailedJobs(db: Db, importId?: string): Promise<number> {
  const failed = await db
    .select({ id: job.id, importId: job.importId })
    .from(job)
    .where(and(eq(job.status, "failed"), importId ? eq(job.importId, importId) : undefined));
  if (failed.length === 0) return 0;
  const importIds = [...new Set(failed.map((f) => f.importId))];
  const writes: BatchItem<"sqlite">[] = [];
  for (const part of chunks(failed.map((f) => f.id))) {
    writes.push(
      db
        .update(job)
        .set({ status: "queued", attempt: 0, error: null, finishedAt: null, leaseExpiresAt: null })
        .where(inArray(job.id, part)),
    );
  }
  writes.push(
    db
      .update(imports)
      .set({ status: "extracting", jobsFailed: 0, finishedAt: null, summary: null })
      .where(inArray(imports.id, importIds)),
  );
  await runBatch(db, writes);
  return failed.length;
}

// --- Worker, cron, pages ---------------------------------------------------------------------

export async function recordHeartbeat(db: Db, hb: Heartbeat, now: number): Promise<void> {
  await db.insert(event).values(eventRow("worker_heartbeat", { ...hb }, now));
}

export async function getWorkerStatus(db: Db, now: number): Promise<WorkerStatus> {
  const [[open], [beat]] = await Promise.all([
    db
      .select({ n: count() })
      .from(job)
      .where(inArray(job.status, [...OPEN_JOB])),
    db
      .select({ at: max(event.at) })
      .from(event)
      .where(eq(event.type, "worker_heartbeat")),
  ]);
  return workerStatus(open?.n ?? 0, beat?.at ?? null, now);
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * `GET /api/cron/daily`: expire stale queue items (§4.7), requeue expired leases, prune events
 * older than `config.events.retainDays`.
 */
export async function runDaily(db: Db, now: number) {
  const leases = await sweepExpiredLeases(db, now);
  const queued = await db.select().from(phrase).where(eq(phrase.status, "queued"));
  const expire = expiredPhraseIds(queued, now);
  const writes: BatchItem<"sqlite">[] = chunks(expire).map((part) =>
    db.update(phrase).set({ status: "expired", updatedAt: now }).where(inArray(phrase.id, part)),
  );
  await runBatch(db, writes);
  const pruned = await db.delete(event).where(lt(event.at, now - config.events.retainDays * DAY));
  return {
    leases_requeued: leases.requeued,
    leases_failed: leases.failed,
    phrases_expired: expire.length,
    events_pruned: pruned.rowsAffected,
  };
}

export interface FailedJobRow {
  id: string;
  importId: string;
  error: string | null;
  attempt: number;
  prompt: string;
}

/** The Imports page: recent imports and the failed jobs (with the start of their prompt). */
export async function getImportsPage(db: Db) {
  const [recent, failed] = await Promise.all([
    db.select().from(imports).orderBy(desc(imports.createdAt)).limit(config.imports.recentCount),
    db
      .select({ job, userText: turn.userText, replyText: turn.replyText })
      .from(job)
      .innerJoin(turn, sql`${turn.id} = json_extract(${job.input}, '$.turn_id')`)
      .where(eq(job.status, "failed"))
      .orderBy(desc(job.finishedAt)),
  ]);
  const failedJobs: FailedJobRow[] = failed.map((f) => ({
    id: f.job.id,
    importId: f.job.importId,
    error: f.job.error,
    attempt: f.job.attempt,
    prompt: (f.userText || f.replyText).slice(0, 80),
  }));
  return { recent, failedJobs };
}
