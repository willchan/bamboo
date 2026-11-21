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
import { GET as backfillGET } from "@/app/api/agent/backfill/route";
import { POST as reextractPOST } from "@/app/api/agent/reextract/route";
import { GET as cronGET } from "@/app/api/cron/daily/route";
import { POST as notifiedPOST } from "@/app/api/imports/[id]/notified/route";
import { POST as knownPOST } from "@/app/api/imports/known/route";
import { POST as importsPOST } from "@/app/api/imports/route";
import { POST as claimPOST } from "@/app/api/jobs/claim/route";
import { POST as completePOST } from "@/app/api/jobs/complete/route";
import { POST as turnsPOST } from "@/app/api/turns/route";
import { POST as heartbeatPOST } from "@/app/api/worker/heartbeat/route";
import { config } from "../config";
import {
  createManualPhrase,
  dropPhrase,
  getPhrase,
  listPhrases,
  listQueue,
  restorePhrase,
  retireUnpicked,
} from "../repo/phrases";
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
const GEMINI = "gemini-3.8-flash";
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
  model = "qwen3.5:9b",
) =>
  complete({
    job_id,
    attempt,
    status: "done",
    result,
    model,
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
  model?: string,
) {
  for (let c = await claim(); c; c = await claim()) {
    const r = await done(c.job_id, c.attempt, answer(c.input), undefined, model);
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
    turns: () => turnsPOST(req("/api/turns", token, {})),
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
    turns: "agent",
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

describe("tutor turns (H5)", () => {
  // Synthetic question and answer (CLAUDE.md › Privacy).
  const turn = {
    user_text: "How do I tell the yuesao the baby is gassy?",
    reply_text: "你可以说：阿姨，宝宝好像胀气了。\n胀气 (zhàng qì) means bloated, gassy.",
    discord_channel_id: "c1",
    discord_message_id: "q1",
    prompt_version: "tutor.v1",
  };
  const postTurn = (body: Record<string, unknown> = {}, token = AGENT) =>
    turnsPOST(req("/api/turns", token, { ...turn, ...body }));

  it("stores one turn and its extract job as a tutor import, already notified", async () => {
    const r = await postTurn();
    expect(r.status).toBe(200);
    const body = (await json(r)) as { import_id: string; turn_new: boolean };
    expect(body.turn_new).toBe(true);
    const imp = await importRow(body.import_id);
    expect(imp).toMatchObject({
      kind: "tutor",
      origin: "discord",
      sourceRef: "tutor.v1",
      conversationTitle: null,
      discordMessageId: "q1",
      idempotencyKey: "tutor:q1",
      turnsTotal: 1,
      turnsNew: 1,
      status: "extracting",
      notifiedAt: T0,
    });
    const c = await claim();
    expect(c!.input).toMatchObject({ user_text: turn.user_text, conversation_title: null });
    expect(c!.input.reply_text).toContain("胀气");
    expect(await claim()).toBeNull();
  });

  it("is idempotent on the Discord message id", async () => {
    const first = (await json(await postTurn())) as { import_id: string };
    const again = await postTurn();
    expect(await json(again)).toEqual({ import_id: first.import_id, turn_new: false });
    expect((await db.select().from(imports)).length).toBe(1);
    expect(await claim()).not.toBeNull();
    expect(await claim()).toBeNull();
  });

  it("gets no Discord summary reply when it finishes", async () => {
    await postTurn();
    await drain(() => ({
      turn_kind: "decode",
      items: [term("胀气", "bloated, gassy")],
    }));
    const [imp] = await db.select().from(imports);
    expect(imp!.status).toBe("done");
    expect(imp!.phrasesNew).toBeGreaterThan(0);
    const n = await json(await notificationsGET(req("/api/agent/notifications", AGENT)));
    expect(n).toEqual({ notifications: [] });
  });

  it("asking the same question again is a new turn; the same answer again is not", async () => {
    await postTurn();
    const sameAnswer = (await json(await postTurn({ discord_message_id: "q2" }))) as {
      turn_new: boolean;
    };
    expect(sameAnswer.turn_new).toBe(false);
    const newAnswer = (await json(
      await postTurn({ discord_message_id: "q3", reply_text: "可以说：宝宝胀气了。" }),
    )) as { turn_new: boolean };
    expect(newAnswer.turn_new).toBe(true);
  });

  it("requires the agent token and a valid body", async () => {
    expect((await postTurn({}, WORKER)).status).toBe(401);
    for (const bad of [
      { user_text: "  " },
      { reply_text: "" },
      { discord_message_id: undefined },
      { prompt_version: "extract_turn.v4" },
    ])
      expect((await postTurn(bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await db.select().from(imports)).length).toBe(0);
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

  // H2b (DESIGN §10 #77): frames are retired. An older worker's frame items are dropped and
  // counted (`dropped_frame`), even one whose slot matches the turn.
  it("drops frame items from an older worker and counts them", async () => {
    const { finish } = await oneTurn(TURNS[1]!);
    await finish({
      turn_kind: "say",
      items: [
        { ...term("阿姨，您是说…吗？", "Do you mean …?"), kind: "frame" },
        { ...term("您是说…不行吗？", "invented"), kind: "frame" },
        term("加水", "add water"),
      ],
    });
    const rows = await db.select().from(phrase);
    expect(rows.map((r) => r.hanzi)).toEqual(["加水"]);
    const [ev] = await db.select().from(event).where(eq(event.type, "extraction"));
    expect(ev?.data).toMatchObject({
      items: 3,
      kept: 1,
      dropped_frame: 2,
      dropped_not_verbatim: 0,
    });
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
    // Good graduated the card (§10 #102), so asked-again's Again is a lapse: relearning in 10m.
    expect(p.cards[0]!.lapses).toBe(1);
    expect(p.cards[0]!.due).toBeLessThanOrEqual(T0 + 10 * MIN);
    const again = await db.select().from(event).where(eq(event.type, "asked_again"));
    expect(again.map((e) => e.data)).toEqual([
      { phrase_id: created.id, status: "active", import_id },
    ]);
    const row = await importRow(import_id);
    expect(row).toMatchObject({ phrasesNew: 0, phrasesAgain: 1 });
    expect(row.summary).toContain("🔁 1 phrase you'd asked about before is back in rotation.");
  });

  it("keeps a written example only from a Gemini job (extract_turn.v7, §10 #103)", async () => {
    const run = async (t: FakeTurn, msg: string, hanzi: string, example: string, model: string) => {
      const { finish } = await oneTurn(t, msg);
      expect(finish).toBeDefined();
      const c = await db.select().from(job);
      const j = c.find((x) => x.status === "leased")!;
      await done(
        j.id,
        j.attempt,
        {
          turn_kind: "errand",
          items: [term(hanzi, "a word", { examples: [{ hanzi: example, english: "Written." }] })],
        },
        "extract_turn.v7",
        model,
      );
      return (await db.select().from(phrase).where(eq(phrase.hanzi, hanzi)))[0]!;
    };
    const gemini = await run(TURNS[0]!, "g1", "高压锅", "高压锅要放多少水？", "gemini-3.8-flash");
    expect(gemini.examples).toEqual([
      { hanzi: "高压锅要放多少水？", english: "Written.", turn_id: expect.any(String) },
    ]);
    const ollama = await run(TURNS[2]!, "o1", "泡打粉", "泡打粉用完了。", "qwen3.8:27b");
    expect(ollama.examples).toEqual([]);
    expect(ollama.flags).toContain("example_dropped");
  });

  it("merges into a queued phrase and re-scores it; examples stay capped at 3", async () => {
    // Distinct uses: rewordings of one sentence would collapse to one (§10 #103).
    const sentences = [
      "放一勺泡打粉。",
      "泡打粉用完了。",
      "超市有泡打粉吗？",
      "泡打粉放冰箱里。",
      "别放太多泡打粉。",
    ];
    for (let n = 1; n <= 5; n++) {
      const ex = sentences[n - 1]!;
      const { finish } = await oneTurn(
        { user_text: `baking question ${n}`, reply_text: `泡打粉：${ex}`, position: 0 },
        `m${n}`,
      );
      await finish({
        turn_kind: "say",
        items: [term("泡打粉", "baking powder", { example: { hanzi: ex, english: null } })],
      });
    }
    const [p] = await db.select().from(phrase);
    expect(p).toMatchObject({ status: "queued", askedCount: 5 });
    // term 1 + say 1 + 3 × (5 − 1), plus how common 泡打粉 is
    expect(p!.baseScore).toBeCloseTo(
      14 + frequencyPoints({ kind: "term", tags: [], hanziKey: "泡打粉" }),
    );
    expect(p!.examples.map((e) => e.hanzi)).toEqual(sentences.slice(0, 3));
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
          ? { turn_kind: "errand", items: [term("泡打粉", "baking powder")] }
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
        term("您是说", "do you mean"),
      ],
    });
    await notifiedPOST(req(`/api/imports/${import_id}/notified`, AGENT, {}), {
      params: Promise.resolve({ id: import_id }),
    });
    await db.update(phrase).set({ status: "expired" }).where(eq(phrase.hanzi, "加水"));
    await dropPhrase(db, (await byKey("您是说"))!.id, T0 + 1, "remove");

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
          term("您是说", "do you mean"),
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
    expect(await byKey("您是说")).toMatchObject({ status: "dropped" });
    // The fragment v3 no longer picks leaves the queue: dropped since H6 (§5.5.6), not expired.
    expect(await byKey("水")).toMatchObject({ status: "dropped" });
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

  it("H6: refreshes picked phrases in any status, keeps cards and history, reports the rest", async () => {
    await oldThenNew();
    // 水 is being learned (a reviewed card); 您是说 was dropped by Will; 加水 expired.
    const water = (await byKey("水"))!;
    await db
      .update(phrase)
      .set({ status: "active", introducedAt: T0 })
      .where(eq(phrase.id, water.id));
    const [waterCard] = await db.select().from(card).where(eq(card.phraseId, water.id));
    await db
      .update(card)
      .set({ state: 2, reps: 3, stability: 7.5, due: T0 + 9 * DAY })
      .where(eq(card.id, waterCard!.id));
    await db.insert(reviewLog).values({
      id: "rl1",
      cardId: waterCard!.id,
      rating: 3,
      source: "session",
      stateBefore: 1,
      roundId: null,
      reviewedAt: T0,
      durationMs: null,
      fsrsLog: {},
    });
    const cardsBefore = await db.select().from(card).orderBy(card.id);
    const dropped = (await byKey("您是说"))!;
    await db
      .update(phrase)
      .set({
        pinyinOverride: [
          ["您", "nin"],
          ["是", "shi"],
          ["说", "shuo"],
        ],
      })
      .where(eq(phrase.id, dropped.id));

    at(T0 + 2 * DAY);
    expect(await queueReextraction(db, T0 + 2 * DAY)).toBe(1);
    const rerun = (await claim())!;
    const breakdown = {
      parts: [
        { hanzi: "加", gloss: "add" },
        { hanzi: "水", gloss: "water" },
      ],
      meaning: "to add water",
    };
    await done(
      rerun.job_id,
      rerun.attempt,
      {
        turn_kind: "say",
        items: [
          term("加水", "to add water", { note: "cooking", breakdown, pinyin: ["jiā", "shuǐ"] }),
          term("您是说", "you mean…?", { pinyin: ["nín", "shì", "shuō"] }),
        ],
      },
      "extract_turn.v4",
    );

    // Picked, any status: new English, note, breakdown and merged pinyin; hanzi as it was.
    expect(await byKey("加水")).toMatchObject({
      status: "queued",
      english: "to add water",
      note: "cooking",
      breakdown,
      pinyin: [
        ["加", "jiā"],
        ["水", "shuǐ"],
      ],
      pinyinSources: [],
      askedCount: 1,
    });
    // Dropped stays dropped, refreshed, and Will's override is kept.
    expect(await byKey("您是说")).toMatchObject({
      status: "dropped",
      english: "you mean…?",
      pinyinOverride: [
        ["您", "nin"],
        ["是", "shi"],
        ["说", "shuo"],
      ],
    });
    // Not picked but being learned: reported, not changed.
    const reported = (await byKey("水"))!;
    expect(reported).toMatchObject({ status: "active", unpickedAt: T0 + 2 * DAY });
    expect(await db.select().from(card).orderBy(card.id)).toEqual(cardsBefore);
    const [ev] = (await db.select().from(event).where(eq(event.type, "extraction"))).filter(
      (e) => (e.data as { reextract?: boolean }).reextract,
    );
    expect(ev?.data).toMatchObject({
      phrases_created: 0,
      phrases_refreshed: 2,
      phrases_dropped: 0,
      phrases_reported: 1,
    });

    // The filter lists it; Imports counts it; Retire drops it and keeps the history.
    expect((await listPhrases(db, { unpicked: true })).map((p) => p.hanzi)).toEqual(["水"]);
    expect((await getImportsPage(db)).unpicked).toBe(1);
    expect(await retireUnpicked(db, T0 + 3 * DAY, ["someone-else"])).toBe(0);
    expect(await retireUnpicked(db, T0 + 3 * DAY)).toBe(1);
    expect(await byKey("水")).toMatchObject({ status: "dropped", droppedAt: T0 + 3 * DAY });
    expect(await db.select().from(reviewLog)).toHaveLength(1);
    expect(await db.select().from(card).orderBy(card.id)).toEqual(cardsBefore);
    expect(await listPhrases(db, { unpicked: true })).toEqual([]);
    expect((await getImportsPage(db)).unpicked).toBe(0);
    // Restoring brings it back with its card's state, and it's no longer reported.
    expect(await restorePhrase(db, water.id, T0 + 4 * DAY)).toBe(true);
    expect(await byKey("水")).toMatchObject({ status: "active", unpickedAt: null });
  });

  it("H6: a re-run can take turns already on the newest prompt, N at a time, oldest first", async () => {
    await postImport({});
    await drain(() => ({ turn_kind: "other", items: [] }));
    // All three turns are on the newest prompt: nothing is stale.
    expect(await queueReextraction(db, T0)).toBe(0);

    const r = await reextractPOST(req("/api/agent/reextract", AGENT, { all: true, limit: 2 }));
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ queued: 2, open: 2 });
    // Open re-runs aren't queued twice.
    expect(
      await json(await reextractPOST(req("/api/agent/reextract", AGENT, { all: true, limit: 2 }))),
    ).toEqual({ queued: 1, open: 3 });
    const first = (await claim())!;
    expect(first.input.user_text).toBe(TURNS[0]!.user_text);
    await done(first.job_id, first.attempt, { turn_kind: "other", items: [] }, undefined, GEMINI);
    await drain(() => ({ turn_kind: "other", items: [] }), GEMINI);

    // Every turn has now been re-read with the newest prompt: a second full run queues nothing.
    expect(
      await json(await reextractPOST(req("/api/agent/reextract", AGENT, { all: true }))),
    ).toEqual({ queued: 0, open: 0 });
    const queuedEvents = await db.select().from(event).where(eq(event.type, "reextract_queued"));
    expect(queuedEvents.map((e) => e.data)).toEqual([
      { turns: 2, all: true, limit: 2 },
      { turns: 1, all: true, limit: 2 },
    ]);
  });

  it("re-runs only the turns the name filter acted on, on any prompt (§10 #104)", async () => {
    await postImport({});
    // Turn 0's extraction had the name filter rewrite something; the others had none.
    for (let i = 0; i < 3; i++) {
      const c = (await claim())!;
      await complete({
        job_id: c.job_id,
        attempt: c.attempt,
        status: "done",
        result: { turn_kind: "other", items: [] },
        model: GEMINI,
        prompt_version: "extract_turn.v7",
        dropped_name: c.input.user_text === TURNS[0]!.user_text ? 2 : 0,
      });
    }
    // Everything is on the newest prompt, so a plain or full run takes nothing new...
    expect(await queueReextraction(db, T0)).toBe(0);
    // ...but `named` takes the one turn.
    const r = await reextractPOST(req("/api/agent/reextract", AGENT, { named: true }));
    expect(await json(r)).toEqual({ queued: 1, open: 1 });
    const job1 = (await claim())!;
    expect(job1.input.user_text).toBe(TURNS[0]!.user_text);
    // Re-read with the fixed filter (nothing rewritten): no longer taken.
    await complete({
      job_id: job1.job_id,
      attempt: job1.attempt,
      status: "done",
      result: { turn_kind: "other", items: [] },
      model: GEMINI,
      prompt_version: "extract_turn.v7",
      dropped_name: 0,
    });
    expect(
      await json(await reextractPOST(req("/api/agent/reextract", AGENT, { named: true }))),
    ).toEqual({ queued: 0, open: 0 });
    const queuedEvents = await db.select().from(event).where(eq(event.type, "reextract_queued"));
    expect(queuedEvents.map((e) => e.data)).toEqual([
      { turns: 1, all: false, limit: null, named: true },
    ]);
  });

  it("H6: the re-run route needs the agent token and a valid body", async () => {
    expect((await reextractPOST(req("/api/agent/reextract", WORKER, {}))).status).toBe(401);
    expect((await reextractPOST(req("/api/agent/reextract", AGENT, { limit: 0 }))).status).toBe(
      400,
    );
    expect((await reextractPOST(req("/api/agent/reextract", AGENT, { nope: 1 }))).status).toBe(400);
    expect(await json(await reextractPOST(req("/api/agent/reextract", AGENT, {})))).toEqual({
      queued: 0,
      open: 0,
    });
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
  // H2b (DESIGN §10 #79): no expiry and no budget. Unseen phrases stay queued however low they
  // score or long they wait, until they're learned (or Will says Not useful).
  it("expires nothing and prunes old events", async () => {
    const { finish } = await oneTurn();
    async function oneTurn() {
      await postImport({ turns: [TURNS[2]!], turns_total: 1 });
      const c = (await claim())!;
      return { finish: (r: ExtractTurnResult) => done(c.job_id, c.attempt, r) };
    }
    // term 1, other −1, usefulness 1 → −3, rare word: about −3. Flour scores about 3.5.
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

    // Old expiry would have taken 泡打粉 (sunk, older than 30 days) and, with a budget of a few
    // phrases, anything ranked past it.
    for (const days of [31, 120]) {
      at(T0 + days * DAY);
      const r = await json(await cronGET(req("/api/cron/daily", CRON)));
      expect(r).toMatchObject({ events_pruned: 0 });
      expect(r).not.toHaveProperty("phrases_expired");
      const rows = await db.select().from(phrase);
      expect(rows.map((p) => p.status)).toEqual(["queued", "queued", "queued"]);
      expect(rows.some((p) => manual.ok && p.id === manual.id)).toBe(true);
    }

    at(T0 + config.events.retainDays * DAY + DAY);
    const later = await json(await cronGET(req("/api/cron/daily", CRON)));
    expect(later.events_pruned).toBeGreaterThan(0);
    expect(await db.select().from(event)).toHaveLength(0);
  });
});

describe("H7 backfill", () => {
  const claimBackfill = async () => {
    const r = await claimPOST(
      req("/api/jobs/claim", WORKER, { types: ["extract_turn", "pinyin"], reextract_only: true }),
    );
    return r.status === 204
      ? null
      : ((await r.json()) as { job_id: string; attempt: number; type: string });
  };
  const report = async (since?: number) =>
    json(
      await backfillGET(
        req(`/api/agent/backfill${since === undefined ? "" : `?since=${since}`}`, AGENT),
      ),
    );

  it("a reextract_only claim takes re-runs and leaves ordinary jobs to the everyday worker", async () => {
    await postImport({});
    await drain(() => ({ turn_kind: "other", items: [] }));
    expect(await claimBackfill()).toBeNull();
    await reextractPOST(req("/api/agent/reextract", AGENT, { all: true, limit: 1 }));
    // A new import arrives during the backfill: its job is older-first for the everyday worker only.
    await postImport({
      discord_message_id: "m2",
      source_ref: "https://gemini.google.com/share/fake2",
      turns_total: 1,
      turns: [{ user_text: "Another question?", reply_text: "好的。", position: 0 }],
    });
    const c = (await claimBackfill())!;
    expect(c.type).toBe("extract_turn");
    expect(
      (await db.query.job.findFirst({ where: (j, { eq: e }) => e(j.id, c.job_id) }))?.reextract,
    ).toBe(true);
    expect(await claimBackfill()).toBeNull();
    // The everyday claim still gets the new import's job.
    expect(await claim()).not.toBeNull();
  });

  it("reports counts only: turns, the reply cap, and a re-run's sums since a time", async () => {
    await postImport({});
    await postImport({
      discord_message_id: "m2",
      source_ref: "https://gemini.google.com/share/fake2",
      turns_total: 1,
      turns: [
        {
          user_text: "Long one?",
          reply_text: "好".repeat(config.imports.replyMaxChars + 50),
          position: 0,
        },
      ],
    });
    await drain(() => ({ turn_kind: "other", items: [] }));

    const before = await report();
    expect(before).toMatchObject({
      since: 0,
      newest_prompt: "extract_turn.v1",
      turns: {
        stored: 4,
        on_newest_prompt: 4,
        reread_on_newest_prompt: 0,
        remaining: 4,
        no_finished_job: 0,
        latest_on_fallback: 4,
        open_reextract: 0,
        reply_at_cap: 1,
        reply_max_chars: config.imports.replyMaxChars,
      },
      run: { turns: 0, items_per_turn: [] },
      review: { review_log_rows: 0, reviewed_cards: 0 },
    });
    // No text in the report: every leaf is a number, a model name or the prompt version.
    expect(JSON.stringify(before)).not.toContain("好");

    const since = T0 + MIN;
    at(since);
    await reextractPOST(req("/api/agent/reextract", AGENT, { all: true, limit: 1 }));
    expect((await report(since)).turns).toMatchObject({ open_reextract: 1, remaining: 3 });
    const c = (await claimBackfill())!;
    const r = await done(
      c.job_id,
      c.attempt,
      {
        turn_kind: "decode",
        items: [term("高压锅", "pressure cooker"), term("不在这里", "not here")],
      },
      "extract_turn.v4",
      GEMINI,
    );
    expect(r.status).toBe(200);

    const after = await report(since);
    expect(after).toMatchObject({
      since,
      newest_prompt: "extract_turn.v4",
      turns: {
        stored: 4,
        on_newest_prompt: 1,
        reread_on_newest_prompt: 1,
        remaining: 3,
        latest_on_fallback: 3,
        open_reextract: 0,
      },
      run: {
        turns: 1,
        failed: 0,
        items_per_turn: [2],
        items: 2,
        kept: 1,
        sentence_promoted: 0,
        dropped: { dropped_not_verbatim: 1 },
        phrases_created: 1,
        models: { [GEMINI]: 1 },
      },
    });
    // Before `since`, nothing.
    expect((await report(since + DAY)).run).toMatchObject({ turns: 0 });
  });

  it("a full run re-runs turns whose latest result came from the Ollama fallback", async () => {
    await postImport({});
    await drain(() => ({ turn_kind: "other", items: [] }), GEMINI);
    await reextractPOST(req("/api/agent/reextract", AGENT, { all: true }));
    // Two re-runs land on Gemini, one on the fallback.
    for (const model of [GEMINI, GEMINI, "qwen3.8:27b"]) {
      const c = (await claimBackfill())!;
      await done(c.job_id, c.attempt, { turn_kind: "other", items: [] }, "extract_turn.v4", model);
    }
    expect((await report()).turns).toMatchObject({ latest_on_fallback: 1, remaining: 1 });
    // The Imports button (stale prompts only) still leaves it alone; `all` takes it again.
    expect(await queueReextraction(db, T0)).toBe(0);
    expect(
      await json(await reextractPOST(req("/api/agent/reextract", AGENT, { all: true }))),
    ).toEqual({ queued: 1, open: 1 });
    const c = (await claimBackfill())!;
    await done(c.job_id, c.attempt, { turn_kind: "other", items: [] }, "extract_turn.v4", GEMINI);
    expect((await report()).turns).toMatchObject({ latest_on_fallback: 0, remaining: 0 });
    expect(
      await json(await reextractPOST(req("/api/agent/reextract", AGENT, { all: true }))),
    ).toEqual({ queued: 0, open: 0 });
  });

  it("records what the worker cut to the caps (trimmed_over_cap) and sums it", async () => {
    await postImport({});
    await drain(() => ({ turn_kind: "other", items: [] }), GEMINI);
    await reextractPOST(req("/api/agent/reextract", AGENT, { all: true, limit: 1 }));
    const c = (await claimBackfill())!;
    const r = await complete({
      job_id: c.job_id,
      attempt: c.attempt,
      status: "done",
      result: { turn_kind: "other", items: [] },
      model: GEMINI,
      prompt_version: "extract_turn.v4",
      trimmed_over_cap: 3,
    });
    expect(r.status).toBe(200);
    expect((await report()).run).toMatchObject({ turns: 1, dropped: { trimmed_over_cap: 3 } });
  });

  it("needs the agent token and a valid since", async () => {
    expect((await backfillGET(req("/api/agent/backfill", WORKER))).status).toBe(401);
    expect((await backfillGET(req("/api/agent/backfill?since=-1", AGENT))).status).toBe(400);
    expect((await backfillGET(req("/api/agent/backfill?since=x", AGENT))).status).toBe(400);
  });
});
