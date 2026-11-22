// §10 #107 end to end on a test DB: an example's pinyin goes through the same per-syllable merge
// as its phrase's (extract_turn.v8 sends Gemini's reading), disputes go to the referee through the
// phrase's `pinyin` job, the card shows the stored reading, and the example-pinyin backfill queues
// jobs only the backfill run (reextract_only) claims. Synthetic sentences only.
import { createTestDb, event, phrase, pinyinJob, type Db } from "@bamboo/db";
import type { ExtractItem } from "@bamboo/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as examplePinyinPOST } from "@/app/api/agent/example-pinyin/route";
import { pinyinText } from "../domain/pinyin";
import { backfillReport } from "./backfill";
import { claimJob, completeJob, importPastedText } from "./capture";
import { PhraseInput } from "../domain/phrase";
import { phraseRows, recomputeStoredPinyin, updatePhrase } from "./phrases";
import { queueExamplePinyin } from "./pinyin";
import { getRound, startRound } from "./review";

const T0 = new Date("2026-11-10T03:00:00Z").getTime();
const clock = { now: T0 + 60_000, timeZone: "America/Los_Angeles" };

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.$client.close());

// The dictionary reads 得 dé in 我得走了。; Gemini reads děi, also valid: a real dispute.
const EX = "我得走了。";
const term = (examples: ExtractItem["examples"]): ExtractItem => ({
  kind: "term",
  hanzi: "走",
  english: "to go",
  note: null,
  heard_as: null,
  example: examples?.[0] ?? null,
  examples,
  usefulness: 4,
  tags: [],
  pinyin: ["zǒu"],
});

async function extract(items: ExtractItem[], model = "gemini-3.8-flash") {
  const r = await importPastedText(db, "走。我得走了。", T0);
  if (!r.ok) throw new Error(r.error);
  const job = await claimJob(db, T0, ["extract_turn"]);
  if (job?.type !== "extract_turn") throw new Error("no extract job");
  const done = await completeJob(
    db,
    {
      job_id: job.job_id,
      attempt: job.attempt,
      status: "done",
      model,
      prompt_version: "extract_turn.v8",
      // An errand turn, so no sentence is promoted from the example (§4.6 step 3).
      result: { turn_kind: "errand", items },
    },
    T0,
  );
  expect(done).toEqual({ ok: true, jobStatus: "done" });
  return (await db.select().from(phrase)).find((p) => p.hanzi === "走")!;
}

const events = (type: string) => db.select().from(event).where(eq(event.type, type));

async function cardExample() {
  const id = await startRound(db, clock);
  const r = await getRound(db, id!, clock);
  return pinyinText(r!.cards[0]!.examples[0]!.pinyin);
}

describe("extraction stores each example's merged pinyin", () => {
  it("agreement is stored, with no job", async () => {
    const p = await extract([
      term([{ hanzi: EX, english: "I have to go.", pinyin: ["wǒ", "dé", "zǒu", "le"] }]),
    ]);
    expect(p.examples[0]).toMatchObject({ pinyin_sources: [] });
    expect(await db.select().from(pinyinJob)).toHaveLength(0);
    expect(await cardExample()).toBe("wǒ dé zǒu le");
  });

  it("a dispute goes to the referee through the phrase's pinyin job; the card shows its choice", async () => {
    const p = await extract([
      term([{ hanzi: EX, english: "I have to go.", pinyin: ["wo3", "dei3", "zou3", "le5"] }]),
    ]);
    expect(p.examples[0]!.pinyin_sources).toEqual([
      expect.objectContaining({ i: 1, gemini: "děi", rule: "pending" }),
    ]);
    // Until the referee answers, the dictionary's reading shows.
    expect(await cardExample()).toBe("wǒ dé zǒu le");

    const j = await claimJob(db, T0, ["pinyin"]);
    if (j?.type !== "pinyin") throw new Error("no pinyin job");
    // The phrase agreed, so only its example is asked about, with Gemini's reading: referee only.
    expect(j.input).toMatchObject({
      hanzi: "走",
      phrase_settled: true,
      examples: [{ index: 0, hanzi: EX, gemini: ["wo3", "dei3", "zou3", "le5"] }],
    });
    expect(j.input).not.toHaveProperty("backfill");

    const res = await completeJob(
      db,
      {
        job_id: j.job_id,
        attempt: j.attempt,
        status: "done",
        model: "gemini-3.8-flash",
        prompt_version: "pinyin_referee.v2",
        result: {
          gemini: null,
          referee: [],
          examples: [{ index: 0, gemini: null, referee: [{ index: 1, reading: "děi" }] }],
        },
      },
      T0,
    );
    expect(res).toEqual({ ok: true, jobStatus: "done" });
    const after = (await db.select().from(phrase).where(eq(phrase.id, p.id)))[0]!;
    expect(pinyinText(after.examples[0]!.pinyin!)).toBe("wǒ děi zǒu le");
    expect(after.examples[0]).toMatchObject({ english: "I have to go.", turn_id: p.sourceTurnId });
    // The phrase's own pinyin is left as it was.
    expect(after.pinyin).toEqual(p.pinyin);
    expect(after.pinyinSources).toEqual([]);
    const [d] = await events("example_pinyin_disagreement");
    expect(d!.data).toMatchObject({ phrase_id: p.id, example: 0, outcome: "gemini" });
    expect(await events("pinyin_disagreement")).toHaveLength(0);
    expect(await cardExample()).toBe("wǒ děi zǒu le");
    // The build's repinyin keeps the referee's choice.
    expect(await recomputeStoredPinyin(db)).toBe(0);
  });

  it("the Ollama fallback sends no readings: the job reads the phrase and its examples", async () => {
    await extract(
      [{ ...term([{ hanzi: EX, english: "I have to go.", pinyin: null }]), pinyin: null }],
      "qwen3.8:27b",
    );
    const j = await claimJob(db, T0, ["pinyin"]);
    if (j?.type !== "pinyin") throw new Error("no pinyin job");
    expect(j.input).toMatchObject({ gemini: null, examples: [{ index: 0, gemini: null }] });
    expect(j.input).not.toHaveProperty("phrase_settled");
    await completeJob(
      db,
      {
        job_id: j.job_id,
        attempt: j.attempt,
        status: "done",
        result: {
          gemini: ["zǒu"],
          referee: [],
          examples: [{ index: 0, gemini: ["wǒ", "dài", "zǒu", "le"], referee: [] }],
        },
      },
      T0,
    );
    const p = (await db.select().from(phrase))[0]!;
    // Gemini's 得 dài isn't a valid reading: the dictionary's stays, with no referee.
    expect(p.examples[0]!.pinyin_sources).toEqual([
      expect.objectContaining({ rule: "invalid", chosen: "dé" }),
    ]);
    expect(p.pinyinSources).toEqual([]);
  });
});

describe("merges and edits keep example pinyin", () => {
  it("a later turn's new example gets its own job; an edit keeps an unchanged example's reading", async () => {
    const p = await extract([
      term([{ hanzi: "快走", english: "Go quickly.", pinyin: ["kuài", "zǒu"] }]),
    ]);
    expect(await db.select().from(pinyinJob)).toHaveLength(0);
    // The same term again, from another import, with a disputed new example.
    const r = await importPastedText(db, "走。我得走了。快走。", T0 + 1);
    if (!r.ok) throw new Error(r.error);
    const job = await claimJob(db, T0 + 1, ["extract_turn"]);
    if (job?.type !== "extract_turn") throw new Error("no extract job");
    await completeJob(
      db,
      {
        job_id: job.job_id,
        attempt: job.attempt,
        status: "done",
        model: "gemini-3.8-flash",
        result: {
          turn_kind: "errand",
          items: [term([{ hanzi: EX, english: null, pinyin: ["wǒ", "děi", "zǒu", "le"] }])],
        },
      },
      T0 + 1,
    );
    const merged = (await db.select().from(phrase).where(eq(phrase.id, p.id)))[0]!;
    expect(merged.examples.map((e) => e.hanzi)).toEqual(["快走", EX]);
    const jobs = await db.select().from(pinyinJob);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.input).toMatchObject({
      phrase_settled: true,
      examples: [{ index: 1, hanzi: EX, gemini: ["wǒ", "děi", "zǒu", "le"] }],
    });

    // Will edits the phrase without touching 快走: it keeps its merged reading.
    const saved = await updatePhrase(
      db,
      p.id,
      PhraseInput.parse({
        kind: "term",
        hanzi: "走",
        english: "to walk",
        examples: [
          { hanzi: "快走", english: "Go quickly." },
          { hanzi: "慢走", english: null },
        ],
        cardTypes: ["say", "listen"],
      }),
      T0 + 2,
    );
    expect(saved.ok).toBe(true);
    const edited = (await db.select().from(phrase).where(eq(phrase.id, p.id)))[0]!;
    expect(edited.examples[0]).toMatchObject({ hanzi: "快走", pinyin_sources: [] });
    expect(edited.examples[1]).not.toHaveProperty("pinyin_sources");
    // The new example gets a job; the phrase's own pinyin is settled.
    const latest = (await db.select().from(pinyinJob)).at(-1)!;
    expect(latest.input).toMatchObject({
      phrase_settled: true,
      examples: [{ index: 1, hanzi: "慢走", gemini: null }],
    });
  });
});

describe("the example-pinyin backfill", () => {
  async function oldPhrase(hanzi: string, examples: string[], at = T0) {
    const rows = phraseRows(
      {
        status: "active",
        kind: "term",
        hanzi,
        english: "x",
        examples: examples.map((e) => ({ hanzi: e, english: null, turn_id: null })),
        source: "import",
        pinyinSources: [],
      },
      ["say"],
      at,
    );
    await db.insert(phrase).values(rows.phrase);
    return rows.phrase.id;
  }

  it("queues one job per phrase missing example pinyin, claimed only by the backfill run", async () => {
    const id = await oldPhrase("走", [EX, "快走"]);
    await oldPhrase("吃", [], T0 + 1); // no examples: nothing to do
    expect((await backfillReport(db, 0)).example_pinyin).toEqual({
      phrases_missing: 1,
      queueable: 1,
      open_backfill_jobs: 0,
    });

    expect(await queueExamplePinyin(db, T0, { limit: 5 })).toEqual({ queued: 1, remaining: 0 });
    // A phrase with an open job isn't queued twice.
    expect(await queueExamplePinyin(db, T0)).toEqual({ queued: 0, remaining: 0 });
    expect((await backfillReport(db, 0)).example_pinyin).toEqual({
      phrases_missing: 1,
      queueable: 0,
      open_backfill_jobs: 1,
    });

    // The everyday worker (free key) never gets it; the backfill run (reextract_only) does.
    expect(await claimJob(db, T0, ["extract_turn", "pinyin"])).toBeNull();
    const j = await claimJob(db, T0, ["extract_turn", "pinyin"], { reextractOnly: true });
    if (j?.type !== "pinyin") throw new Error("no pinyin job");
    expect(j.input).toMatchObject({
      phrase_id: id,
      phrase_settled: true,
      backfill: true,
      examples: [
        { index: 0, hanzi: EX, gemini: null },
        { index: 1, hanzi: "快走", gemini: null },
      ],
    });
    await completeJob(
      db,
      {
        job_id: j.job_id,
        attempt: j.attempt,
        status: "done",
        result: {
          gemini: null,
          referee: [],
          examples: [
            { index: 0, gemini: ["wǒ", "dé", "zǒu", "le"], referee: [] },
            { index: 1, gemini: ["kuài", "zǒu"], referee: [] },
          ],
        },
      },
      T0,
    );
    expect((await backfillReport(db, 0)).example_pinyin).toEqual({
      phrases_missing: 0,
      queueable: 0,
      open_backfill_jobs: 0,
    });
  });

  it("POST /api/agent/example-pinyin: agent token, a limit, counts only", async () => {
    await oldPhrase("走", [EX]);
    await oldPhrase("跑", ["快跑"], T0 + 1);
    const holder = globalThis as unknown as { __bambooDb?: Db };
    holder.__bambooDb = db;
    vi.stubEnv("AGENT_API_TOKEN", "agent-token");
    vi.stubEnv("WORKER_API_TOKEN", "worker-token");
    try {
      const req = (token: string, body: unknown) =>
        new Request("http://localhost/api/agent/example-pinyin", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await examplePinyinPOST(req("worker-token", {}))).status).toBe(401);
      expect((await examplePinyinPOST(req("agent-token", { limit: 0 }))).status).toBe(400);
      expect((await examplePinyinPOST(req("agent-token", { nope: 1 }))).status).toBe(400);
      const first = await examplePinyinPOST(req("agent-token", { limit: 1 }));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ queued: 1, remaining: 1 });
      expect(await (await examplePinyinPOST(req("agent-token", {}))).json()).toEqual({
        queued: 1,
        remaining: 0,
      });
    } finally {
      holder.__bambooDb = undefined;
      vi.unstubAllEnvs();
    }
  });
});
