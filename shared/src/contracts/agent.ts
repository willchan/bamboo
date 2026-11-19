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
