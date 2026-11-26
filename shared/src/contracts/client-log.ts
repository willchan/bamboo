// `POST /api/client-log` (DESIGN §8.5): the PWA reports why something failed on the phone, so a
// failure leaves a line in Vercel's logs. Fixed fields only: never phrase text, ids, URLs with
// ids, or an error's message (it can quote what Will typed).
import { z } from "zod";

/** Where on the phone it failed. */
export const CLIENT_LOG_WHERE = [
  "save",
  "resend",
  "window",
  "render",
  "version",
  // A neural clip failed and Web Speech spoke instead (DESIGN §6.1).
  "tts_fallback",
] as const;
/**
 * What kind of failure: `stale` = the page is from an older deploy than the server (its server
 * actions are gone); `offline` = the request never got an answer; `server` = the server answered
 * with an error; `other` = anything else.
 */
export const CLIENT_LOG_KINDS = ["stale", "offline", "server", "other"] as const;

/** A short identifier: an error's class name, Next's digest, a build id. */
const Token = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]*$/u);

export const ClientLogEntry = z
  .object({
    where: z.enum(CLIENT_LOG_WHERE),
    kind: z.enum(CLIENT_LOG_KINDS),
    /** The error's class name (`TypeError`, `UnrecognizedActionError`). */
    name: Token.optional(),
    /** Next.js's digest of a server error, to find its server-side log line. */
    digest: Token.optional(),
    /** Attempts made before giving up (saves). */
    attempts: z.number().int().min(0).max(100).optional(),
    /** The page's build (NEXT_PUBLIC_BUILD_ID). */
    build: Token,
    /** The page's first path segment only (`/review`, `/phrases`, `/`): no ids. */
    page: z
      .string()
      .max(32)
      .regex(/^\/[a-z-]*$/u),
    /** navigator.onLine when it failed. */
    online: z.boolean().optional(),
  })
  .strict();
export type ClientLogEntry = z.infer<typeof ClientLogEntry>;
