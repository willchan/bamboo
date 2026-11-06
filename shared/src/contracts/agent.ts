// Engine → OpenClaw command automations (DESIGN §5.1), with the AGENT token.
import { z } from "zod";
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
