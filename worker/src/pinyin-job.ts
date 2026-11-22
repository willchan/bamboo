// A `pinyin` job on Gemini (DESIGN §5.5.3b): Gemini's reading of one phrase (unless the job
// already carries the extraction's), then, only for real disputes (both readings valid, and
// different), one referee call choosing among that character's options. The engine re-checks
// every answer; this side only decides whether the referee is needed. Since §10 #107 the job's
// examples are read and refereed in the same two calls. The requests carry the prompt, the phrase
// and its own examples: nothing else (§5.5.8).
import {
  alignGemini,
  disputedSlots,
  refereeOptions,
  type PinyinJobExample,
  type PinyinJobInput,
  type PinyinJobResult,
  type PinyinSlot,
} from "@bamboo/shared";
import { z } from "zod";
import { askJson, parseReply, type ChatModel } from "./extract";
import { fill, type Prompt } from "./prompt";

/** A reply's arrays hold at most this many entries (cut, not refused: Gemini's schema has no max). */
const MAX_ENTRIES = 200;
const Syllables = z.array(z.string().min(1).max(12)).max(MAX_ENTRIES);
/** pinyin_reading.v2: the phrase's reading, and each numbered example's (§10 #107). */
export const ReadingReply = z.object({
  pinyin: Syllables,
  examples: z
    .array(z.object({ sentence: z.number().int().min(0), pinyin: Syllables }))
    .max(MAX_ENTRIES),
});
/** pinyin_referee.v2: a choice per listed character, in the phrase (sentence 0) or an example. */
export const RefereeReply = z.object({
  choices: z
    .array(
      z.object({
        sentence: z.number().int().min(0),
        index: z.number().int().min(0),
        reading: z.string().min(1).max(12),
      }),
    )
    .max(MAX_ENTRIES),
});
const READING_SCHEMA = z.toJSONSchema(ReadingReply) as Record<string, unknown>;
const REFEREE_SCHEMA = z.toJSONSchema(RefereeReply) as Record<string, unknown>;

export interface PinyinPrompts {
  reading: Prompt;
  referee: Prompt;
}

export type PinyinRun =
  | {
      ok: true;
      result: PinyinJobResult;
      /** The prompts that ran, e.g. `pinyin_reading.v2+pinyin_referee.v2`. */
      promptVersion: string;
      repaired: boolean;
      latencyMs: number;
    }
  | { ok: false; error: string; latencyMs: number; modelError?: Error; repaired: boolean };

/** The phrase's examples, numbered from 1 (the phrase is sentence 0 for the referee). */
export const contextText = (input: Pick<PinyinJobInput, "context">) =>
  input.context.length ? input.context.map((c, i) => `${i + 1}: ${c}`).join("\n") : "(none)";

/** A job example's sentence number in the prompts. */
const sentenceOf = (e: Pick<PinyinJobExample, "index">) => e.index + 1;

type Choices = PinyinJobResult["referee"];

/**
 * Run one `pinyin` job: a reading call when the phrase (unless `phrase_settled`) or one of the
 * job's examples has no Gemini reading yet, then one referee call for every real dispute, in the
 * phrase and its examples together. At most two requests per job.
 */
export async function runPinyinJob(
  model: ChatModel,
  prompts: PinyinPrompts,
  input: PinyinJobInput,
  now: () => number = Date.now,
): Promise<PinyinRun> {
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const versions: string[] = [];
  let repaired = false;
  const values = { hanzi: input.hanzi, context: contextText(input) };
  const jobExamples = input.examples ?? [];
  const settled = input.phrase_settled === true;

  let gemini = input.gemini;
  let asked: string[] | null = null;
  const exGemini = new Map(jobExamples.map((e) => [e.index, e.gemini]));
  const askedEx = new Map<number, string[]>();
  if ((gemini === null && !settled) || jobExamples.some((e) => e.gemini === null)) {
    const p = prompts.reading;
    versions.push(p.version);
    const r = await askJson(
      model,
      [
        { role: "system", content: p.system },
        { role: "user", content: fill(p.user, values) },
      ],
      READING_SCHEMA,
      (c) => parseReply(c, ReadingReply, MAX_ENTRIES),
      (errors) => fill(p.repair, { errors }),
    );
    repaired ||= r.repaired;
    if (!r.ok)
      return {
        ok: false,
        error: r.error,
        latencyMs: elapsed(),
        modelError: r.modelError,
        repaired,
      };
    if (gemini === null && !settled) {
      gemini = r.value.pinyin;
      asked = r.value.pinyin;
    }
    for (const e of jobExamples) {
      if (e.gemini !== null) continue;
      const got = r.value.examples.find((x) => x.sentence === sentenceOf(e));
      if (!got) continue;
      exGemini.set(e.index, got.pinyin);
      askedEx.set(e.index, got.pinyin);
    }
  }

  // Every real dispute, by sentence (0 is the phrase) and slot.
  const asks = new Map<number, { slots: PinyinSlot[]; disputes: number[] }>();
  if (!settled) {
    const d = disputedSlots(input.slots, alignGemini(input.slots, gemini));
    if (d.length) asks.set(0, { slots: input.slots, disputes: d });
  }
  for (const e of jobExamples) {
    const d = disputedSlots(e.slots, alignGemini(e.slots, exGemini.get(e.index)));
    if (d.length) asks.set(sentenceOf(e), { slots: e.slots, disputes: d });
  }
  const chosen = new Map<number, Choices>([...asks.keys()].map((k) => [k, []]));
  if (asks.size) {
    const p = prompts.referee;
    versions.push(p.version);
    const lines = [...asks]
      .flatMap(([n, a]) =>
        a.disputes.map(
          (i) => `${n}, ${i}: ${a.slots[i]!.char} → ${refereeOptions(a.slots[i]!).join(" | ")}`,
        ),
      )
      .join("\n");
    const r = await askJson(
      model,
      [
        { role: "system", content: p.system },
        { role: "user", content: fill(p.user, { ...values, disputes: lines }) },
      ],
      REFEREE_SCHEMA,
      (c) => {
        const x = parseReply(c, RefereeReply, MAX_ENTRIES);
        return x.ok ? { ok: true, value: x.value.choices } : x;
      },
      (errors) => fill(p.repair, { errors }),
    );
    repaired ||= r.repaired;
    if (!r.ok)
      return {
        ok: false,
        error: r.error,
        latencyMs: elapsed(),
        modelError: r.modelError,
        repaired,
      };
    // Only answers for the slots asked about; the engine checks each against the options.
    for (const c of r.value) {
      if (asks.get(c.sentence)?.disputes.includes(c.index))
        chosen.get(c.sentence)!.push({ index: c.index, reading: c.reading });
    }
  }

  const result: PinyinJobResult = { gemini: asked, referee: chosen.get(0) ?? [] };
  if (input.examples)
    result.examples = jobExamples.map((e) => ({
      index: e.index,
      gemini: askedEx.get(e.index) ?? null,
      referee: chosen.get(sentenceOf(e)) ?? [],
    }));
  return {
    ok: true,
    result,
    promptVersion: versions.join("+") || "none",
    repaired,
    latencyMs: elapsed(),
  };
}
