// `bamboo-tools` → engine (DESIGN §3.2), all with the AGENT token.
import { z } from "zod";
import { sharedConfig } from "../config";
import { IMPORT_KINDS } from "../turns";

export const IMPORT_ORIGINS = ["discord", "web"] as const;

/** `POST /api/imports/known`: which of these turn keys does the engine not have yet? */
export const KnownRequest = z.object({
  turn_keys: z.array(z.string().min(1).max(128)).max(sharedConfig.imports.maxKnownKeys),
});
export type KnownRequest = z.infer<typeof KnownRequest>;

export const KnownResponse = z.object({
  /** The keys from the request the engine has no turn for, in request order, deduplicated. */
  unknown: z.array(z.string()),
});
export type KnownResponse = z.infer<typeof KnownResponse>;

export const ImportTurn = z.object({
  /** Will's prompt as typed; empty for an image-only prompt or a pasted answer. */
  user_text: z.string().default(""),
  /** Gemini's reply (flattened for links). The engine caps it after computing the key. */
  reply_text: z.string().min(1),
  /** Index of the turn within the conversation (0-based). */
  position: z.number().int().min(0),
});
export type ImportTurn = z.infer<typeof ImportTurn>;

/**
 * `POST /api/imports`. The first call creates the import; later chunks pass `import_id` (the
 * metadata fields are then ignored). Every call but the last sets `more: true`, so the import isn't
 * reported done while chunks are still arriving. Send header `Idempotency-Key: discord:<message
 * id>` on every call: a retried first call returns the same import.
 */
export const ImportRequest = z.object({
  import_id: z.string().min(1).optional(),
  kind: z.enum(IMPORT_KINDS),
  origin: z.enum(IMPORT_ORIGINS),
  source_ref: z.string().max(2000).nullish(),
  conversation_title: z.string().max(500).nullish(),
  discord_channel_id: z.string().max(64).nullish(),
  discord_message_id: z.string().max(64).nullish(),
  /** Turns in the whole conversation, known ones included ("88 questions, 2 new"). */
  turns_total: z.number().int().min(0),
  /** Only the turns `known` reported unknown (the engine re-checks). */
  turns: z.array(ImportTurn),
  /** More chunks of this import follow. Default false. */
  more: z.boolean().default(false),
});
export type ImportRequest = z.input<typeof ImportRequest>;

export const ImportResponse = z.object({
  import_id: z.string(),
  /** New turns in the whole import so far (every chunk, retries counted once). */
  turns_new: z.number().int(),
  /** New turns this call added. */
  turns_added: z.number().int(),
});
export type ImportResponse = z.infer<typeof ImportResponse>;
