// H7's backfill counts (DESIGN §5.5.6): sums of the re-run `extraction` events' numbers. Pure;
// `repo/backfill.ts` reads the events. Counts only: the events hold no text.

/** The `extraction` event fields that count something an extraction dropped. */
export const DROP_FIELDS = [
  "dropped_not_verbatim",
  "dropped_duplicate",
  "dropped_frame",
  "dropped_over_cap",
  "dropped_name",
  "trimmed_over_cap",
  "examples_dropped",
  "heard_as_dropped",
  "tags_dropped",
  "breakdowns_dropped",
] as const;

export interface RerunSums {
  turns: number;
  items_per_turn: number[];
  items: number;
  kept: number;
  sentence_promoted: number;
  dropped: Record<string, number>;
  phrases_created: number;
  phrases_refreshed: number;
  phrases_dropped: number;
  phrases_reported: number;
  pinyin_jobs_queued: number;
  pinyin_misaligned: number;
  models: Record<string, number>;
}

/** A whole, non-negative count from an event field, else 0 (older events lack newer fields). */
const n = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** Sum re-run `extraction` events' payloads, in the order given. Non-re-run events are skipped. */
export function sumRerunEvents(events: readonly Record<string, unknown>[]): RerunSums {
  const s: RerunSums = {
    turns: 0,
    items_per_turn: [],
    items: 0,
    kept: 0,
    sentence_promoted: 0,
    dropped: Object.fromEntries(DROP_FIELDS.map((f) => [f, 0])),
    phrases_created: 0,
    phrases_refreshed: 0,
    phrases_dropped: 0,
    phrases_reported: 0,
    pinyin_jobs_queued: 0,
    pinyin_misaligned: 0,
    models: {},
  };
  for (const e of events) {
    if (e.reextract !== true) continue;
    s.turns += 1;
    s.items_per_turn.push(n(e.items));
    s.items += n(e.items);
    s.kept += n(e.kept);
    s.sentence_promoted += n(e.sentence_promoted);
    for (const f of DROP_FIELDS) s.dropped[f]! += n(e[f]);
    s.phrases_created += n(e.phrases_created);
    s.phrases_refreshed += n(e.phrases_refreshed);
    s.phrases_dropped += n(e.phrases_dropped);
    s.phrases_reported += n(e.phrases_reported);
    s.pinyin_jobs_queued += n(e.pinyin_jobs);
    s.pinyin_misaligned += n(e.pinyin_misaligned);
    const model = typeof e.model === "string" && e.model ? e.model : "unknown";
    s.models[model] = (s.models[model] ?? 0) + 1;
  }
  return s;
}

/**
 * Whether a stored reply sits exactly at the import cap. The import cut it with `slice`, which
 * counts UTF-16 code units, so the check does too (SQLite's `length` counts characters).
 */
export const atReplyCap = (replyText: string, cap: number): boolean => replyText.length === cap;
