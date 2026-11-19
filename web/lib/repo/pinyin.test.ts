// H4's pinyin merge end to end on a test DB (DESIGN §5.5.3b): extraction with Gemini's reading,
// the referee through a `pinyin` job, hand-added phrases, events and the Stats counts. Synthetic
// sentences only.
import { createTestDb, event, phrase, pinyinJob, type Db } from "@bamboo/db";
import type { ExtractItem, PinyinJobInput } from "@bamboo/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhraseInput } from "../domain/phrase";
import { mergedPinyin, pinyinSlots } from "../domain/pinyin";
import { claimJob, completeJob, importPastedText } from "./capture";
import { createManualPhrase, recomputeStoredPinyin, updatePhrase } from "./phrases";
import { getStats } from "./stats";

const T0 = new Date("2026-11-10T03:00:00Z").getTime();

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.$client.close());

const item = (o: Partial<ExtractItem>): ExtractItem => ({
  kind: "sentence",
  hanzi: "我得走了。",
  english: "I have to go.",
  note: null,
  heard_as: null,
  example: null,
  usefulness: 3,
  tags: [],
  ...o,
});

/** One pasted turn, extracted with `items`; returns the phrase rows. */
async function extract(reply: string, items: ExtractItem[], now = T0) {
  const r = await importPastedText(db, reply, now);
  if (!r.ok) throw new Error(r.error);
  const job = await claimJob(db, now, ["extract_turn"]);
  if (job?.type !== "extract_turn") throw new Error("no extract job");
  const done = await completeJob(
    db,
    {
      job_id: job.job_id,
      attempt: job.attempt,
      status: "done",
      model: "gemini-3.8-flash",
      prompt_version: "extract_turn.v4",
      dropped_name: 1,
      result: { turn_kind: "say", items },
    },
    now,
  );
  expect(done).toEqual({ ok: true, jobStatus: "done" });
  return db.select().from(phrase);
}

async function claimPinyin(now = T0) {
  const j = await claimJob(db, now, ["pinyin"]);
  if (j?.type !== "pinyin") throw new Error("no pinyin job");
  return j;
}

const events = (type: string) => db.select().from(event).where(eq(event.type, type));
const text = (pairs: [string, string | null][]) => pairs.map(([, s]) => s ?? "·").join(" ");

describe("engine merge with real dictionary readings", () => {
  it("slots carry every valid reading", () => {
    const s = pinyinSlots("我得走了。");
    expect(s[1]).toEqual({ char: "得", computed: "dé", readings: ["dé", "děi", "de"] });
    expect(s[4]).toEqual({ char: "。", computed: null, readings: [] });
  });

  it("agreement, an invalid reading and a dispute", () => {
    expect(mergedPinyin("我得走了。", ["wǒ", "dé", "zǒu", "le"]).pinyinSources).toEqual([]);
    const invalid = mergedPinyin("我得走了。", ["wǒ", "dài", "zǒu", "le"]);
    expect(invalid.pinyinSources?.[0]).toMatchObject({ rule: "invalid", chosen: "dé" });
    const dispute = mergedPinyin("我得走了。", ["wǒ", "děi", "zǒu", "le"]);
    expect(dispute.pending).toBe(1);
    expect(mergedPinyin("我得走了。", ["wǒděi", "zǒu", "le"]).misaligned).toBe(true);
    expect(mergedPinyin("我得走了。", null)).toMatchObject({
      pinyinSources: null,
      misaligned: false,
    });
  });
});

describe("extraction → merge → referee", () => {
  it("a dispute queues one pinyin job with Gemini's reading; the referee's valid choice wins", async () => {
    const [p] = await extract("我得走了。", [item({ pinyin: ["wo3", "dei3", "zou3", "le5"] })]);
    expect(text(p!.pinyin)).toBe("wǒ dé zǒu le ·"); // dictionary reading until the referee runs
    expect(p!.pinyinSources).toEqual([
      expect.objectContaining({ i: 1, gemini: "děi", rule: "pending" }),
    ]);
    const [ex] = await events("extraction");
    expect(ex!.data).toMatchObject({ dropped_name: 1, pinyin_jobs: 1, pinyin_misaligned: 0 });
    expect(await events("pinyin_disagreement")).toHaveLength(0);

    // Gemini isn't available: an older worker (no types) and a pinyin-less claim get nothing.
    expect(await claimJob(db, T0)).toBeNull();
    const j = await claimPinyin();
    expect(j.input).toMatchObject({ hanzi: "我得走了。", gemini: ["wo3", "dei3", "zou3", "le5"] });

    const res = await completeJob(
      db,
      {
        job_id: j.job_id,
        attempt: j.attempt,
        status: "done",
        model: "gemini-3.8-flash",
        prompt_version: "pinyin_referee.v1",
        result: { gemini: null, referee: [{ index: 1, reading: "děi" }] },
      },
      T0,
    );
    expect(res).toEqual({ ok: true, jobStatus: "done" });
    const after = (await db.select().from(phrase))[0]!;
    expect(text(after.pinyin)).toBe("wǒ děi zǒu le ·");
    expect(after.pinyinSources).toEqual([
      expect.objectContaining({ rule: "referee", winner: "gemini", chosen: "děi" }),
    ]);
    const [d] = await events("pinyin_disagreement");
    expect(d!.data).toMatchObject({ phrase_id: after.id, outcome: "gemini" });

    // Will's override still wins on display; a rebuild keeps the referee's choice.
    expect(await recomputeStoredPinyin(db)).toBe(0);
  });

  it("the referee is limited to valid readings plus the neutral tone", async () => {
    await extract("我得走了。", [item({ pinyin: ["wǒ", "děi", "zǒu", "le"] })]);
    const j = await claimPinyin();
    await completeJob(
      db,
      {
        job_id: j.job_id,
        attempt: j.attempt,
        status: "done",
        result: { gemini: null, referee: [{ index: 1, reading: "dāi" }] },
      },
      T0,
    );
    const p = (await db.select().from(phrase))[0]!;
    expect(text(p.pinyin)).toBe("wǒ dé zǒu le ·");
    expect(p.pinyinSources?.[0]).toMatchObject({ rule: "rejected", winner: "computed" });
  });

  it("an invalid reading settles without a job and is logged at once", async () => {
    await extract("我得走了。", [item({ pinyin: ["wǒ", "dài", "zǒu", "le"] })]);
    expect(await db.select().from(pinyinJob)).toHaveLength(0);
    const [d] = await events("pinyin_disagreement");
    expect(d!.data).toMatchObject({ outcome: "computed", syllables: [{ rule: "invalid" }] });
  });

  it("fallback items (no Gemini pinyin) get a pinyin job asking for Gemini's reading", async () => {
    await extract("我得走了。", [item({})]);
    const j = await claimPinyin();
    expect(j.input.gemini).toBeNull();
    // Gemini reads it and agrees: checked, nothing to log.
    await completeJob(
      db,
      {
        job_id: j.job_id,
        attempt: j.attempt,
        status: "done",
        result: { gemini: ["wǒ", "dé", "zǒu", "le"], referee: [] },
      },
      T0,
    );
    expect((await db.select().from(phrase))[0]!.pinyinSources).toEqual([]);
    expect(await events("pinyin_disagreement")).toHaveLength(0);
  });

  it("claims ordinary extractions first, then pinyin jobs", async () => {
    await extract("我得走了。", [item({})]);
    await importPastedText(db, "宝宝喝奶了。", T0 + 1);
    const first = await claimJob(db, T0 + 2, ["extract_turn", "pinyin"]);
    expect(first?.type).toBe("extract_turn");
    expect((await claimJob(db, T0 + 2, ["extract_turn", "pinyin"]))?.type).toBe("pinyin");
  });

  it("an answer for a phrase whose hanzi changed since is ignored", async () => {
    await extract("我得走了。", [item({ pinyin: ["wǒ", "děi", "zǒu", "le"] })]);
    const j = await claimPinyin();
    const p = (await db.select().from(phrase))[0]!;
    await updatePhrase(
      db,
      p.id,
      PhraseInput.parse({
        kind: "sentence",
        hanzi: "我得走啦。",
        english: "x",
        cardTypes: ["say"],
      }),
      T0 + 1,
    );
    await completeJob(
      db,
      {
        job_id: j.job_id,
        attempt: j.attempt,
        status: "done",
        result: { gemini: null, referee: [{ index: 1, reading: "děi" }] },
      },
      T0 + 2,
    );
    const after = (await db.select().from(phrase))[0]!;
    expect(text(after.pinyin)).toBe("wǒ dé zǒu lā ·");
    expect(after.pinyinSources).toBeNull();
  });
});

describe("hand-added and edited phrases", () => {
  it("queue a pinyin job (Gemini's reading, then the referee if needed)", async () => {
    const r = await createManualPhrase(
      db,
      PhraseInput.parse({
        kind: "sentence",
        hanzi: "我得走了。",
        english: "I have to go.",
        cardTypes: ["say"],
      }),
      T0,
    );
    expect(r.ok).toBe(true);
    const jobs = await db.select().from(pinyinJob);
    expect(jobs).toHaveLength(1);
    const input = jobs[0]!.input as unknown as PinyinJobInput;
    expect(input).toMatchObject({ hanzi: "我得走了。", gemini: null, context: [] });

    // Editing without changing the hanzi queues nothing more; changing it does.
    const id = r.ok ? r.id : "";
    const edit = (hanzi: string) =>
      updatePhrase(
        db,
        id,
        PhraseInput.parse({ kind: "sentence", hanzi, english: "I must go.", cardTypes: ["say"] }),
        T0 + 1,
      );
    await edit("我得走了。");
    expect(await db.select().from(pinyinJob)).toHaveLength(1);
    await edit("我得走啦。");
    expect(await db.select().from(pinyinJob)).toHaveLength(2);
  });
});

describe("Stats", () => {
  it("counts disagreements by how they were settled", async () => {
    await extract("我得走了。长高了。", [
      item({ pinyin: ["wǒ", "dài", "zǒu", "le"] }),
      item({ hanzi: "长高了。", english: "Grew taller", pinyin: ["zhǎng", "gāo", "le"] }),
    ]);
    const j = await claimPinyin();
    await completeJob(
      db,
      {
        job_id: j.job_id,
        attempt: j.attempt,
        status: "done",
        result: { gemini: null, referee: [{ index: 0, reading: "zhǎng" }] },
      },
      T0,
    );
    const s = await getStats(db, { now: T0 + 1000, timeZone: "America/Los_Angeles" });
    expect(s.pinyin).toEqual({
      phrases: 2,
      syllables: 2,
      invalid: 1,
      refereeGemini: 1,
      refereeComputed: 0,
      refereeOther: 0,
      rejected: 0,
    });
  });
});
