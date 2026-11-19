// A `pinyin` job on Gemini (DESIGN §5.5.3b): Gemini's reading of one phrase (unless the job
// already carries the extraction's), then, only for real disputes (both readings valid, and
// different), one referee call choosing among that character's options. The engine re-checks
// every answer; this side only decides whether the referee is needed. The requests carry the
// prompt, the phrase and its own examples: nothing else (§5.5.8).
import {
  alignGemini,
  disputedSlots,
  refereeOptions,
  type PinyinJobInput,
  type PinyinJobResult,
} from "@bamboo/shared";
import { z } from "zod";
import { askJson, parseReply, type ChatModel } from "./extract";
import { fill, type Prompt } from "./prompt";

/** A reply's arrays hold at most this many entries (cut, not refused: Gemini's schema has no max). */
const MAX_ENTRIES = 200;
export const ReadingReply = z.object({
  pinyin: z.array(z.string().min(1).max(12)).max(MAX_ENTRIES),
});
export const RefereeReply = z.object({
  choices: z
    .array(z.object({ index: z.number().int().min(0), reading: z.string().min(1).max(12) }))
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
      /** The prompts that ran, e.g. `pinyin_reading.v1+pinyin_referee.v1`. */
      promptVersion: string;
      repaired: boolean;
      latencyMs: number;
    }
  | { ok: false; error: string; latencyMs: number; modelError?: Error; repaired: boolean };

const contextText = (input: PinyinJobInput) =>
  input.context.length ? input.context.join("\n") : "(none)";

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

  let gemini = input.gemini;
  let asked: string[] | null = null;
  if (gemini === null) {
    const p = prompts.reading;
    versions.push(p.version);
    const r = await askJson(
      model,
      [
        { role: "system", content: p.system },
        { role: "user", content: fill(p.user, values) },
      ],
      READING_SCHEMA,
      (c) => {
        const x = parseReply(c, ReadingReply, MAX_ENTRIES);
        return x.ok ? { ok: true, value: x.value.pinyin } : x;
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
    gemini = r.value;
    asked = r.value;
  }

  const disputes = disputedSlots(input.slots, alignGemini(input.slots, gemini));
  const referee: PinyinJobResult["referee"] = [];
  if (disputes.length) {
    const p = prompts.referee;
    versions.push(p.version);
    const lines = disputes
      .map((i) => `${i}: ${input.slots[i]!.char} → ${refereeOptions(input.slots[i]!).join(" | ")}`)
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
    for (const c of r.value) if (disputes.includes(c.index)) referee.push(c);
  }

  return {
    ok: true,
    result: { gemini: asked, referee },
    promptVersion: versions.join("+") || "none",
    repaired,
    latencyMs: elapsed(),
  };
}
