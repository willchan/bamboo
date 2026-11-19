// The card back's breakdown (DESIGN §5.5.4): what Gemini writes (H4) and the engine stores in
// `phrase.breakdown` once it passes the exact-match rule (`web/lib/domain/breakdown.ts`).
import { z } from "zod";
import { sharedConfig } from "../config";

const { maxBreakdownParts, maxGlossChars, maxBreakdownSummaryChars } = sharedConfig.extraction;

/** One character (terms) or word (sentences), copied from the phrase, with a short English gloss. */
export const BreakdownPart = z.object({
  hanzi: z.string().min(1).max(40),
  gloss: z.string().min(1).max(maxGlossChars),
});
export type BreakdownPart = z.infer<typeof BreakdownPart>;

const parts = z.array(BreakdownPart).min(1).max(maxBreakdownParts);

/** A term: one part per character, then the word's overall meaning. */
export const TermBreakdown = z.object({
  parts,
  meaning: z.string().min(1).max(maxBreakdownSummaryChars),
});
export type TermBreakdown = z.infer<typeof TermBreakdown>;

/** A sentence: one part per word, then one short note on how the sentence is built. */
export const SentenceBreakdown = z.object({
  parts,
  note: z.string().min(1).max(maxBreakdownSummaryChars),
});
export type SentenceBreakdown = z.infer<typeof SentenceBreakdown>;

/**
 * Either shape. No pinyin: each part's pinyin is sliced from the phrase's displayed pinyin, so it
 * always matches the card (DESIGN §5.5.3).
 */
export const PhraseBreakdown = z.union([TermBreakdown, SentenceBreakdown]);
export type PhraseBreakdown = z.infer<typeof PhraseBreakdown>;
