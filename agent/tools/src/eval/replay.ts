// Replay (DESIGN §5.4): each question through each local model, one model at a time. A model is
// loaded once (timed separately), answers every question, and is then unloaded with
// `keep_alive: 0`, unless it was already in memory when the run started (PandaClaw's 27B, say),
// which is left as it was found. The 32 GB Mac also runs PandaBase, so models never overlap.
import type { EvalTurnsResponse } from "@bamboo/shared";
import { tokensPerSec, type TutorOllama } from "./ollama";
import type { TutorPrompt } from "./prompt";
import type { AnswersFile } from "./types";

export function newAnswers(
  sample: EvalTurnsResponse,
  meta: Pick<AnswersFile, "run_id" | "seed" | "created_at" | "prompt_sha" | "ollama_url" | "think">,
): AnswersFile {
  return {
    version: 1,
    ...meta,
    models: [],
    load_ms: {},
    pool: sample.pool,
    questions: sample.turns.map((t, i) => ({
      id: `q${i + 1}`,
      turn_id: t.turn_id,
      import_id: t.import_id,
      question: t.user_text,
      gemini: t.reply_text,
      answers: {},
    })),
  };
}

export interface ReplayDeps {
  ollama: TutorOllama;
  prompt: TutorPrompt;
  /** Called after every answer with the whole file, so an interrupted run can resume. */
  save: (a: AnswersFile) => void;
  /** Progress lines: ids, models and timings only, never question or answer text. */
  log: (line: string) => void;
  now?: () => number;
}

/**
 * Fill in every (question, model) answer that is missing or failed. Mutates and returns `answers`.
 * Throws before doing anything if a model isn't pulled.
 */
export async function replay(
  answers: AnswersFile,
  models: readonly string[],
  deps: ReplayDeps,
): Promise<AnswersFile> {
  const { ollama, prompt, save, log } = deps;
  const now = deps.now ?? (() => performance.now());
  const missing = await ollama.missing(models);
  if (missing.length)
    throw new Error(`not pulled at ${ollama.url}: ${missing.join(", ")} (ollama pull <model>)`);
  for (const m of models) if (!answers.models.includes(m)) answers.models.push(m);
  const preloaded = await ollama.loaded();
  const n = answers.questions.length;

  for (const model of models) {
    const todo = answers.questions.filter((q) => {
      const a = q.answers[model];
      return !a || a.error !== null;
    });
    if (todo.length === 0) {
      log(`${model}: all ${n} answered already`);
      continue;
    }
    const keep = preloaded.has(model) || preloaded.has(`${model}:latest`);
    try {
      const t0 = now();
      try {
        await ollama.load(model);
      } catch (e) {
        // Out of memory, say: record it for every question and go on to the next model.
        const error = `load failed: ${(e as Error).message}`;
        for (const q of todo)
          q.answers[model] = {
            text: null,
            latency_ms: 0,
            eval_count: null,
            tokens_per_sec: null,
            error,
          };
        log(`${model}: ${error}`);
        save(answers);
        continue;
      }
      answers.load_ms[model] = Math.round(now() - t0);
      log(`${model}: loaded in ${(answers.load_ms[model]! / 1000).toFixed(1)} s`);
      for (const q of todo) {
        const start = now();
        try {
          const r = await ollama.answer(model, prompt.system, q.question);
          const ms = Math.round(now() - start);
          q.answers[model] = {
            text: r.text,
            latency_ms: ms,
            eval_count: r.evalCount,
            tokens_per_sec: tokensPerSec(r.evalCount, r.evalDurationNs),
            error: r.text.trim() ? null : "empty answer",
          };
        } catch (e) {
          q.answers[model] = {
            text: null,
            latency_ms: Math.round(now() - start),
            eval_count: null,
            tokens_per_sec: null,
            error: (e as Error).message,
          };
        }
        const a = q.answers[model]!;
        const tps = a.tokens_per_sec === null ? "" : `, ${a.tokens_per_sec} tok/s`;
        log(
          `${model} ${q.id}/${n}: ${a.error ? `error: ${a.error}` : `${(a.latency_ms / 1000).toFixed(1)} s${tps}`}`,
        );
        save(answers);
      }
    } finally {
      if (!keep) {
        await ollama
          .unload(model)
          .catch((e: Error) => log(`${model}: unload failed: ${e.message}`));
        log(`${model}: unloaded`);
      } else {
        log(`${model}: was loaded before the run; left loaded`);
      }
    }
  }
  save(answers);
  return answers;
}
