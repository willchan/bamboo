// Neural TTS on a test DB (DESIGN §6.1), with Azure stubbed: the round payload's clip URLs, the
// route serving a stored or freshly made clip, falling back on failure, warming paced around
// F0's 429, and the daily prune. Synthetic phrases only.
import { createTestDb, event, ttsClip, type Db } from "@bamboo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { PhraseInput } from "../domain/phrase";
import { createManualPhrase, updatePhrase } from "./phrases";
import { getRound, startRound } from "./review";
import { getClip, pruneClips, warmRound } from "./tts";

const T0 = new Date("2026-11-20T03:00:00Z").getTime();
const clock = { now: T0, timeZone: "America/Los_Angeles" };
const service = { key: "test-key", endpoint: "https://azure.test/cognitiveservices/v1" };
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0xc0, 1, 2, 3]);

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.$client.close());

/** A stub Azure: answers each request with the next status (200 = an MP3). */
function azure(...statuses: number[]) {
  const bodies: string[] = [];
  const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const status = statuses.length > 1 ? statuses.shift()! : (statuses[0] ?? 200);
    return status === 200
      ? new Response(new Uint8Array(MP3), { status })
      : new Response("no", { status });
  });
  return { impl: impl as unknown as typeof fetch, bodies, calls: () => impl.mock.calls.length };
}

async function addSentence(hanzi: string, english: string, examples: string[] = []) {
  const r = await createManualPhrase(
    db,
    PhraseInput.parse({
      kind: examples.length ? "term" : "sentence",
      hanzi,
      english,
      cardTypes: ["say"],
      examples: examples.map((e) => ({ hanzi: e, english: "synthetic" })),
    }),
    T0,
  );
  if (!r.ok) throw new Error(r.error);
  return r.id;
}

describe("round payload", () => {
  it("carries clip URLs only while neural TTS is on", async () => {
    const id = await addSentence("长了", "grew", ["宝宝长高了。"]);
    const roundId = (await startRound(db, clock))!;
    const on = (await getRound(db, roundId, clock, { neural: true }))!.cards[0]!;
    expect(on.phraseId).toBe(id);
    expect(on.audioUrl).toMatch(new RegExp(`^/api/tts/${id}/phrase\\?v=[0-9a-f]{16}$`, "u"));
    expect(on.examples[0]!.audioUrl).toMatch(/\/example-0\?v=/u);
    const off = (await getRound(db, roundId, clock, { neural: false }))!.cards[0]!;
    expect(off.audioUrl).toBeNull();
    expect(off.examples[0]!.audioUrl).toBeNull();
  });
});

describe("getClip", () => {
  it("pins the displayed (overridden) reading, stores the clip and serves it again without Azure", async () => {
    const id = await addSentence("长了", "grew");
    const saved = await updatePhrase(
      db,
      id,
      PhraseInput.parse({
        kind: "sentence",
        hanzi: "长了",
        english: "grew",
        cardTypes: ["say"],
        pinyinEdits: ["zhǎng", ""],
      }),
      T0,
    );
    expect(saved.ok).toBe(true);

    const a = azure(200);
    const first = await getClip(db, id, "phrase", T0, { service, fetchImpl: a.impl });
    expect(first.status).toBe("ok");
    expect(a.bodies[0]).toContain('ph="zhang 3">长</phoneme>');
    const [row] = await db.select().from(ttsClip);
    expect(Buffer.from(row!.audio).equals(MP3)).toBe(true);
    expect(row!.chars).toBe(Array.from(a.bodies[0]!).length);
    const [ev] = await db.select().from(event).where(eq(event.type, "tts_synth"));
    expect(ev!.data).toMatchObject({ ok: true, warm: false, chars: row!.chars });
    // Counts only: no hanzi in the event.
    expect(JSON.stringify(ev!.data)).not.toMatch(/\p{Script=Han}/u);

    const again = await getClip(db, id, "phrase", T0 + 1000, { service, fetchImpl: a.impl });
    expect(again.status).toBe("ok");
    expect(a.calls()).toBe(1);
    const [played] = await db.select().from(ttsClip);
    expect(played!.lastPlayedAt).toBe(T0 + 1000);
  });

  it("reports a failure without storing, and is off without a key", async () => {
    const id = await addSentence("你好", "hello");
    const a = azure(429);
    expect(await getClip(db, id, "phrase", T0, { service, fetchImpl: a.impl })).toEqual({
      status: "failed",
      upstream: 429,
    });
    expect(await db.select().from(ttsClip)).toHaveLength(0);
    expect(await getClip(db, id, "phrase", T0, { service: null })).toEqual({ status: "off" });
    expect(await getClip(db, id, "example-0", T0, { service, fetchImpl: a.impl })).toEqual({
      status: "not_found",
    });
    expect(await getClip(db, "nope", "phrase", T0, { service, fetchImpl: a.impl })).toEqual({
      status: "not_found",
    });
  });
});

describe("warmRound", () => {
  function fakeTime() {
    let t = 0;
    const waits: number[] = [];
    return {
      clock: () => t,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
      waits,
    };
  }

  it("makes the round's missing clips, paced, and retries a 429 after a pause", async () => {
    await addSentence("喝水吗？", "Want water?");
    await addSentence("洗手了吗？", "Washed hands?");
    const roundId = (await startRound(db, clock))!;
    const a = azure(429, 200, 200);
    const time = fakeTime();
    const r = await warmRound(db, roundId, T0, { service, fetchImpl: a.impl, ...time });
    expect(r).toEqual({ made: 2, failed: 0, left: 0 });
    expect(a.calls()).toBe(3);
    expect(time.waits).toContain(config.audio.neural.throttleWaitMs);
    expect(await db.select().from(ttsClip)).toHaveLength(2);

    // Already warm: nothing to make.
    const b = azure(200);
    expect(await warmRound(db, roundId, T0, { service, fetchImpl: b.impl, ...time })).toEqual({
      made: 0,
      failed: 0,
      left: 0,
    });
    expect(b.calls()).toBe(0);
  });

  it("stops at the budget and leaves the rest for first play", async () => {
    for (let i = 0; i < 3; i++) await addSentence(`第${"一二三"[i]}个。`, `number ${i}`);
    const roundId = (await startRound(db, clock))!;
    const a = azure(429);
    const time = fakeTime();
    const r = await warmRound(db, roundId, T0, { service, fetchImpl: a.impl, ...time });
    expect(r.made).toBe(0);
    expect(r.failed + r.left).toBe(3);
    expect(time.clock()).toBeLessThanOrEqual(config.audio.neural.warmBudgetMs);
  });

  it("does nothing while neural TTS is off", async () => {
    await addSentence("你好", "hello");
    const roundId = (await startRound(db, clock))!;
    expect(await warmRound(db, roundId, T0, { service: null })).toEqual({
      made: 0,
      failed: 0,
      left: 0,
    });
  });
});

describe("pruneClips", () => {
  it("deletes clips not played for retainDays", async () => {
    const DAY = 86_400_000;
    const old = T0 - (config.audio.neural.retainDays + 1) * DAY;
    await db.insert(ttsClip).values([
      { key: "a", audio: MP3, chars: 1, createdAt: old, lastPlayedAt: null },
      { key: "b", audio: MP3, chars: 1, createdAt: old, lastPlayedAt: T0 - DAY },
      { key: "c", audio: MP3, chars: 1, createdAt: T0, lastPlayedAt: null },
    ]);
    expect(await pruneClips(db, T0)).toBe(1);
    expect((await db.select({ key: ttsClip.key }).from(ttsClip)).map((r) => r.key).sort()).toEqual([
      "b",
      "c",
    ]);
  });
});
