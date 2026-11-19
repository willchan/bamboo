// Engine → OpenClaw command automations (DESIGN §5.1), with the AGENT token.
import { z } from "zod";
import { sharedConfig } from "../config";
import { IMPORT_KINDS } from "../turns";

/** One finished Discord import waiting for its reply. */
export const Notification = z.object({
  import_id: z.string(),
  kind: z.enum(IMPORT_KINDS),
  discord_channel_id: z.string().nullable(),
  discord_message_id: z.string(),
  /** Ready to post as is (it includes the public-link reminder for link imports). */
  summary: z.string(),
});
export type Notification = z.infer<typeof Notification>;

/**
 * `GET /api/agent/notifications`. Post each `summary` as a reply to its message, then
 * `POST /api/imports/{import_id}/notified` (→ 204; idempotent).
 */
export const NotificationsResponse = z.object({ notifications: z.array(Notification) });
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;

/** `GET /api/agent/nudge` (M6): the reminder text, or null for nothing to send. */
export const NudgeResponse = z.object({ text: z.string().nullable() });
export type NudgeResponse = z.infer<typeof NudgeResponse>;

/**
 * `POST /api/agent/reextract` (H6, DESIGN §3.2, §5.5.6): queue re-runs (§4.6.1) from the Mac, for
 * H7's backfill. `all` also takes turns already on the newest prompt that no re-run has read with
 * it; `limit` takes at most that many, oldest first. Each turn is one job, claimed after ordinary
 * jobs. Running it again while they're open queues nothing more.
 */
export const ReextractRequest = z
  .object({
    all: z.boolean().default(false),
    limit: z.number().int().min(1).max(sharedConfig.reextract.maxLimit).optional(),
  })
  .strict();
export type ReextractRequest = z.infer<typeof ReextractRequest>;

/** How many turns were queued, and how many re-runs are now open in all. */
export const ReextractResponse = z.object({
  queued: z.number().int(),
  open: z.number().int(),
});
export type ReextractResponse = z.infer<typeof ReextractResponse>;

/** `GET /api/agent/backfill?since=<ms>` (H7, DESIGN §5.5.6): counts only, never text. */
export const BackfillQuery = z.object({
  /** Re-run results finished at or after this time (ms since the epoch) are summed. */
  since: z.coerce.number().int().min(0).default(0),
});
export type BackfillQuery = z.infer<typeof BackfillQuery>;

const count = z.number().int().min(0);

/**
 * The backfill's counts (H7). `turns` describes every stored turn now; `run` sums the re-run
 * `extraction` events, `pinyin_disagreement` events and finished `pinyin` jobs since `since`;
 * `review` is for the before/after check (cards and history must survive).
 */
export const BackfillReport = z.object({
  since: count,
  newest_prompt: z.string().nullable(),
  turns: z.object({
    stored: count,
    /** Turns whose latest finished job ran on `newest_prompt`. */
    on_newest_prompt: count,
    /** Of those, read by a re-run (what a full backfill finishes). */
    reread_on_newest_prompt: count,
    /** Turns a full run (`{all: true}`) would queue now. */
    remaining: count,
    /** Turns with no finished job at all (every job failed): Retry failed first. */
    no_finished_job: count,
    open_reextract: count,
    /** `reply_text` exactly at the import cap (`replyMaxChars`): likely cut. */
    reply_at_cap: count,
    reply_max_chars: count,
  }),
  run: z.object({
    turns: count,
    /** Re-run jobs that failed for good (every attempt used). */
    failed: count,
    /** Items Gemini returned, per turn, in finish order. */
    items_per_turn: z.array(count),
    items: count,
    kept: count,
    dropped: z.record(z.string(), count),
    phrases_created: count,
    phrases_refreshed: count,
    phrases_dropped: count,
    phrases_reported: count,
    pinyin_jobs_queued: count,
    pinyin_misaligned: count,
    pinyin_disagreements: count,
    pinyin_jobs_done: count,
    pinyin_jobs_failed: count,
    referee_calls: count,
    /** Re-run turns by the model that read them (Gemini's or the Ollama fallback's). */
    models: z.record(z.string(), count),
  }),
  phrases_reported_open: count,
  review: z.object({ review_log_rows: count, reviewed_cards: count }),
});
export type BackfillReport = z.infer<typeof BackfillReport>;
