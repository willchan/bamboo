// The `extract_turn` job (DESIGN §5.3): what the worker gets, and what the model must return.
import { z } from "zod";
import { sharedConfig } from "../config";

export const TURN_KINDS = ["decode", "say", "errand", "other"] as const;
export const ITEM_KINDS = ["term", "frame", "sentence"] as const;
/** The fixed tag list (the prompt lists the same tags). The engine drops any other tag. */
export const PHRASE_TAGS = [
  "feeding",
  "baby",
  "toddler",
  "food",
  "cooking",
  "groceries",
  "household",
  "cleaning",
  "units",
  "time",
  "family",
  "polite",
] as const;

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
  /**
   * extract_turn.v1 only; v2 doesn't ask for it (DESIGN §10 #63). Accepted so a worker on v1 keeps
   * working until it's updated, and ignored.
   */
  addressee: z.string().max(40).nullish(),
  /** v2: a short English note, only when the wording depends on who hears it. */
  note: z.string().max(sharedConfig.extraction.maxNoteChars).nullish(),
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

/**
 * The shape the worker asks Ollama for (its `format` schema): the contract without v1's
 * `addressee`, with `note` required (null when there's nothing to say, so the model decides on it
 * every time), and tags limited to `PHRASE_TAGS` and `maxTags`, so the model's grammar can't
 * invent one. The API keeps accepting the looser `ExtractTurnResult` (an older worker may still
 * send an addressee or other tags), and the engine filters tags itself (DESIGN §4.6).
 */
export const ModelExtractTurnResult = ExtractTurnResult.extend({
  items: z
    .array(
      ExtractItem.omit({ addressee: true }).extend({
        note: z.string().max(sharedConfig.extraction.maxNoteChars).nullable(),
        tags: z.array(z.enum(PHRASE_TAGS)).max(sharedConfig.extraction.maxTags),
      }),
    )
    .max(sharedConfig.extraction.maxItems),
});
