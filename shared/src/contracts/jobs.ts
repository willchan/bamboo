// Worker ↔ engine (DESIGN §3.2), all with the WORKER token.
import { z } from "zod";
import { sharedConfig } from "../config";
import { ExtractTurnInput } from "./extract";

export const JOB_TYPES = ["extract_turn", "pinyin"] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * `POST /api/jobs/claim` body (optional): the job types this worker can run now. Without it
 * (an older worker), only `extract_turn`. The worker leaves out `pinyin` while Gemini is off or
 * resting, since a pinyin job is Gemini's reading (DESIGN §5.5.3).
 *
 * `reextract_only` (H7's backfill worker on the paid key, DESIGN §5.5.6): never offer an
 * ordinary extract_turn job, only `pinyin` jobs and re-runs (§4.6.1), so new imports wait for the
 * everyday worker on the free key.
 */
export const ClaimRequest = z.object({
  types: z.array(z.enum(JOB_TYPES)).min(1).max(JOB_TYPES.length).optional(),
  reextract_only: z.boolean().optional(),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

/** One character of a `pinyin` job's phrase: its computed reading and its valid readings. */
export const PinyinSlot = z.object({
  char: z.string().min(1).max(4),
  /** The computed (dictionary) reading; null for anything that isn't hanzi. */
  computed: z.string().max(12).nullable(),
  /** pinyin-pro's readings of the character (`multiple: true`), the computed one included. */
  readings: z.array(z.string().max(12)).max(12),
});
export type PinyinSlot = z.infer<typeof PinyinSlot>;

/**
 * A `pinyin` job (DESIGN §5.5.3b): Gemini's reading of a hand-added, edited or fallback-extracted
 * phrase (when `gemini` is null), then the referee for real disputes. `context` is the phrase's
 * own examples, which come from its turn or from Will.
 */
export const PinyinJobInput = z.object({
  phrase_id: z.string(),
  hanzi: z.string().min(1).max(200),
  context: z.array(z.string().max(200)).max(sharedConfig.pinyin.maxContextExamples),
  slots: z.array(PinyinSlot).max(200),
  /** Gemini's reading from the extraction, when it had one: then only the referee runs. */
  gemini: z.array(z.string().max(12)).max(200).nullable(),
});
export type PinyinJobInput = z.infer<typeof PinyinJobInput>;

/** What the worker sends back: Gemini's reading (if it asked) and the referee's choices. */
export const PinyinJobResult = z.object({
  gemini: z.array(z.string().max(12)).max(200).nullable(),
  /** The referee's reading per disputed slot (by index into `slots`); empty if none. */
  referee: z
    .array(z.object({ index: z.number().int().min(0), reading: z.string().max(12) }))
    .max(200),
});
export type PinyinJobResult = z.infer<typeof PinyinJobResult>;

const claimedBase = {
  job_id: z.string(),
  /** 1 on the first claim; echo it back on complete. */
  attempt: z.number().int().min(1),
  lease_expires_at: z.number().int(),
};

/** `POST /api/jobs/claim` → 200 with this, or 204 when nothing is queued. */
export const ClaimedJob = z.discriminatedUnion("type", [
  z.object({ ...claimedBase, type: z.literal("extract_turn"), input: ExtractTurnInput }),
  z.object({ ...claimedBase, type: z.literal("pinyin"), input: PinyinJobInput }),
]);
export type ClaimedJob = z.infer<typeof ClaimedJob>;
export type ClaimedExtractJob = Extract<ClaimedJob, { type: "extract_turn" }>;
export type ClaimedPinyinJob = Extract<ClaimedJob, { type: "pinyin" }>;

const completeBase = {
  job_id: z.string(),
  attempt: z.number().int().min(1),
  model: z.string().max(200).nullish(),
  prompt_version: z.string().max(100).nullish(),
  /** Model time for this attempt, for the `extraction` event. */
  latency_ms: z.number().int().min(0).nullish(),
  /** The worker needed its repair turn to get valid output. */
  repaired: z.boolean().nullish(),
  /**
   * Things the worker's name filter (DESIGN §5.5.8) dropped or rewrote before posting: a count,
   * never the names.
   */
  dropped_name: z.number().int().min(0).nullish(),
};

/**
 * `POST /api/jobs/complete`. `result` is checked against `ExtractTurnResult` (or, for a `pinyin`
 * job, `PinyinJobResult`) by the engine too; an
 * invalid one counts as a failed attempt (422). A stale `attempt` (the lease expired and the job
 * was requeued or claimed again) gets 409 and changes nothing.
 */
export const CompleteRequest = z.discriminatedUnion("status", [
  z.object({ ...completeBase, status: z.literal("done"), result: z.unknown() }),
  z.object({ ...completeBase, status: z.literal("failed"), error: z.string().max(2000) }),
]);
export type CompleteRequest = z.input<typeof CompleteRequest>;

export const CompleteResponse = z.object({
  /** The job's state after this call: `queued` means it will be retried. */
  job_status: z.enum(["queued", "done", "failed"]),
});
export type CompleteResponse = z.infer<typeof CompleteResponse>;

/** `POST /api/worker/heartbeat` → 204. Logged as a `worker_heartbeat` event. */
export const Heartbeat = z.object({
  version: z.string().max(100),
  sha: z.string().max(100).nullish(),
  model: z.string().max(200).nullish(),
  ollama_ok: z.boolean(),
  /** From H4: the Gemini model, and whether Gemini is usable now (key set, not resting). */
  gemini_model: z.string().max(200).nullish(),
  gemini_ok: z.boolean().nullish(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;
