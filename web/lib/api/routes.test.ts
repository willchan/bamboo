// Route integration tests (PLAN M3): the real route handlers on a fresh in-memory libSQL per test,
// with the Mac side (bamboo-tools and the worker) faked by plain HTTP requests. All synthetic.
import {
  card,
  createTestDb,
  event,
  imports,
  job,
  phrase,
  reviewLog,
  turn,
  type Db,
} from "@bamboo/db";
import { turnKey, type ExtractTurnResult } from "@bamboo/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as evalTurnsGET } from "@/app/api/agent/eval/turns/route";
import { GET as notificationsGET } from "@/app/api/agent/notifications/route";
import { GET as cronGET } from "@/app/api/cron/daily/route";
import { POST as notifiedPOST } from "@/app/api/imports/[id]/notified/route";
import { POST as knownPOST } from "@/app/api/imports/known/route";
import { POST as importsPOST } from "@/app/api/imports/route";
import { POST as claimPOST } from "@/app/api/jobs/claim/route";
import { POST as completePOST } from "@/app/api/jobs/complete/route";
import { POST as heartbeatPOST } from "@/app/api/worker/heartbeat/route";
import { config } from "../config";
import { createManualPhrase, dropPhrase, getPhrase, listQueue } from "../repo/phrases";
import { PhraseInput } from "../domain/phrase";
import { frequencyPoints } from "../domain/queue";
import { gradeCard, startRound, getRound } from "../repo/review";
import {
  getImportsPage,
  getWorkerStatus,
  importPastedText,
  pendingNotifications,
  queueReextraction,
  retryFailedJobs,
} from "../repo/capture";

const AGENT = "agent-token-for-tests";
const WORKER = "worker-token-for-tests";
const CRON = "cron-secret-for-tests";
const T0 = new Date("2026-06-02T03:00:00Z").getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let db: Db;
const holder = globalThis as unknown as { __bambooDb?: Db };

beforeEach(async () => {
  db = await createTestDb();
  holder.__bambooDb = db;
  vi.stubEnv("AGENT_API_TOKEN", AGENT);
  vi.stubEnv("WORKER_API_TOKEN", WORKER);
  vi.stubEnv("CRON_SECRET", CRON);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  holder.__bambooDb = undefined;
  db.$client.close();
});

const at = (ms: number) => vi.setSystemTime(ms);

function req(path: string, token: string | null, body?: unknown, headers: HeadersInit = {}) {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

// --- Fake Mac side ----------------------------------------------------------------------------

interface FakeTurn {
  user_text: string;
  reply_text: string;
  position: number;
}

const TURNS: FakeTurn[] = [
  {
    user_text: "The yuesao said something like gaoyaguo, what is it?",
    reply_text: "她说的是“高压锅”（pressure cooker）。\n例如：用高压锅煮二十分钟就好了。",
    position: 0,
  },
  {
    user_text: "How do I ask the nanny if she means something?",
    reply_text: "你可以说：阿姨，您是说要加水吗？\n简短一点：您是说…吗？",
    position: 1,
  },
  {
    user_text: "What do I buy for baking?",
    reply_text: "泡打粉 (baking powder) 和面粉。",
    position: 2,
  },
];

async function postImport(body: Record<string, unknown>, headers: HeadersInit = {}) {
  return importsPOST(
    req(
      "/api/imports",
      AGENT,
      {
        kind: "link",
        origin: "discord",
        source_ref: "https://gemini.google.com/share/fake",
        conversation_title: "Yuesao questions",
        discord_channel_id: "c1",
        discord_message_id: "m1",
        turns_total: TURNS.length,
        turns: TURNS,
        ...body,
      },
      headers,
    ),
  );
}

async function claim() {
  const r = await claimPOST(req("/api/jobs/claim", WORKER, {}));
  return r.status === 204
    ? null
    : ((await r.json()) as {
        job_id: string;
        attempt: number;
        input: {
          turn_id: string;
          user_text: string;
          reply_text: string;
          conversation_title: string;
        };
      });
}

const complete = (body: Record<string, unknown>) =>
  completePOST(req("/api/jobs/complete", WORKER, body));

const done = (
  job_id: string,
  attempt: number,
  result: ExtractTurnResult,
  prompt_version = "extract_turn.v1",
) =>
  complete({
    job_id,
    attempt,
    status: "done",
    result,
    model: "qwen3.5:9b",
    prompt_version,
    latency_ms: 1234,
    repaired: false,
  });

const term = (hanzi: string, english: string, o: Partial<ExtractTurnResult["items"][0]> = {}) => ({
  kind: "term" as const,
  hanzi,
  english,
  note: null,
  heard_as: null,
  example: null,
  usefulness: 3,
  tags: [],
  ...o,
});

/** Claim every queued job and answer it from `answer(user_text, reply_text)`. */
async function drain(
  answer: (input: { user_text: string; reply_text: string }) => ExtractTurnResult,
) {
  for (let c = await claim(); c; c = await claim()) {
    const r = await done(c.job_id, c.attempt, answer(c.input));
    expect(r.status).toBe(200);
  }
}

const importRow = async (id: string) =>
  (await db.select().from(imports).where(eq(imports.id, id)))[0]!;

// --- Tests ------------------------------------------------------------------------------------

describe("auth", () => {
  const call = (token: string | null) => ({
    known: () => knownPOST(req("/api/imports/known", token, { turn_keys: [] })),
    imports: () => importsPOST(req("/api/imports", token, {})),
    notifications: () => notificationsGET(req("/api/agent/notifications", token)),
    evalTurns: () => evalTurnsGET(req("/api/agent/eval/turns", token)),
    notified: () =>
      notifiedPOST(req("/api/imports/x/notified", token, {}), {
        params: Promise.resolve({ id: "x" }),
      }),
    claim: () => claimPOST(req("/api/jobs/claim", token, {})),
    complete: () => completePOST(req("/api/jobs/complete", token, {})),
    heartbeat: () => heartbeatPOST(req("/api/worker/heartbeat", token, {})),
    cron: () => cronGET(req("/api/cron/daily", token)),
  });
  const scope = {
    known: "agent",
    imports: "agent",
    notifications: "agent",
    evalTurns: "agent",
    notified: "agent",
    claim: "worker",
    complete: "worker",
    heartbeat: "worker",
    cron: "cron",
  } as const;

  it("scopes tokens: each route takes only its own (the agent can't claim, and vice versa)", async () => {
    const tokens = { agent: AGENT, worker: WORKER, cron: CRON };
    for (const [name, s] of Object.entries(scope)) {
      for (const [other, token] of Object.entries(tokens)) {
        const r = await call(token)[name as keyof typeof scope]();
        if (other === s) expect([200, 204, 400, 404], name).toContain(r.status);
        else expect(r.status, `${name} with ${other} token`).toBe(401);
      }
      expect((await call(null)[name as keyof typeof scope]()).status).toBe(401);
      expect((await call("wrong")[name as keyof typeof scope]()).status).toBe(401);
    }
  });

  it("refuses everything when a token isn't configured", async () => {
    vi.stubEnv("WORKER_API_TOKEN", "");
    const r = await claimPOST(req("/api/jobs/claim", "", {}));
    expect(r.status).toBe(503);
    expect(await json(r)).toMatchObject({ error: "not_configured" });
  });

  it("rejects bodies that aren't JSON or don't match the contract", async () => {
    const bad = await knownPOST(req("/api/imports/known", AGENT, "{nope"));
    expect(bad.status).toBe(400);
    const wrong = await knownPOST(req("/api/imports/known", AGENT, { turn_keys: "x" }));
    expect(await json(wrong)).toMatchObject({ error: "invalid_body" });
    const tooMany = Array.from({ length: 5001 }, (_, i) => `k${i}`);
    expect((await knownPOST(req("/api/imports/known", AGENT, { turn_keys: tooMany }))).status).toBe(
      400,
    );
    const huge = "长".repeat(800_000); // > 2 MB as UTF-8
    const r = await postImport({ turns: [{ user_text: "q", reply_text: huge, position: 0 }] });
    expect(r.status).toBe(413);
  });
});

describe("imports", () => {
  it("known → imports, with chunking and idempotency", async () => {
    const keys = TURNS.map((t) => turnKey(t, "link"));
    const known = await knownPOST(
      req("/api/imports/known", AGENT, { turn_keys: [...keys, keys[0]] }),
    );
    expect(await json(known)).toEqual({ unknown: keys });

    // Chunk 1 of 2 (Idempotency-Key on every call).
    const idem = { "idempotency-key": "discord:m1" };
    const first = await postImport({ turns: TURNS.slice(0, 2), more: true }, idem);
    expect(first.status).toBe(200);
    const a = (await first.json()) as { import_id: string; turns_new: number; turns_added: number };
    expect(a).toMatchObject({ turns_new: 2, turns_added: 2 });

    // A retried first call returns the same import and adds nothing.
    const retry = await json(await postImport({ turns: TURNS.slice(0, 2), more: true }, idem));
    expect(retry).toEqual({ import_id: a.import_id, turns_new: 2, turns_added: 0 });

    // Not done while chunks are still coming, even with every job finished.
    await drain(() => ({ turn_kind: "other", items: [] }));
    expect((await importRow(a.import_id)).status).toBe("extracting");

    // Chunk 2 (the last).
    const second = await json(
      await postImport({ import_id: a.import_id, turns: TURNS.slice(2) }, idem),
    );
    expect(second).toEqual({ import_id: a.import_id, turns_new: 3, turns_added: 1 });
    expect(
      await json(await knownPOST(req("/api/imports/known", AGENT, { turn_keys: keys }))),
    ).toEqual({ unknown: [] });
    expect(await db.select().from(imports)).toHaveLength(1);
    expect(await db.select().from(job)).toHaveLength(3);

    // A retried last chunk is harmless; new turns for a closed import are refused.
    expect((await postImport({ import_id: a.import_id, turns: TURNS.slice(2) })).status).toBe(200);
    const late = await postImport({
      import_id: a.import_id,
      turns: [{ user_text: "late", reply_text: "晚了", position: 9 }],
    });
    expect(late.status).toBe(409);
    expect(await json(late)).toMatchObject({ error: "import_closed" });
    expect((await postImport({ import_id: "nope", turns: [] })).status).toBe(404);
  });

  it("dedupes turns by turn_key across imports: the second creates jobs only for new turns", async () => {
    const first = await json(await postImport({}));
    expect(first).toMatchObject({ turns_new: 3 });
    // A re-share: same prompts (reply re-flowed), plus one new turn.
    const reshare = [
      ...TURNS.map((t) => ({ ...t, reply_text: `${t.reply_text}\n（更多）` })),
      { user_text: "And how do I say bath time?", reply_text: "该洗澡了！", position: 3 },
    ];
    const second = await json(
      await postImport({ discord_message_id: "m2", turns: reshare, turns_total: 4 }),
    );
    expect(second).toMatchObject({ turns_new: 1, turns_added: 1 });
    expect(await db.select().from(turn)).toHaveLength(4);
    const jobs = await db.select().from(job);
    expect(jobs.filter((j) => j.importId === second.import_id)).toHaveLength(1);
    // Turns are stored normalized, under their first import.
    const t = await db.select().from(turn).where(eq(turn.position, 3));
    expect(t[0]).toMatchObject({ importId: second.import_id, replyText: "该洗澡了！" });
  });

  it("keys an image-only turn (empty prompt) on its reply", async () => {
    const images = [
      { user_text: "", reply_text: "这是一个高压锅。", position: 0 },
      { user_text: "", reply_text: "这是一个奶瓶。", position: 1 },
    ];
    const r = await json(await postImport({ turns: images, turns_total: 2 }));
    expect(r).toMatchObject({ turns_new: 2 });
    const keys = (await db.select().from(turn)).map((t) => t.turnKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain(turnKey(images[0]!, "text"));
    // The same image turn again is known.
    const again = await json(
      await postImport({ discord_message_id: "m2", turns: [images[1]], turns_total: 1 }),
    );
    expect(again).toMatchObject({ turns_new: 0 });
  });

  it("finishes an import with nothing new at once, with no Discord reply owed", async () => {
    await postImport({});
    await drain(() => ({ turn_kind: "other", items: [] }));
    const r = await json(await postImport({ discord_message_id: "m2" }));
    const row = await importRow(r.import_id as string);
    expect(row).toMatchObject({
      status: "done",
      turnsNew: 0,
      summary:
        "✅ Nothing new since last time.\n🔗 This share link is public; you can delete it in Gemini → Settings → Public links.",
    });
    expect(row.notifiedAt).not.toBeNull();
  });
});

describe("jobs", () => {
  it("claims oldest first with a lease; 204 when idle; heartbeat logged", async () => {
    expect(await claim()).toBeNull();
    await postImport({});
    const c = (await claim())!;
    expect(c.attempt).toBe(1);
    expect(c.input).toMatchObject({
      user_text: TURNS[0]!.user_text,
      conversation_title: "Yuesao questions",
    });
    const row = (await db.select().from(job).where(eq(job.id, c.job_id)))[0]!;
    expect(row).toMatchObject({ status: "leased", leaseExpiresAt: T0 + 10 * MIN });

    const hb = await heartbeatPOST(
      req("/api/worker/heartbeat", WORKER, {
        version: "0.1.0",
        sha: "abc",
        model: "m",
        ollama_ok: true,
      }),
    );
    expect(hb.status).toBe(204);
    expect(await getWorkerStatus(db, T0)).toEqual({ kind: "online", waiting: 3 });
    expect(await getWorkerStatus(db, T0 + 60 * MIN)).toMatchObject({ kind: "offline" });
  });

  it("409s a stale attempt, requeues expired leases, fails after 3 attempts, and Retry failed", async () => {
    const { import_id } = (await json(
      await postImport({ turns: TURNS.slice(0, 1), turns_total: 1 }),
    )) as { import_id: string };
    const first = (await claim())!;

    // The lease runs out; the next claim requeues and re-leases it as attempt 2.
    at(T0 + 11 * MIN);
    const second = (await claim())!;
    expect(second).toMatchObject({ job_id: first.job_id, attempt: 2 });
    const stale = await done(first.job_id, 1, { turn_kind: "other", items: [] });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ error: "stale_attempt" });

    // A reported failure requeues (attempt 2 of 3)...
    const fail = await complete({
      job_id: second.job_id,
      attempt: 2,
      status: "failed",
      error: "ollama down",
    });
    expect(await json(fail)).toEqual({ job_status: "queued" });
    // ...an invalid result uses up the third attempt and fails the job.
    const third = (await claim())!;
    expect(third.attempt).toBe(3);
    const invalid = await complete({
      job_id: third.job_id,
      attempt: 3,
      status: "done",
      result: { turn_kind: "nope", items: [] },
    });
    expect(invalid.status).toBe(422);
    expect(await json(invalid)).toMatchObject({ error: "invalid_result" });
    expect((await db.select().from(job))[0]).toMatchObject({ status: "failed", attempt: 3 });
    expect(await importRow(import_id)).toMatchObject({ status: "done", jobsFailed: 1 });
    expect((await importRow(import_id)).summary).toContain("⚠️ 1 question couldn't be processed");
    expect((await getImportsPage(db)).failedJobs).toMatchObject([
      { id: first.job_id, error: "invalid_result", attempt: 3 },
    ]);
    expect(await claim()).toBeNull();

    // Retry failed: back in the queue with attempt reset, the import reopened.
    expect(await retryFailedJobs(db)).toBe(1);
    expect(await importRow(import_id)).toMatchObject({ status: "extracting", jobsFailed: 0 });
    const retried = (await claim())!;
    expect(retried.attempt).toBe(1);
    expect((await done(retried.job_id, 1, { turn_kind: "other", items: [] })).status).toBe(200);
    expect(await importRow(import_id)).toMatchObject({ status: "done", jobsFailed: 0 });
    expect(await retryFailedJobs(db)).toBe(0);
    expect(
      (await complete({ job_id: "nope", attempt: 1, status: "failed", error: "x" })).status,
    ).toBe(404);
  });

  it("fails a job whose third lease expires", async () => {
    const { import_id } = (await json(
      await postImport({ turns: TURNS.slice(0, 1), turns_total: 1 }),
    )) as { import_id: string };
    for (let i = 0; i < 3; i++) {
      at(T0 + i * 11 * MIN);
      expect((await claim())!.attempt).toBe(i + 1);
    }
    at(T0 + 40 * MIN);
    const r = await json(await cronGET(req("/api/cron/daily", CRON)));
    expect(r).toMatchObject({ leases_requeued: 0, leases_failed: 1 });
    expect(await importRow(import_id)).toMatchObject({ status: "done", jobsFailed: 1 });
  });
});

describe("extract results", () => {
  /** One turn, imported and claimed; returns a completer for it. */
  async function oneTurn(t: FakeTurn, msg = "m1") {
    const { import_id } = (await json(
      await postImport({ discord_message_id: msg, turns: [t], turns_total: 1 }),
    )) as { import_id: string };
    const c = (await claim())!;
    return { importId: import_id, finish: (r: ExtractTurnResult) => done(c.job_id, c.attempt, r) };
  }

  it("drops items not in the turn, heard_as Will didn't type, and bad examples", async () => {
    const { finish } = await oneTurn(TURNS[0]!);
    const r = await finish({
      turn_kind: "decode",
      items: [
        term("高压锅", "pressure cooker", {
          heard_as: "gaoyaguo",
          example: {
            hanzi: "用高压锅煮二十分钟就好了。",
            english: "Twenty minutes in the pressure cooker.",
          },
          usefulness: 4,
          tags: ["Food"],
        }),
        term("电饭煲", "rice cooker"), // not in the turn: invented
        term("煮", "to boil", { heard_as: "zhu", example: { hanzi: "煮饭", english: null } }),
        term("分钟", "minute", { example: { hanzi: "就好了", english: null } }),
        term("高压锅", "dupe"),
      ],
    });
    expect(r.status).toBe(200);
    const rows = await db.select().from(phrase);
    expect(rows.map((p) => p.hanzi).sort()).toEqual(["分钟", "煮", "高压锅"].sort());
    const cooker = rows.find((p) => p.hanzi === "高压锅")!;
    expect(cooker).toMatchObject({
      status: "queued",
      source: "import",
      heardAs: "gaoyaguo",
      turnKind: "decode",
      tags: ["food"],
      flags: [],
      // term 1 + decode 2 + heard_as 1 + usefulness 1.5 × (4 − 3), plus how common 高压锅 is
      baseScore: expect.closeTo(
        1 + 2 + 1 + 1.5 + frequencyPoints({ kind: "term", tags: ["food"], hanziKey: "高压锅" }),
        2,
      ),
    });
    expect(cooker.examples).toEqual([
      expect.objectContaining({ hanzi: "用高压锅煮二十分钟就好了。", turn_id: expect.any(String) }),
    ]);
    // A decode term gets a Listen card.
    expect((await getPhrase(db, cooker.id))!.cards.map((c) => c.type)).toEqual(["listen"]);
    // 煮: heard_as not in his message, example not verbatim.
    expect(rows.find((p) => p.hanzi === "煮")).toMatchObject({
      heardAs: null,
      examples: [],
      flags: ["heard_as_dropped", "example_dropped"],
    });
    // 分钟: the example is verbatim but doesn't contain the term.
    expect(rows.find((p) => p.hanzi === "分钟")).toMatchObject({ flags: ["example_dropped"] });

    const [ev] = await db.select().from(event).where(eq(event.type, "extraction"));
    expect(ev!.data).toMatchObject({
      turn_kind: "decode",
      items: 5,
      kept: 3,
      dropped_not_verbatim: 1,
      dropped_duplicate: 1,
      examples_dropped: 2,
      heard_as_dropped: 1,
      model: "qwen3.5:9b",
      prompt_version: "extract_turn.v1",
      latency_ms: 1234,
    });
    const t = (await db.select().from(turn))[0]!;
    expect(t).toMatchObject({ kind: "decode", extractedAt: T0 });
    const j = (await db.select().from(job))[0]!;
    expect(j).toMatchObject({
      status: "done",
      model: "qwen3.5:9b",
      promptVersion: "extract_turn.v1",
    });
  });

  it("accepts a frame whose slot stands for words in the turn", async () => {
    const { finish } = await oneTurn(TURNS[1]!);
    await finish({
      turn_kind: "say",
      items: [
        { ...term("阿姨，您是说…吗？", "Do you mean …?"), kind: "frame" },
        { ...term("您是说…不行吗？", "invented"), kind: "frame" },
      ],
    });
    const rows = await db.select().from(phrase);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "frame", hanzi: "阿姨，您是说…吗？" });
  });

  it("merges into an active phrase: asked_count up and Again logged (once per import)", async () => {
    const created = await createManualPhrase(
      db,
      PhraseInput.parse({
        kind: "term",
        hanzi: "高压锅",
        english: "pressure cooker",
        cardTypes: ["say"],
      }),
      T0 - DAY,
    );
    if (!created.ok) throw new Error("setup");
    const clock = { now: T0 - DAY, timeZone: "America/Los_Angeles" };
    const roundId = (await startRound(db, clock))!;
    const c = (await getRound(db, roundId, clock))!.cards[0]!;
    await gradeCard(
      db,
      { roundId, cardId: c.cardId, grade: 3, source: "session", durationMs: null },
      clock,
    );
    expect((await getPhrase(db, created.id))!.status).toBe("active");

    const turns = [
      TURNS[0]!,
      { user_text: "gaoyaguo again?", reply_text: "高压锅就是 pressure cooker。", position: 1 },
    ];
    const { import_id } = (await json(await postImport({ turns, turns_total: 2 }))) as {
      import_id: string;
    };
    await drain((t) => ({
      turn_kind: "decode",
      items: [
        term("高压锅", "pressure cooker", {
          heard_as: "gaoyaguo",
          example: t.reply_text.includes("用高压锅")
            ? { hanzi: "用高压锅煮二十分钟就好了。", english: null }
            : null,
        }),
      ],
    }));

    const p = (await getPhrase(db, created.id))!;
    expect(p).toMatchObject({
      status: "active",
      askedCount: 2, // two turns, one import: one bump
      lastAskedAt: T0,
      lastAskedImportId: import_id,
      heardAs: "gaoyaguo",
    });
    expect(p.examples).toHaveLength(1);
    const logs = await db.select().from(reviewLog).where(eq(reviewLog.source, "asked_again"));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ rating: 1, cardId: c.cardId, roundId: null });
    expect(p.cards[0]!.lapses).toBe(0); // a learning card's Again isn't a lapse
    expect(p.cards[0]!.due).toBeLessThanOrEqual(T0 + 10 * MIN);
    const again = await db.select().from(event).where(eq(event.type, "asked_again"));
    expect(again.map((e) => e.data)).toEqual([
      { phrase_id: created.id, status: "active", import_id },
    ]);
    const row = await importRow(import_id);
    expect(row).toMatchObject({ phrasesNew: 0, phrasesAgain: 1 });
    expect(row.summary).toContain("🔁 1 phrase you'd asked about before is back in rotation.");
  });

  it("merges into a queued phrase and re-scores it; examples stay capped at 3", async () => {
    const reply = (n: number) => `泡打粉：例句${n}放一勺泡打粉。`;
    for (let n = 1; n <= 5; n++) {
      const { finish } = await oneTurn(
        { user_text: `baking question ${n}`, reply_text: reply(n), position: 0 },
        `m${n}`,
      );
      await finish({
        turn_kind: "say",
        items: [
          term("泡打粉", "baking powder", {
            example: { hanzi: `例句${n}放一勺泡打粉。`, english: null },
          }),
        ],
      });
    }
    const [p] = await db.select().from(phrase);
    expect(p).toMatchObject({ status: "queued", askedCount: 5 });
    // term 1 + say 1 + 3 × (5 − 1), plus how common 泡打粉 is
    expect(p!.baseScore).toBeCloseTo(
      14 + frequencyPoints({ kind: "term", tags: [], hanziKey: "泡打粉" }),
    );
    expect(p!.examples.map((e) => e.hanzi)).toEqual([
      "例句1放一勺泡打粉。",
      "例句2放一勺泡打粉。",
      "例句3放一勺泡打粉。",
    ]);
    expect(await db.select().from(card)).toHaveLength(1);
  });

  it("revives a dropped phrase", async () => {
    const { finish } = await oneTurn(TURNS[2]!);
    await finish({ turn_kind: "errand", items: [term("泡打粉", "baking powder")] });
    const [p] = await db.select().from(phrase);
    await dropPhrase(db, p!.id, T0 + 1, "remove");

    at(T0 + DAY);
    const next = await oneTurn(
      { user_text: "baking powder again?", reply_text: "就是泡打粉。", position: 0 },
      "m2",
    );
    await next.finish({ turn_kind: "say", items: [term("泡打粉", "baking powder")] });
    const revived = (await getPhrase(db, p!.id))!;
    expect(revived).toMatchObject({ status: "queued", askedCount: 2, droppedAt: null });
    expect(await db.select().from(event).where(eq(event.type, "phrase_revived"))).toHaveLength(1);
    expect(await importRow(next.importId)).toMatchObject({ phrasesNew: 1, phrasesAgain: 0 });
  });

  it("finishes the import with its summary; notifications until notified", async () => {
    const { import_id } = (await json(await postImport({}))) as { import_id: string };
    expect(await json(await notificationsGET(req("/api/agent/notifications", AGENT)))).toEqual({
      notifications: [],
    });
    await drain((t) =>
      t.reply_text.includes("高压锅")
        ? {
            turn_kind: "decode",
            items: [term("高压锅", "pressure cooker", { heard_as: "gaoyaguo", usefulness: 5 })],
          }
        : t.reply_text.includes("泡打粉")
          ? // An errand keeps its first item (config.extraction.errandMaxItems).
            { turn_kind: "errand", items: [term("泡打粉", "baking powder"), term("面粉", "flour")] }
          : { turn_kind: "say", items: [] },
    );
    const row = await importRow(import_id);
    expect(row).toMatchObject({ status: "done", phrasesNew: 2, jobsFailed: 0, finishedAt: T0 });
    expect(row.summary).toBe(
      "✅ 3 new questions → 2 phrases queued. Next up: 高压锅 gāo yā guō (pressure cooker), 泡打粉 pào dǎ fěn (baking powder).\n" +
        "🔗 This share link is public; you can delete it in Gemini → Settings → Public links.",
    );
    const [finished] = await db.select().from(event).where(eq(event.type, "import_finished"));
    expect(finished!.data).toMatchObject({
      import_id,
      turns_total: 3,
      turns_new: 3,
      jobs_failed: 0,
    });

    const n = await json(await notificationsGET(req("/api/agent/notifications", AGENT)));
    expect(n).toEqual({
      notifications: [
        {
          import_id,
          kind: "link",
          discord_channel_id: "c1",
          discord_message_id: "m1",
          summary: row.summary,
        },
      ],
    });
    const ctx = { params: Promise.resolve({ id: import_id }) };
    expect(
      (await notifiedPOST(req(`/api/imports/${import_id}/notified`, AGENT, {}), ctx)).status,
    ).toBe(204);
    expect(
      (await notifiedPOST(req(`/api/imports/${import_id}/notified`, AGENT, {}), ctx)).status,
    ).toBe(204);
    expect((await importRow(import_id)).notifiedAt).toBe(T0);
    expect(await json(await notificationsGET(req("/api/agent/notifications", AGENT)))).toEqual({
      notifications: [],
    });
  });

  it("takes a pasted answer from the web: never notified, at the top of Up next", async () => {
    const r = await importPastedText(db, "你可以说：\n高压锅\n用高压锅煮二十分钟就好了。", T0);
    expect(r).toMatchObject({ ok: true, turnsNew: 1 });
    const c = (await claim())!;
    expect(c.input.user_text).toBe("");
    await done(c.job_id, 1, {
      turn_kind: "say",
      items: [term("高压锅", "pressure cooker", { usefulness: 5 })],
    });
    expect((await listQueue(db, T0))[0]).toMatchObject({ hanzi: "高压锅" });
    expect(
      await importPastedText(db, "你可以说：高压锅。用高压锅煮二十分钟就好了。", T0),
    ).toMatchObject({
      ok: true,
      turnsNew: 0,
    });
    expect(await json(await notificationsGET(req("/api/agent/notifications", AGENT)))).toEqual({
      notifications: [],
    });
  });
});

describe("re-extraction", () => {
  const sentence = (hanzi: string, english: string) => ({
    ...term(hanzi, english),
    kind: "sentence" as const,
  });
  const byKey = async (hanzi: string) =>
    (await db.select().from(phrase).where(eq(phrase.hanzi, hanzi)))[0];

  /** TURNS[1] read with v1 (a fragment and two words), then a newer turn read with v3. */
  async function oldThenNew() {
    const { import_id } = (await json(
      await postImport({ turns: [TURNS[1]!], turns_total: 1 }),
    )) as { import_id: string };
    const c = (await claim())!;
    await done(c.job_id, c.attempt, {
      turn_kind: "say",
      items: [
        term("水", "water", { usefulness: 5 }),
        term("加水", "add water"),
        { ...term("您是说…吗？", "do you mean …?"), kind: "frame" },
      ],
    });
    await notifiedPOST(req(`/api/imports/${import_id}/notified`, AGENT, {}), {
      params: Promise.resolve({ id: import_id }),
    });
    await db.update(phrase).set({ status: "expired" }).where(eq(phrase.hanzi, "加水"));
    await dropPhrase(db, (await byKey("您是说…吗？"))!.id, T0 + 1, "remove");

    at(T0 + DAY);
    await postImport({ discord_message_id: "m2", turns: [TURNS[2]!], turns_total: 1 });
    const c2 = (await claim())!;
    await done(c2.job_id, c2.attempt, { turn_kind: "errand", items: [] }, "extract_turn.v3");
    return import_id;
  }

  it("re-reads turns from an older prompt: replaces their phrases without asking again", async () => {
    const importId = await oldThenNew();
    const before = await importRow(importId);
    expect((await getImportsPage(db)).staleTurns).toBe(1);

    at(T0 + 2 * DAY);
    expect(await queueReextraction(db, T0 + 2 * DAY)).toBe(1);
    expect(await queueReextraction(db, T0 + 2 * DAY)).toBe(0); // already open
    expect(await getImportsPage(db)).toMatchObject({ staleTurns: 0, reextracting: 1 });

    // A new import queued after the re-run is still claimed first.
    await postImport({
      discord_message_id: "m3",
      turns: [{ user_text: "eggs?", reply_text: "鸡蛋。", position: 0 }],
      turns_total: 1,
    });
    const fresh = (await claim())!;
    expect(fresh.input.user_text).toBe("eggs?");
    await done(fresh.job_id, fresh.attempt, { turn_kind: "other", items: [] }, "extract_turn.v3");

    const rerun = (await claim())!;
    expect(rerun.input.user_text).toBe(TURNS[1]!.user_text);
    const r = await done(
      rerun.job_id,
      rerun.attempt,
      {
        turn_kind: "say",
        items: [
          sentence("阿姨，您是说要加水吗？", "Auntie, do you mean add water?"),
          term("加水", "add water", { usefulness: 4 }),
          { ...term("您是说…吗？", "do you mean …?"), kind: "frame" },
        ],
      },
      "extract_turn.v3",
    );
    expect(r.status).toBe(200);

    // New: the sentence, dated to when Will asked (T0), not to the re-run.
    expect(await byKey("阿姨，您是说要加水吗？")).toMatchObject({
      status: "queued",
      askedCount: 1,
      lastAskedAt: T0,
      createdAt: T0 + 2 * DAY,
      lastAskedImportId: importId,
    });
    // Expired and picked again: back, with the new rating. Dropped: stays dropped.
    expect(await byKey("加水")).toMatchObject({ status: "queued", askedCount: 1, usefulness: 4 });
    expect(await byKey("您是说…吗？")).toMatchObject({ status: "dropped" });
    // The fragment v3 no longer picks leaves the queue.
    expect(await byKey("水")).toMatchObject({ status: "expired" });
    expect(await db.select().from(event).where(eq(event.type, "phrase_superseded"))).toHaveLength(
      1,
    );
    expect(await db.select().from(event).where(eq(event.type, "asked_again"))).toHaveLength(0);

    // The import's counters, summary and Discord reply are untouched.
    expect(await importRow(importId)).toEqual(before);
    expect((await pendingNotifications(db)).map((n) => n.import_id)).not.toContain(importId);
    expect((await getImportsPage(db)).staleTurns).toBe(0);
    const [ev] = (await db.select().from(event).where(eq(event.type, "extraction"))).filter(
      (e) => (e.data as { reextract?: boolean }).reextract,
    );
    expect(ev?.data).toMatchObject({ prompt_version: "extract_turn.v3", kept: 3 });
  });

  it("a failed re-run doesn't count on its import, and Retry failed doesn't reopen it", async () => {
    const importId = await oldThenNew();
    const before = await importRow(importId);
    await queueReextraction(db, T0 + 2 * DAY);
    for (let attempt = 1; attempt <= config.jobs.maxAttempts; attempt++) {
      const c = (await claim())!;
      await complete({ job_id: c.job_id, attempt: c.attempt, status: "failed", error: "x" });
    }
    expect(await importRow(importId)).toEqual(before);
    expect(await retryFailedJobs(db)).toBe(1);
    expect(await importRow(importId)).toEqual(before);
  });

  it("has nothing to re-run when every turn used the newest prompt", async () => {
    expect(await queueReextraction(db, T0)).toBe(0);
    await postImport({ turns: [TURNS[2]!], turns_total: 1 });
    expect((await getImportsPage(db)).staleTurns).toBe(0); // not extracted yet
    const c = (await claim())!;
    await done(c.job_id, c.attempt, { turn_kind: "errand", items: [] });
    expect(await queueReextraction(db, T0)).toBe(0);
  });
});

describe("tutor eval", () => {
  type EvalBody = {
    turns: { turn_id: string; import_id: string; user_text: string; reply_text: string }[];
    pool: { turns: number; imports: number };
  };
  const evalGet = async (query = "") => evalTurnsGET(req(`/api/agent/eval/turns${query}`, AGENT));

  it("samples questions with Gemini's answers, skipping image-only turns; seeded", async () => {
    // Two imports; the second has an image-only turn (no prompt text).
    await postImport({});
    await postImport(
      {
        discord_message_id: "m2",
        turns_total: 2,
        turns: [
          { user_text: "", reply_text: "图片里是“奶瓶”。", position: 0 },
          { user_text: "How do I say we're out of milk?", reply_text: "牛奶没了。", position: 1 },
        ],
      },
      { "idempotency-key": "discord:m2" },
    );

    const r = await evalGet("?limit=2&seed=s1");
    expect(r.status).toBe(200);
    const body = (await r.json()) as EvalBody;
    expect(body.pool).toEqual({ turns: 4, imports: 2 });
    expect(body.turns).toHaveLength(2);
    // Spread: one from each import.
    expect(new Set(body.turns.map((t) => t.import_id)).size).toBe(2);
    for (const t of body.turns) {
      expect(Object.keys(t).sort()).toEqual(["import_id", "reply_text", "turn_id", "user_text"]);
      expect(t.user_text.trim()).not.toBe("");
    }
    expect(await json(await evalGet("?limit=2&seed=s1"))).toEqual(body);

    const all = (await (await evalGet()).json()) as EvalBody;
    expect(all.turns).toHaveLength(4);
    expect(all.turns.some((t) => t.reply_text.includes("奶瓶"))).toBe(false);
  });

  it("is read-only: no events, no changes", async () => {
    await postImport({});
    const before = await db.select().from(event);
    await evalGet();
    expect(await db.select().from(event)).toEqual(before);
  });

  it("answers an empty sample from an empty database", async () => {
    expect(await json(await evalGet())).toEqual({ turns: [], pool: { turns: 0, imports: 0 } });
  });

  it("rejects a bad limit or seed with 400 invalid_query", async () => {
    for (const q of ["?limit=0", "?limit=51", "?limit=abc", `?seed=${"x".repeat(101)}`]) {
      const r = await evalGet(q);
      expect(r.status, q).toBe(400);
      expect(await json(r)).toMatchObject({ error: "invalid_query" });
    }
  });
});

describe("a say turn's sentence from a term's example", () => {
  const SAY: FakeTurn = {
    user_text: "How do I tell the nanny the baby needs a bath?",
    reply_text: "可以说：“阿姨，宝宝该洗澡了。”洗澡 means bath.",
    position: 0,
  };
  const onlyTerms: ExtractTurnResult = {
    turn_kind: "say",
    items: [
      term("洗澡", "bath", {
        example: {
          hanzi: "阿姨，宝宝该洗澡了。",
          english: "Auntie, it's time for the baby's bath.",
        },
      }),
    ],
  };
  const sentences = () => db.select().from(phrase).where(eq(phrase.kind, "sentence"));

  it("is made when the model leaves the sentence out", async () => {
    await postImport({ turns: [SAY], turns_total: 1 });
    const c = (await claim())!;
    expect((await done(c.job_id, c.attempt, onlyTerms)).status).toBe(200);
    const [s] = await sentences();
    expect(s).toMatchObject({
      hanzi: "阿姨，宝宝该洗澡了。",
      english: "Auntie, it's time for the baby's bath.",
      status: "queued",
      flags: ["from_example"],
    });
    expect(await db.select().from(card).where(eq(card.phraseId, s!.id))).toMatchObject([
      { type: "say" },
    ]);
  });

  it("is backfilled once by the daily cron for results stored before the rule", async () => {
    config.extraction.promoteExampleSentence = false;
    try {
      await postImport({ turns: [SAY], turns_total: 1 });
      const c = (await claim())!;
      await done(c.job_id, c.attempt, onlyTerms);
    } finally {
      config.extraction.promoteExampleSentence = true;
    }
    expect(await sentences()).toHaveLength(0);

    at(T0 + DAY);
    const cron = async () => json(await cronGET(req("/api/cron/daily", CRON)));
    expect(await cron()).toMatchObject({ sentences_promoted: 1 });
    expect(await sentences()).toMatchObject([
      { hanzi: "阿姨，宝宝该洗澡了。", lastAskedAt: T0, createdAt: T0 + DAY },
    ]);
    // Removed by Will: never made again.
    await dropPhrase(db, (await sentences())[0]!.id, T0 + DAY, "remove");
    expect(await cron()).toMatchObject({ sentences_promoted: 0 });
    expect(await sentences()).toMatchObject([{ status: "dropped" }]);
  });
});

describe("cron", () => {
  it("expires stale queue items and prunes old events", async () => {
    const { finish } = await oneTurn();
    async function oneTurn() {
      await postImport({ turns: [TURNS[2]!], turns_total: 1 });
      const c = (await claim())!;
      return { finish: (r: ExtractTurnResult) => done(c.job_id, c.attempt, r) };
    }
    // term 1, other −1, usefulness 1 → −3, rare word → −3: below −2 already, but young.
    // Flour: 1 − 1 + 3 (usefulness 5), common enough → about 3.5: stays.
    await finish({
      turn_kind: "other",
      items: [
        term("泡打粉", "baking powder", { usefulness: 1 }),
        term("面粉", "flour", { usefulness: 5 }),
      ],
    });
    const manual = await createManualPhrase(
      db,
      PhraseInput.parse({
        kind: "term",
        hanzi: "米粉",
        english: "rice noodles",
        cardTypes: ["say"],
      }),
      T0,
    );

    at(T0 + 20 * DAY); // low score but too young
    expect(await json(await cronGET(req("/api/cron/daily", CRON)))).toMatchObject({
      phrases_expired: 0,
    });
    at(T0 + 31 * DAY);
    const r = await json(await cronGET(req("/api/cron/daily", CRON)));
    expect(r).toMatchObject({ phrases_expired: 1, events_pruned: 0 });
    const rows = await db.select().from(phrase);
    expect(rows.find((p) => p.hanzi === "泡打粉")!.status).toBe("expired");
    // Higher score (flour) and pinned (manual) stay.
    expect(rows.find((p) => p.hanzi === "面粉")!.status).toBe("queued");
    expect(rows.find((p) => manual.ok && p.id === manual.id)!.status).toBe("queued");

    at(T0 + config.events.retainDays * DAY + DAY);
    const later = await json(await cronGET(req("/api/cron/daily", CRON)));
    expect(later.events_pruned).toBeGreaterThan(0);
    expect(await db.select().from(event)).toHaveLength(0);
  });
});
