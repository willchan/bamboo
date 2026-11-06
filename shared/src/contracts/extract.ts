// The `extract_turn` job (DESIGN §5.3): what the worker gets, and what the model must return.
import { z } from "zod";
import { sharedConfig } from "../config";

export const TURN_KINDS = ["decode", "say", "errand", "other"] as const;
export const ITEM_KINDS = ["term", "frame", "sentence"] as const;

export const ExtractTurnInput = z.object({
  turn_id: z.string(),
  conversation_title: z.string().nullable(),
  user_text: z.string(),
  reply_text: z.string(),
});
export type ExtractTurnInput = z.infer<typeof ExtractTurnInput>;

export const ExtractItem = z.object({
  kind: z.enum(ITEM_KINDS),
  /** Copied exactly from the turn; frames use `…` for the slot. */
  hanzi: z.string().min(1).max(200),
  english: z.string().min(1).max(sharedConfig.extraction.maxEnglishChars),
  addressee: z.string().max(40).nullable(),
  /** Decode turns only: Will's guess, copied from his message. */
  heard_as: z.string().max(80).nullable(),
  /** Terms only: a sentence from the reply that uses the term, copied exactly. */
  example: z
    .object({ hanzi: z.string().min(1).max(200), english: z.string().max(300).nullable() })
    .nullable(),
  usefulness: z.number().int().min(1).max(5),
  tags: z.array(z.string().max(40)).max(10),
});
export type ExtractItem = z.infer<typeof ExtractItem>;

export const ExtractTurnResult = z.object({
  turn_kind: z.enum(TURN_KINDS),
  items: z.array(ExtractItem).max(sharedConfig.extraction.maxItems),
});
export type ExtractTurnResult = z.infer<typeof ExtractTurnResult>;
