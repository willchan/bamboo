// Scoring (DESIGN §5.4): Will's exported ratings joined with the key, one row per source.
import { GEMINI, type KeyFile, type ResultsFile } from "./types";

export interface ScoreRow {
  source: string;
  /** Answers shown to Will. */
  shown: number;
  /** Answers missing because the model failed. */
  errors: number;
  accuracy: number | null;
  naturalness: number | null;
  /** Share of questions with a preference where this source was preferred. */
  preferred: number | null;
  /** Of the answers shown; null for Gemini (no timing). */
  medianLatencyMs: number | null;
  medianTokensPerSec: number | null;
  rated: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function score(results: ResultsFile, key: KeyFile): ScoreRow[] {
  if (results.run_id !== key.run_id)
    throw new Error(`results are for run ${results.run_id}, the key for run ${key.run_id}`);
  type Acc = {
    shown: number;
    errors: number;
    acc: number[];
    nat: number[];
    pref: number;
    lat: number[];
    tps: number[];
    rated: number;
  };
  const by = new Map<string, Acc>();
  const get = (s: string) => {
    let a = by.get(s);
    if (!a) {
      a = { shown: 0, errors: 0, acc: [], nat: [], pref: 0, lat: [], tps: [], rated: 0 };
      by.set(s, a);
    }
    return a;
  };
  get(GEMINI);
  let withPreference = 0;
  for (const q of key.questions) {
    const r = results.questions[q.id];
    for (const [label, entry] of Object.entries(q.labels)) {
      const a = get(entry.source);
      a.shown++;
      if (entry.latency_ms !== null) a.lat.push(entry.latency_ms);
      if (entry.tokens_per_sec !== null) a.tps.push(entry.tokens_per_sec);
      const rating = r?.ratings[label];
      if (rating?.accuracy) a.acc.push(rating.accuracy);
      if (rating?.naturalness) a.nat.push(rating.naturalness);
      if (rating?.accuracy || rating?.naturalness) a.rated++;
    }
    for (const m of q.missing) get(m.source).errors++;
    const pref = r?.preferred ? q.labels[r.preferred] : undefined;
    if (pref) {
      withPreference++;
      get(pref.source).pref++;
    }
  }
  return [...by.entries()].map(([source, a]) => ({
    source,
    shown: a.shown,
    errors: a.errors,
    accuracy: mean(a.acc),
    naturalness: mean(a.nat),
    preferred: withPreference ? a.pref / withPreference : null,
    medianLatencyMs: median(a.lat),
    medianTokensPerSec: median(a.tps),
    rated: a.rated,
  }));
}

export function formatScores(rows: readonly ScoreRow[]): string {
  const f = (v: number | null, d = 2) => (v === null ? "—" : v.toFixed(d));
  const head = [
    "source",
    "accuracy",
    "natural",
    "preferred",
    "median latency",
    "tok/s",
    "rated",
    "errors",
  ];
  const body = rows.map((r) => [
    r.source,
    f(r.accuracy),
    f(r.naturalness),
    r.preferred === null ? "—" : `${Math.round(r.preferred * 100)}%`,
    r.medianLatencyMs === null ? "—" : `${(r.medianLatencyMs / 1000).toFixed(1)} s`,
    f(r.medianTokensPerSec, 1),
    `${r.rated}/${r.shown}`,
    String(r.errors),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}
