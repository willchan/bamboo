// The worker on Gemini (PLAN H4) with a fake Gemini, a fake Ollama and a fake engine: the rate
// limiter, 429 backoff, the daily quota waiting for the reset, the fallback to Ollama, the name
// filter on a synthetic deny file, pinyin jobs, and no turn text or key in the logs. Synthetic
// turns and placeholder names only.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNSERVABLE_KEYWORDS,
  sharedConfig,
  type ExtractTurnInput,
  type PinyinJobInput,
} from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import { EngineClient } from "./api";
import { GeminiClient, errorDetail } from "./gemini";
import { loadDenyList, parseDenyList, type DenyList } from "./names";
import { OllamaClient } from "./ollama";
import { loadPrompt } from "./prompt";
import { RateLimiter, nextMidnight } from "./rate-limit";
import {
  FakeClock,
  FakeEngine,
  FakeGemini,
  FakeOllama,
  fixtureTurns,
  ollamaFixtures as F,
} from "./test-fakes";
import { Worker, type WorkerDeps } from "./worker";

const VALID = F.chat_valid.message.content;
const POLL = 15_000;
const W = sharedConfig.worker;
const G = W.gemini;
const TURN = fixtureTurns[0]!;

function setup(
  o: {
    rpm?: number;
    rpd?: number;
    deny?: DenyList;
    idlePolls?: number;
    deps?: Partial<WorkerDeps>;
  } = {},
) {
  const engine = new FakeEngine();
  const ollama = new FakeOllama();
  const fake = new FakeGemini();
  const clock = new FakeClock();
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const limiter = new RateLimiter(
    {
      requestsPerMinute: o.rpm ?? 100,
      requestsPerDay: o.rpd ?? 1000,
      timeZone: G.quotaTimeZone,
    },
    clock.now,
  );
  const gemini = new GeminiClient("gemini-test", fake.key, limiter, {
    apiUrl: "https://gemini.test/v1beta",
    fetchFn: fake.fetch,
    now: clock.now,
    sleep: (ms) => clock.sleep(ms, new AbortController().signal),
    log,
  });
  const worker = new Worker({
    engine: new EngineClient("https://bamboo.test", engine.token, engine.fetch),
    ollama: new OllamaClient("http://ollama.test", "qwen3.5:9b", ollama.fetch),
    gemini,
    prompt: loadPrompt(),
    pinyinPrompts: { reading: loadPrompt("pinyin_reading"), referee: loadPrompt("pinyin_referee") },
    deny: o.deny ?? parseDenyList(""),
    model: "qwen3.5:9b",
    pollIntervalMs: POLL,
    version: "0.2.0",
    sha: "abc123",
    log,
    now: clock.now,
    sleep: clock.sleep,
    ...o.deps,
  });
  let idle = 0;
  const idlePolls = o.idlePolls ?? 1;
  clock.afterSleep = (ms) => {
    idle = ms === POLL ? idle + 1 : 0;
    if (idle >= idlePolls) worker.stop();
  };
  return { engine, ollama, fake, clock, worker, lines, limiter, gemini };
}

describe("RateLimiter", () => {
  it("holds requests to the per-minute window", () => {
    let t = 1_000_000;
    const l = new RateLimiter(
      { requestsPerMinute: 2, requestsPerDay: 100, timeZone: "UTC" },
      () => t,
    );
    expect(l.waitMs()).toBe(0);
    l.record();
    t += 10_000;
    l.record();
    expect(l.waitMs()).toBe(50_000);
    t += 50_000;
    expect(l.waitMs()).toBe(0);
  });

  it("counts the day and resets at midnight Pacific", () => {
    // 2026-11-19 23:00 PST = 2026-11-20 07:00Z.
    let t = Date.parse("2026-11-20T07:00:00Z");
    const l = new RateLimiter(
      { requestsPerMinute: 100, requestsPerDay: 2, timeZone: "America/Los_Angeles" },
      () => t,
    );
    l.record();
    l.record();
    expect(l.quotaResetAt()).toBe(Date.parse("2026-11-20T08:00:00Z"));
    t = Date.parse("2026-11-20T08:00:01Z");
    expect(l.quotaResetAt()).toBeNull();
    // Google's 429 says it's used up: wait for the reset even below our own count.
    expect(l.exhaust()).toBe(Date.parse("2026-11-21T08:00:00Z"));
    expect(l.quotaResetAt()).toBe(Date.parse("2026-11-21T08:00:00Z"));
  });

  it("finds local midnight across DST changes", () => {
    const tz = "America/Los_Angeles";
    // The night PDT ends (2026-11-01) is 25 hours long; the night it starts (2026-03-08), 23.
    expect(nextMidnight(Date.parse("2026-11-01T12:00:00Z"), tz)).toBe(
      Date.parse("2026-11-02T08:00:00Z"),
    );
    expect(nextMidnight(Date.parse("2026-03-08T12:00:00Z"), tz)).toBe(
      Date.parse("2026-03-09T07:00:00Z"),
    );
  });
});

describe("worker on Gemini", () => {
  it("extracts on Gemini with only the prompt and the whole turn; keeps Gemini's pinyin", async () => {
    const { engine, fake, worker, ollama } = setup();
    const long: ExtractTurnInput = {
      ...TURN,
      reply_text: `${TURN.reply_text}\n${"好".repeat(7000)}`,
    };
    engine.add(long);
    fake.replies = [VALID];
    await worker.run();

    expect(engine.completes[0]).toMatchObject({
      status: "done",
      model: "gemini-test",
      prompt_version: "extract_turn.v5",
      dropped_name: 0,
    });
    const result = (engine.completes[0] as { result: { items: { pinyin: unknown }[] } }).result;
    expect(result.items[0]!.pinyin).toEqual(["gāo", "yā", "guō"]);
    expect(ollama.chatBodies).toHaveLength(0);

    const req = fake.bodies[0]!;
    // The key travels in a header, never in the URL.
    expect(req.url).toBe("https://gemini.test/v1beta/models/gemini-test:generateContent");
    expect(req.headers.get("x-goog-api-key")).toBe(fake.key);
    const body = req.body as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
      generationConfig: Record<string, unknown>;
    };
    expect(Object.keys(body).sort()).toEqual(["contents", "generationConfig", "systemInstruction"]);
    expect(body.systemInstruction.parts[0]!.text).toBe(loadPrompt().system);
    expect(body.contents).toHaveLength(1);
    // The whole stored turn (no 6,000-character cut for Gemini).
    expect(body.contents[0]!.parts[0]!.text).toContain("好".repeat(7000));
    expect(body.contents[0]!.parts[0]!.text).not.toContain("[… reply cut here]");
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json" });
    expect(body.generationConfig.responseJsonSchema).not.toHaveProperty("$schema");

    expect(engine.heartbeats[0]).toMatchObject({ gemini_model: "gemini-test", gemini_ok: true });
    expect(engine.claimTypes[0]).toEqual(["extract_turn", "pinyin"]);
  });

  it("waits out the per-minute limit before a request", async () => {
    const { engine, fake, worker, clock } = setup({ rpm: 1 });
    engine.add(fixtureTurns[0]!);
    engine.add(fixtureTurns[0]!, "job-2");
    fake.replies = [VALID, VALID];
    await worker.run();
    expect(engine.completes.map((c) => c.status)).toEqual(["done", "done"]);
    expect(clock.slept[0]).toBe(60_000);
  });

  it("backs off on a per-minute 429 (Google's retryDelay), then succeeds on Gemini", async () => {
    const { engine, fake, worker, clock, lines } = setup();
    engine.add(TURN);
    fake.replies = [429, VALID];
    await worker.run();
    expect(clock.slept[0]).toBe(7_000);
    expect(engine.completes[0]).toMatchObject({ status: "done", model: "gemini-test" });
    expect(lines.some((l) => /rate limited \(HTTP 429 RESOURCE_EXHAUSTED\)/u.test(l))).toBe(true);
  });

  it("a used-up daily quota fails the job without Ollama and stops claims until the reset", async () => {
    const { engine, fake, worker, clock, ollama, limiter } = setup();
    engine.add(TURN);
    engine.add(TURN, "job-2");
    fake.replies = [{ status: 429, daily: true }, VALID, VALID];
    const reset = nextMidnight(clock.now(), G.quotaTimeZone);
    let rechecks = 0;
    clock.afterSleep = (ms) => {
      if (ms === W.modelRecheckSeconds * 1000) {
        rechecks += 1;
        if (rechecks === 2) clock.t = reset; // the night passes
      }
      if (ms === POLL) worker.stop();
    };
    await worker.run();
    expect(engine.completes[0]).toMatchObject({
      job_id: "job-1",
      status: "failed",
      model: "gemini-test",
    });
    expect((engine.completes[0] as { error: string }).error).toMatch(/daily quota/u);
    expect(ollama.chatBodies).toHaveLength(0);
    // No claims while the quota is used up (two re-checks), then both jobs on Gemini.
    expect(rechecks).toBe(2);
    expect(engine.claimTypes).toHaveLength(4);
    expect(engine.completes.slice(1).map((c) => [c.job_id, c.attempt, c.status, c.model])).toEqual([
      ["job-1", 2, "done", "gemini-test"],
      ["job-2", 1, "done", "gemini-test"],
    ]);
    expect(limiter.quotaResetAt()).toBeNull();
  });

  it("falls back to Ollama when Gemini keeps failing, without Gemini's pinyin, and rests Gemini", async () => {
    const { engine, fake, worker, clock, ollama, lines } = setup({ idlePolls: 1 });
    engine.add(TURN);
    engine.add(TURN, "job-2");
    fake.replies = [503, "network"];
    ollama.replies = [VALID, VALID];
    await worker.run();
    expect(engine.completes.map((c) => [c.job_id, c.status, c.model])).toEqual([
      ["job-1", "done", "qwen3.5:9b"],
      ["job-2", "done", "qwen3.5:9b"],
    ]);
    const items = (engine.completes[0] as { result: { items: { pinyin: unknown }[] } }).result
      .items;
    expect(items[0]!.pinyin).toBeNull();
    // Two Gemini tries for job 1 (a pause between), none for job 2 while Gemini rests.
    expect(fake.bodies).toHaveLength(2);
    expect(clock.slept[0]).toBe(G.retryPauseSeconds * 1000);
    // The fallback uses the same v4 prompt.
    expect(ollama.chatBodies[0]!.messages[0]!.content).toBe(loadPrompt().system);
    expect(engine.claimTypes[1]).toEqual(["extract_turn"]);
    expect(lines.some((l) => l.includes("gemini rests"))).toBe(true);

    // After the rest, Gemini is tried again.
    clock.t += G.downMinutes * 60_000;
    expect(worker.geminiOk()).toBe(true);
  });

  it("a key Gemini refuses (4xx) also falls back", async () => {
    const { engine, fake, worker, ollama } = setup();
    engine.add(TURN);
    fake.replies = [403];
    ollama.replies = [VALID];
    await worker.run();
    expect(engine.completes[0]).toMatchObject({ status: "done", model: "qwen3.5:9b" });
  });
});

describe("name filter (synthetic deny file)", () => {
  const denyFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "bamboo-deny-"));
    const path = join(dir, "names.deny");
    writeFileSync(path, "# placeholder names only\n\nZorblat\n测名\n", { mode: 0o600 });
    return path;
  };

  it("loads the file: names, comments and blanks", () => {
    const d = loadDenyList(denyFile());
    expect(d).toMatchObject({ loaded: true, count: 2, tooOpen: false });
    expect(d.matches("ask zorblat")).toBe(true);
    expect(d.matches("Zorblatty")).toBe(false); // Latin names match whole words
    expect(d.matches("给测名洗澡")).toBe(true);
    expect(loadDenyList("/nonexistent/names.deny")).toMatchObject({ loaded: false, count: 0 });
  });

  it("drops items and examples with a name, rewrites English, counts only", async () => {
    const reply = JSON.stringify({
      turn_kind: "say",
      items: [
        {
          kind: "sentence",
          hanzi: "测名该洗澡了。",
          english: "Time for a bath",
          note: null,
          heard_as: null,
          examples: [],
          usefulness: 4,
          tags: ["baby"],
          pinyin: [],
          breakdown: null,
        },
        {
          kind: "term",
          hanzi: "洗澡",
          english: "bathe (Zorblat's bath)",
          note: null,
          heard_as: null,
          examples: [
            { hanzi: "测名该洗澡了。", english: null },
            { hanzi: "宝宝该洗澡了。", english: "Zorblat should take a bath" },
          ],
          usefulness: 4,
          tags: ["baby"],
          pinyin: ["xǐ", "zǎo"],
          breakdown: {
            parts: [
              { hanzi: "洗", gloss: "wash" },
              { hanzi: "澡", gloss: "bath" },
            ],
            summary: "Washing the body.",
          },
        },
      ],
    });
    const { engine, fake, worker, lines } = setup({ deny: loadDenyList(denyFile()) });
    const turn: ExtractTurnInput = {
      turn_id: "fx-names",
      conversation_title: null,
      user_text: "how do I say time for a bath",
      reply_text: "测名该洗澡了。宝宝该洗澡了。",
    };
    engine.add(turn);
    fake.replies = [reply];
    await worker.run();
    const c = engine.completes[0] as {
      dropped_name: number;
      result: {
        items: {
          hanzi: string;
          english: string;
          examples: { hanzi: string; english: string | null }[];
        }[];
      };
    };
    expect(c.result.items.map((i) => i.hanzi)).toEqual(["洗澡"]);
    expect(c.result.items[0]!.english).toBe("bathe (someone's bath)");
    expect(c.result.items[0]!.examples).toEqual([
      { hanzi: "宝宝该洗澡了。", english: "someone should take a bath" },
    ]);
    // item, example, two English rewrites
    expect(c.dropped_name).toBe(4);
    const all = lines.join("\n");
    expect(all).toContain("4 name match(es) dropped");
    expect(all).toContain("name filter: 2 name(s)");
    expect(all).not.toMatch(/Zorblat|测名/u);
  });

  it("warns when there is no deny file", async () => {
    const { worker, lines } = setup({ deny: loadDenyList("/nonexistent/names.deny") });
    await worker.run();
    expect(lines.some((l) => l.startsWith("warning: no name deny-list"))).toBe(true);
  });
});

describe("logs", () => {
  it("never carry turn text, model output or the key", async () => {
    const { engine, fake, worker, lines } = setup();
    engine.add(TURN);
    engine.add(TURN, "job-2");
    fake.replies = [429, VALID, 500, 500];
    const ollama = new FakeOllama();
    void ollama;
    await worker.run();
    const all = lines.join("\n");
    expect(all).not.toContain(fake.key);
    for (const s of ["gaoyaguo", "高压锅", "pressure cooker", "yuesao", "Talking"]) {
      expect(all).not.toContain(s);
    }
  });
});

describe("Gemini's schema and the caps (H7: too many states for serving)", () => {
  it("sends no length, count or range limit, and cuts an over-cap reply, counting the cut", async () => {
    const { engine, fake, worker } = setup();
    engine.add(TURN);
    const valid = JSON.parse(VALID) as { turn_kind: string; items: Record<string, unknown>[] };
    const first = valid.items[0]!;
    const over = {
      ...valid,
      items: Array.from({ length: sharedConfig.extraction.maxItems + 2 }, () => ({
        ...first,
        tags: ["food", "cooking", "household", "time"],
      })),
    };
    fake.replies = [JSON.stringify(over)];
    await worker.run();
    const sent = JSON.stringify(
      (fake.bodies[0]!.body.generationConfig as { responseJsonSchema: unknown }).responseJsonSchema,
    );
    for (const k of UNSERVABLE_KEYWORDS) expect(sent).not.toContain(`"${k}"`);
    expect(sent).toContain('"enum"');
    expect(engine.completes[0]).toMatchObject({
      status: "done",
      // 2 items past the cap, and 1 tag past the cap on each of the 12 kept.
      trimmed_over_cap: 2 + sharedConfig.extraction.maxItems,
    });
    const result = (engine.completes[0] as { result: { items: unknown[] } }).result;
    expect(result.items).toHaveLength(sharedConfig.extraction.maxItems);
  });
});

describe("H7 backfill worker (reextract only, until idle)", () => {
  it("takes only re-runs and pinyin jobs, counts its Gemini requests, and stops when idle", async () => {
    const { engine, fake, worker, lines } = setup({
      deps: { reextractOnly: true, untilIdle: true },
      idlePolls: 99,
    });
    engine.add(TURN, "new-import");
    engine.add(TURN, "rerun-1", true);
    engine.add(TURN, "rerun-2", true);
    fake.replies = [VALID, VALID];
    await worker.run();
    expect(engine.completes.map((c) => c.job_id)).toEqual(["rerun-1", "rerun-2"]);
    expect(engine.jobs.find((j) => j.job_id === "new-import")?.status).toBe("queued");
    expect(engine.claimReextractOnly.every(Boolean)).toBe(true);
    expect(worker.reports.map((r) => r.promptVersion)).toEqual([
      "extract_turn.v5",
      "extract_turn.v5",
    ]);
    expect(lines).toContain("until-idle: nothing left to claim; stopping");
  });

  it("stops instead of waiting for the reset when the daily quota is used up", async () => {
    const { engine, fake, worker, lines, limiter } = setup({
      deps: { reextractOnly: true, untilIdle: true },
      idlePolls: 99,
    });
    engine.add(TURN, "rerun-1", true);
    engine.add(TURN, "rerun-2", true);
    fake.replies = [{ status: 429, daily: true }];
    await worker.run();
    expect(limiter.quotaResetAt()).not.toBeNull();
    expect(engine.completes.map((c) => [c.job_id, c.status])).toEqual([["rerun-1", "failed"]]);
    expect(lines).toContain("until-idle: the daily quota is used up; stopping");
  });

  it("an everyday worker sends no reextract_only and counts requests on the client", async () => {
    const { engine, fake, worker, gemini } = setup();
    engine.add(TURN);
    fake.replies = [429, VALID];
    await worker.run();
    expect(engine.claimReextractOnly.some(Boolean)).toBe(false);
    // Retries count: two requests reached Google.
    expect(fake.bodies).toHaveLength(2);
    expect(gemini.requests).toBe(2);
  });
});

describe("a request Gemini refuses (H7's 400)", () => {
  const BAD_SCHEMA = {
    status: 400,
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message:
        "Invalid JSON payload received. Unknown name \"foo\" at 'generation_config': Cannot find field.",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.BadRequest",
          fieldViolations: [{ field: "generation_config", description: "Cannot find field." }],
        },
      ],
    },
  };

  it("logs Google's message and field violations, never the turn", async () => {
    const { engine, fake, worker, lines, ollama } = setup();
    engine.add(TURN);
    fake.replies = [BAD_SCHEMA];
    ollama.replies = [VALID];
    await worker.run();
    const line = lines.find((l) => l.includes("HTTP 400"))!;
    expect(line).toContain("INVALID_ARGUMENT");
    expect(line).toContain("Unknown name");
    expect(line).toContain("field generation_config: Cannot find field.");
    // The everyday worker still falls back.
    expect(engine.completes[0]).toMatchObject({ status: "done", model: "qwen3.5:9b" });
    for (const l of lines) {
      expect(l).not.toContain(TURN.reply_text.slice(0, 12));
      expect(l).not.toContain(fake.key);
    }
  });

  it("a gemini-only (backfill) worker fails the job and stops instead of falling back", async () => {
    const { engine, fake, worker, ollama, lines } = setup({
      deps: { reextractOnly: true, untilIdle: true, geminiOnly: true },
      idlePolls: 99,
    });
    engine.add(TURN, "rerun-1", true);
    engine.add(TURN, "rerun-2", true);
    fake.replies = [BAD_SCHEMA, VALID];
    ollama.replies = [VALID, VALID];
    await worker.run();
    expect(ollama.chatBodies).toHaveLength(0);
    expect(engine.completes).toHaveLength(1);
    expect(engine.completes[0]).toMatchObject({
      job_id: "rerun-1",
      status: "failed",
      model: "gemini-test",
    });
    expect((engine.completes[0] as { error: string }).error).toMatch(/HTTP 400 INVALID_ARGUMENT/u);
    expect(worker.refused).toMatch(/Unknown name/u);
    expect(lines.some((l) => l.includes("fallback off (gemini only)"))).toBe(true);
    expect(lines.some((l) => l.includes("stopping (gemini only)"))).toBe(true);
  });

  it("a gemini-only worker waits out a rest (5xx) instead of using Ollama, then goes on", async () => {
    const { engine, fake, worker, ollama, clock, lines } = setup({
      deps: { reextractOnly: true, untilIdle: true, geminiOnly: true },
      idlePolls: 99,
    });
    engine.add(TURN, "rerun-1", true);
    fake.replies = [503, 503, VALID];
    ollama.replies = [VALID];
    clock.afterSleep = () => {};
    await worker.run();
    expect(ollama.chatBodies).toHaveLength(0);
    expect(engine.completes.map((c) => [c.job_id, c.attempt, c.status])).toEqual([
      ["rerun-1", 1, "failed"],
      ["rerun-1", 2, "done"],
    ]);
    expect(worker.refused).toBeNull();
    // Nothing runs on Ollama, so the rest line says it waits for Gemini.
    const rest = lines.filter((l) => l.includes("gemini resting until"));
    expect(rest.length).toBeGreaterThan(0);
    for (const l of rest) {
      expect(l).toContain("waiting for gemini (gemini only)");
      expect(l).not.toContain("ollama");
    }
  });
});

describe("errorDetail", () => {
  const err = (message: string) => ({ code: 400, status: "INVALID_ARGUMENT", message });
  it("keeps Google's ASCII words, reason and fields", () => {
    expect(
      errorDetail(
        {
          ...err("API key not valid. Please pass a valid API key."),
          details: [{ reason: "API_KEY_INVALID" }],
        },
        "request",
        "fake-gemini-key-0000",
      ),
    ).toBe("API key not valid. Please pass a valid API key.; reason API_KEY_INVALID");
  });
  it("masks Chinese, the key, and withholds a message that quotes the request", () => {
    expect(errorDetail(err("bad value 高压锅 near secret-key-1"), "x", "secret-key-1")).toBe(
      "bad value … near [key]",
    );
    const request = "The yuesao said something like gaoyaguo, what is it?";
    expect(errorDetail(err(`Invalid: "${request}"`), request, "k")).toBe(
      "(message withheld: it quotes the request)",
    );
    expect(errorDetail(undefined, request, "k")).toBe("");
    expect(errorDetail(err("x".repeat(500)), "", "k")).toHaveLength(401);
  });
});

describe("pinyin jobs", () => {
  // Synthetic: 我得走了。 with its dictionary readings, as the engine sends them.
  const slots: PinyinJobInput["slots"] = [
    { char: "我", computed: "wǒ", readings: ["wǒ"] },
    { char: "得", computed: "dé", readings: ["dé", "děi", "de"] },
    { char: "走", computed: "zǒu", readings: ["zǒu"] },
    { char: "了", computed: "le", readings: ["le", "liǎo"] },
    { char: "。", computed: null, readings: [] },
  ];
  const input = (gemini: string[] | null): PinyinJobInput => ({
    phrase_id: "p1",
    hanzi: "我得走了。",
    context: ["我得走了，明天见。"],
    slots,
    gemini,
  });

  it("asks Gemini's reading, then the referee for the real dispute only", async () => {
    const { engine, fake, worker } = setup();
    engine.addPinyin(input(null));
    fake.replies = [
      JSON.stringify({ pinyin: ["wǒ", "děi", "zǒu", "le"] }),
      JSON.stringify({
        choices: [
          { index: 1, reading: "děi" },
          { index: 3, reading: "liǎo" },
        ],
      }),
    ];
    await worker.run();
    expect(engine.completes[0]).toMatchObject({
      status: "done",
      model: "gemini-test",
      prompt_version: "pinyin_reading.v1+pinyin_referee.v1",
      // The answer for a slot nobody asked about is left out; the engine re-checks the rest.
      result: { gemini: ["wǒ", "děi", "zǒu", "le"], referee: [{ index: 1, reading: "děi" }] },
    });
    const referee = fake.bodies[1]!.body as { contents: { parts: { text: string }[] }[] };
    const text = referee.contents[0]!.parts[0]!.text;
    expect(text).toContain("1: 得 → dé | děi | de");
    expect(text).not.toContain("3: 了");
    expect(text).toContain("我得走了，明天见。");
  });

  it("with the extraction's reading and no dispute, makes no call", async () => {
    const { engine, fake, worker } = setup();
    engine.addPinyin(input(["wǒ", "dé", "zǒu", "le"]));
    await worker.run();
    expect(fake.bodies).toHaveLength(0);
    expect(engine.completes[0]).toMatchObject({
      status: "done",
      result: { gemini: null, referee: [] },
    });
  });

  it("isn't claimed while Gemini is off", async () => {
    const { engine, worker } = setup();
    engine.addPinyin(input(null));
    // Gemini resting (after failures): extraction only, on Ollama.
    const w = worker as unknown as { geminiDownUntil: number };
    w.geminiDownUntil = Date.parse("2100-01-01T00:00:00Z");
    await worker.run();
    expect(engine.claimTypes.every((t) => !t?.includes("pinyin"))).toBe(true);
    expect(engine.jobs[0]!.status).toBe("queued");
  });
});
