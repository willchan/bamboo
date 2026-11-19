// The `extract_turn` job (DESIGN §5.3): what the worker gets, and what the model must return.
import { z } from "zod";
import { sharedConfig } from "../config";
import { PhraseBreakdown } from "./breakdown";

export const TURN_KINDS = ["decode", "say", "errand", "other"] as const;
export const ITEM_KINDS = ["term", "frame", "sentence"] as const;
/** What extract_turn.v4 asks for: no frames (DESIGN §10 #77). */
export const V4_ITEM_KINDS = ["term", "sentence"] as const;
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

export const ExtractExample = z.object({
  hanzi: z.string().min(1).max(200),
  english: z.string().max(300).nullable(),
});
export type ExtractExample = z.infer<typeof ExtractExample>;

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
  example: ExtractExample.nullable(),
  /**
   * extract_turn.v4 (H4): more than one example per term, each copied exactly. When present it is
   * used instead of `example` (the worker sends `example` too: its first entry).
   */
  examples: z.array(ExtractExample).max(sharedConfig.extraction.maxExamplesPerItem).nullish(),
  /**
   * extract_turn.v4 on Gemini: Gemini's reading, one syllable per Chinese character of `hanzi`,
   * in order. Never stored as such: the engine merges it with the computed reading (DESIGN
   * §5.5.3). Absent for Ollama results (the fallback), which keep the computed reading until a
   * `pinyin` job has run.
   */
  pinyin: z.array(z.string().min(1).max(12)).max(200).nullish(),
  usefulness: z.number().int().min(1).max(5),
  tags: z.array(z.string().max(40)).max(10),
  /**
   * extract_turn.v4 (H4): the card back's breakdown (DESIGN §5.5.4). Optional: older prompts don't
   * ask for it. The engine keeps it only if it matches the item's hanzi exactly.
   */
  breakdown: PhraseBreakdown.nullish(),
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
      // extract_turn.v3's shape; v4 has its own (`ModelExtractTurnResultV4`).
      ExtractItem.omit({ addressee: true, breakdown: true, examples: true, pinyin: true }).extend({
        note: z.string().max(sharedConfig.extraction.maxNoteChars).nullable(),
        tags: z.array(z.enum(PHRASE_TAGS)).max(sharedConfig.extraction.maxTags),
      }),
    )
    .max(sharedConfig.extraction.maxItems),
});

const { maxGlossChars, maxBreakdownSummaryChars, maxBreakdownParts } = sharedConfig.extraction;

/**
 * extract_turn.v4's output schema (DESIGN §5.5.2), sent to Gemini (`responseJsonSchema`) and to
 * Ollama (`format`) alike: terms and sentences only, several verbatim examples, Gemini's pinyin per
 * character, and the card back's breakdown with one `summary` (a term's meaning, a sentence's
 * note), so the schema needs no union. The worker turns it into `ExtractTurnResult`
 * (`fromModelV4` in the worker).
 */
export const ModelExtractItemV4 = z.object({
  kind: z.enum(V4_ITEM_KINDS),
  hanzi: z.string().min(1).max(200),
  english: z.string().min(1).max(sharedConfig.extraction.maxEnglishChars),
  note: z.string().max(sharedConfig.extraction.maxNoteChars).nullable(),
  heard_as: z.string().max(80).nullable(),
  examples: z.array(ExtractExample).max(sharedConfig.extraction.maxExamplesPerItem),
  usefulness: z.number().int().min(1).max(5),
  tags: z.array(z.enum(PHRASE_TAGS)).max(sharedConfig.extraction.maxTags),
  pinyin: z.array(z.string().min(1).max(12)).max(200),
  breakdown: z
    .object({
      parts: z
        .array(
          z.object({
            hanzi: z.string().min(1).max(40),
            gloss: z.string().min(1).max(maxGlossChars),
          }),
        )
        .min(1)
        .max(maxBreakdownParts),
      summary: z.string().min(1).max(maxBreakdownSummaryChars),
    })
    .nullable(),
});
export type ModelExtractItemV4 = z.infer<typeof ModelExtractItemV4>;

export const ModelExtractTurnResultV4 = z.object({
  turn_kind: z.enum(TURN_KINDS),
  items: z.array(ModelExtractItemV4).max(sharedConfig.extraction.maxItems),
});
export type ModelExtractTurnResultV4 = z.infer<typeof ModelExtractTurnResultV4>;
