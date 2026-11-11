// Hand-added and edited phrases: the editor's input contract, card creation (DESIGN §4.8) and the
// derived fields every phrase carries (normalized hanzi, key, pinyin, score, flags).
import {
  CARD_TYPES,
  PHRASE_KINDS,
  type CardType,
  type PhraseKind,
  type TurnKind,
} from "@bamboo/db";
import { hanziKey, hasHanzi, normalizeText } from "@bamboo/shared";
import { z } from "zod";
import { config } from "../config";
import { baseScore, isLong } from "./queue";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .optional()
    .transform((s) => s ?? null);

export const PhraseInput = z.object({
  kind: z.enum(PHRASE_KINDS),
  hanzi: z
    .string()
    .transform((s) => normalizeText(s).replace(/\n+/gu, " "))
    .pipe(
      z
        .string()
        .min(1, "Enter the Chinese.")
        .max(200)
        .refine(hasHanzi, "The Chinese must contain at least one character."),
    ),
  english: z.string().trim().min(1, "Enter the English meaning or intent.").max(300),
  heardAs: optionalText(80),
  note: optionalText(500),
  tags: z
    .array(z.string())
    .default([])
    .transform((tags) => [
      ...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
    ]),
  examples: z
    .array(z.object({ hanzi: z.string(), english: z.string().nullable().optional() }))
    .default([])
    .transform((xs) =>
      xs
        .map((x) => ({
          hanzi: normalizeText(x.hanzi).replace(/\n+/gu, " "),
          english: x.english?.trim() || null,
          turn_id: null,
        }))
        .filter((x) => hasHanzi(x.hanzi)),
    )
    .pipe(z.array(z.any()).max(config.phrase.maxExamples, "At most 3 examples.")),
  cardTypes: z.array(z.enum(CARD_TYPES)).min(1, "Keep at least one card type."),
  /** One syllable input per character of the *submitted* hanzi; blank = computed. */
  pinyinEdits: z.array(z.string().nullable()).optional(),
});
export type PhraseInput = z.output<typeof PhraseInput>;
export type PhraseInputRaw = z.input<typeof PhraseInput>;

/**
 * The card types a phrase starts with (§4.8): a term from a decode turn gets Listen; any other
 * term, frame or sentence gets Say. The editor can add the other type.
 */
export function initialCardTypes(kind: PhraseKind, turnKind: TurnKind | null): CardType[] {
  return kind === "term" && turnKind === "decode" ? ["listen"] : ["say"];
}

/** Examples are for terms only (DESIGN §2.1); other kinds keep none. */
export const examplesFor = <T>(kind: PhraseKind, examples: T[]): T[] =>
  kind === "term" ? examples : [];

/** Derived fields: key, score and the `long` flag, from the scoring inputs. */
export function derivedFields(p: {
  kind: PhraseKind;
  hanzi: string;
  turnKind: TurnKind | null;
  heardAs: string | null;
  askedCount: number;
  usefulness: number | null;
  tags: string[];
  flags: string[];
}) {
  const key = hanziKey(p.hanzi);
  const long = isLong(key);
  const flags = p.flags.filter((f) => f !== "long");
  if (long) flags.push("long");
  return {
    hanziKey: key,
    baseScore: baseScore({ ...p, hanziKey: key }),
    flags,
  };
}
