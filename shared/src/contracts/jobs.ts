// Worker ↔ engine (DESIGN §3.2), all with the WORKER token.
import { z } from "zod";
import { ExtractTurnInput } from "./extract";

export const JOB_TYPES = ["extract_turn"] as const;

/** `POST /api/jobs/claim` → 200 with this, or 204 when nothing is queued. */
export const ClaimedJob = z.object({
  job_id: z.string(),
  type: z.enum(JOB_TYPES),
  /** 1 on the first claim; echo it back on complete. */
  attempt: z.number().int().min(1),
  lease_expires_at: z.number().int(),
  input: ExtractTurnInput,
});
export type ClaimedJob = z.infer<typeof ClaimedJob>;

const completeBase = {
  job_id: z.string(),
  attempt: z.number().int().min(1),
  model: z.string().max(200).nullish(),
  prompt_version: z.string().max(100).nullish(),
  /** Model time for this attempt, for the `extraction` event. */
  latency_ms: z.number().int().min(0).nullish(),
  /** The worker needed its repair turn to get valid output. */
  repaired: z.boolean().nullish(),
};

/**
 * `POST /api/jobs/complete`. `result` is checked against `ExtractTurnResult` by the engine too; an
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
});
export type Heartbeat = z.infer<typeof Heartbeat>;
