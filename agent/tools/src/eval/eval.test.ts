// bamboo-eval against a fake Ollama and a fake engine. All questions and answers are synthetic.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTurnsResponse } from "@bamboo/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBlind, plainText } from "./blind";
import { insideRepo, runEval, runIdFor, type EvalDeps } from "./cli";
import { renderJudgeHtml } from "./html";
import { tokensPerSec, TutorOllama } from "./ollama";
import { loadTutorPrompt, parseTutorPrompt, REPO_ROOT } from "./prompt";
import { newAnswers, replay } from "./replay";
import { formatScores, median, score } from "./score";
import { AnswersFile, GEMINI, KeyFile, type ResultsFile } from "./types";

const SAMPLE: EvalTurnsResponse = {
  turns: [
    {
      turn_id: "turn-aaa",
      import_id: "imp-1",
      user_text: "How do I ask if the soup is ready?",
      reply_text: "汤好了吗？\nTāng hǎo le ma?\nIs the soup ready?",
    },
    {
      turn_id: "turn-bbb",
      import_id: "imp-2",
      user_text: "What does mei guanxi mean?",
      reply_text: "没关系 (méi guānxi): it doesn't matter.",
    },
    {
      turn_id: "turn-ccc",
      import_id: "imp-2",
      user_text: "How do I say put on your shoes?",
      reply_text: "穿鞋子。\nChuān xiézi.\nPut on your shoes.",
    },
  ],
  pool: { turns: 7, imports: 2 },
};

const PROMPT = { system: "You are a test tutor.", sha: "abc123abc123" };

/** A fake Ollama: models pulled/loaded, every call recorded, answers per model. */
class FakeOllama {
  pulled = ["qwen3.5:9b", "qwen3.8:27b", "qwen3.5:4b"];
  loaded: string[] = [];
  calls: { path: string; body: Record<string, unknown> | null }[] = [];
  failChat: ((model: string, q: string) => boolean) | null = null;
  failLoad: string | null = null;
  readonly fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.calls.push({ path: url.pathname, body });
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.pathname === "/api/tags") return ok({ models: this.pulled.map((name) => ({ name })) });
    if (url.pathname === "/api/ps") return ok({ models: this.loaded.map((name) => ({ name })) });
    const model = String(body?.model);
    if (url.pathname === "/api/generate") {
      if (body?.keep_alive === 0) this.loaded = this.loaded.filter((m) => m !== model);
      else {
        if (this.failLoad === model) return new Response("out of memory", { status: 500 });
        this.loaded.push(model);
      }
      return ok({ done: true });
    }
    if (url.pathname === "/api/chat") {
      const msgs = body!.messages as { role: string; content: string }[];
      const q = msgs[1]!.content;
      if (this.failChat?.(model, q)) return new Response("boom", { status: 500 });
      return ok({
        message: {
          role: "assistant",
          content: `## Answer ${model.length}\n**好的** for: ${q.length}`,
        },
        eval_count: 100,
        eval_duration: 4e9,
      });
    }
    return new Response("not found", { status: 404 });
  };
}

const answersFor = (models = ["qwen3.5:9b", "qwen3.8:27b"]) => {
  const a = newAnswers(SAMPLE, {
    run_id: "run-1",
    seed: "s",
    created_at: "2026-01-01T00:00:00.000Z",
    prompt_sha: PROMPT.sha,
    ollama_url: "http://ollama.test",
    think: false,
  });
  a.models = models;
  for (const q of a.questions)
    for (const m of models)
      q.answers[m] = {
        text: `Answer ${m.length}: 好的`,
        latency_ms: m.includes("27b") ? 30_000 : 10_000,
        eval_count: 100,
        tokens_per_sec: m.includes("27b") ? 8 : 25,
        error: null,
      };
  return a;
};

describe("prompt", () => {
  it("loads the tutor prompt from docs/PROMPTS.md (its only copy)", () => {
    const p = loadTutorPrompt();
    expect(p.system).toMatch(/Mandarin tutor/u);
    expect(p.system).not.toContain("<!--");
    expect(p.sha).toMatch(/^[0-9a-f]{12}$/u);
  });

  it("refuses a missing or empty block", () => {
    expect(() => parseTutorPrompt("# nothing here")).toThrow(/no <!-- tutor-eval-system-prompt/u);
    expect(() =>
      parseTutorPrompt(
        "<!-- tutor-eval-system-prompt:start -->\n\n<!-- tutor-eval-system-prompt:end -->",
      ),
    ).toThrow(/empty/u);
  });
});

describe("plainText", () => {
  it("strips Markdown and thinking so formatting doesn't reveal the source", () => {
    const md = [
      "<think>hmm</think>## 怎么说",
      "**汤好了吗？** is *natural*.",
      "- `汤` soup",
      "* 好 good",
      "---",
      "| hanzi | pinyin |",
      "|---|---|",
      "| 汤 | tāng |",
      "",
      "",
      "",
      "End",
    ].join("\n");
    expect(plainText(md)).toBe(
      [
        "怎么说",
        "汤好了吗？ is natural.",
        "• 汤 soup",
        "• 好 good",
        "hanzi · pinyin",
        "汤 · tāng",
        "",
        "End",
      ].join("\n"),
    );
    expect(plainText("汤好了吗？\nTāng hǎo le ma?")).toBe("汤好了吗？\nTāng hǎo le ma?");
  });
});

describe("blinding", () => {
  it("shuffles labels per question, reproducibly, with Gemini among them", () => {
    const a = answersFor();
    const { page, key } = buildBlind(a);
    expect(buildBlind(a)).toEqual({ page, key });
    expect(page.questions).toHaveLength(3);
    for (const q of key.questions) {
      expect(Object.keys(q.labels)).toEqual(["A", "B", "C"]);
      expect(
        Object.values(q.labels)
          .map((l) => l.source)
          .sort(),
      ).toEqual([GEMINI, "qwen3.8:27b", "qwen3.5:9b"].sort());
    }
    // Not the same order every time (with this seed the three questions differ).
    const orders = key.questions.map((q) =>
      Object.values(q.labels)
        .map((l) => l.source)
        .join(),
    );
    expect(new Set(orders).size).toBeGreaterThan(1);
    // The label on the page is the label in the key.
    const q1 = page.questions[0]!;
    const gem = Object.entries(key.questions[0]!.labels).find(([, v]) => v.source === GEMINI)![0];
    expect(q1.answers.find((x) => x.label === gem)!.text).toBe(SAMPLE.turns[0]!.reply_text);
  });

  it("keeps the key out of the HTML: no model names, turn ids, timings", () => {
    const a = answersFor();
    const { page } = buildBlind(a);
    const html = renderJudgeHtml(page);
    for (const leak of [
      "qwen",
      "gemini",
      "Gemini",
      "turn-aaa",
      "imp-1",
      "30000",
      "latency",
      "tokens_per_sec",
      "source",
    ])
      expect(html, leak).not.toContain(leak);
    expect(page.questions[0]!.answers.every((x) => Object.keys(x).join() === "label,text")).toBe(
      true,
    );
    expect(html).toContain("run-1");
  });

  it("escapes </script> in answers", () => {
    const a = answersFor([]);
    a.questions[0]!.gemini = "</script><script>alert(1)</script>";
    const html = renderJudgeHtml(buildBlind(a).page);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });

  it("leaves failed answers off the page and lists them in the key", () => {
    const a = answersFor();
    a.questions[1]!.answers["qwen3.8:27b"] = {
      text: null,
      latency_ms: 5,
      eval_count: null,
      tokens_per_sec: null,
      error: "HTTP 500",
    };
    const { page, key } = buildBlind(a);
    expect(page.questions[1]!.answers).toHaveLength(2);
    expect(key.questions[1]!.missing).toEqual([{ source: "qwen3.8:27b", error: "HTTP 500" }]);
  });
});

describe("score", () => {
  it("averages ratings, counts preferences and median latency per source", () => {
    const { key } = buildBlind(answersFor());
    const labelOf = (qi: number, source: string) =>
      Object.entries(key.questions[qi]!.labels).find(([, v]) => v.source === source)![0];
    const results: ResultsFile = { run_id: "run-1", questions: {} };
    key.questions.forEach((q, qi) => {
      results.questions[q.id] = {
        ratings: {
          [labelOf(qi, GEMINI)]: { accuracy: 5, naturalness: 4 },
          [labelOf(qi, "qwen3.5:9b")]: { accuracy: 3, naturalness: qi === 0 ? 2 : 3 },
          [labelOf(qi, "qwen3.8:27b")]: { accuracy: 4, naturalness: null },
        },
        preferred: qi < 2 ? labelOf(qi, GEMINI) : labelOf(qi, "qwen3.8:27b"),
      };
    });
    const rows = Object.fromEntries(score(results, key).map((r) => [r.source, r]));
    expect(rows[GEMINI]).toMatchObject({ accuracy: 5, naturalness: 4, medianLatencyMs: null });
    expect(rows[GEMINI]!.preferred).toBeCloseTo(2 / 3);
    expect(rows["qwen3.5:9b"]!.naturalness).toBeCloseTo(8 / 3);
    expect(rows["qwen3.5:9b"]).toMatchObject({
      accuracy: 3,
      preferred: 0,
      medianLatencyMs: 10_000,
    });
    expect(rows["qwen3.8:27b"]).toMatchObject({ accuracy: 4, naturalness: null, rated: 3 });
    expect(rows["qwen3.8:27b"]!.preferred).toBeCloseTo(1 / 3);
    const table = formatScores(score(results, key));
    expect(table.split("\n")[0]).toMatch(
      /^source\s+accuracy\s+natural\s+preferred\s+median latency/u,
    );
    expect(table).toMatch(/gemini\s+5\.00\s+4\.00\s+67%\s+—/u);
    expect(table).toMatch(/qwen3\.8:27b\s+4\.00\s+—\s+33%\s+30\.0 s\s+8\.0\s+3\/3\s+0/u);
  });

  it("refuses results from another run; handles no ratings", () => {
    const { key } = buildBlind(answersFor());
    expect(() => score({ run_id: "other", questions: {} }, key)).toThrow(/run other/u);
    const rows = score({ run_id: "run-1", questions: {} }, key);
    expect(rows.every((r) => r.accuracy === null && r.preferred === null)).toBe(true);
    expect(median([])).toBeNull();
    expect(median([3, 1, 2, 10])).toBe(2.5);
  });
});

describe("replay", () => {
  const log: string[] = [];
  beforeEach(() => (log.length = 0));

  it("runs models one at a time, loads then unloads each, records timings", async () => {
    const fake = new FakeOllama();
    const ollama = new TutorOllama("http://ollama.test", fake.fetch);
    let t = 0;
    const a = newAnswers(SAMPLE, answersFor([]));
    let saves = 0;
    await replay(a, ["qwen3.5:9b", "qwen3.8:27b"], {
      ollama,
      prompt: PROMPT,
      save: () => saves++,
      log: (l) => log.push(l),
      now: () => (t += 1000),
    });
    const seq = fake.calls
      .filter((c) => c.path !== "/api/tags" && c.path !== "/api/ps")
      .map((c) => `${c.path} ${c.body!.model}${c.body!.keep_alive === 0 ? " unload" : ""}`);
    expect(seq).toEqual([
      "/api/generate qwen3.5:9b",
      "/api/chat qwen3.5:9b",
      "/api/chat qwen3.5:9b",
      "/api/chat qwen3.5:9b",
      "/api/generate qwen3.5:9b unload",
      "/api/generate qwen3.8:27b",
      "/api/chat qwen3.8:27b",
      "/api/chat qwen3.8:27b",
      "/api/chat qwen3.8:27b",
      "/api/generate qwen3.8:27b unload",
    ]);
    const chat = fake.calls.find((c) => c.path === "/api/chat")!.body!;
    expect(chat).toMatchObject({ stream: false, think: false, options: { num_ctx: 8192 } });
    // The 27B loads at the host's 32k: the loading request sets the context for OpenClaw too.
    const big = fake.calls.filter(
      (c) => c.body?.model === "qwen3.8:27b" && c.body.keep_alive !== 0,
    );
    expect(big.map((c) => (c.body!.options as { num_ctx: number }).num_ctx)).toEqual([
      32768, 32768, 32768, 32768,
    ]);
    expect((chat.messages as { content: string }[])[0]!.content).toBe(PROMPT.system);
    expect(a.models).toEqual(["qwen3.5:9b", "qwen3.8:27b"]);
    expect(a.questions[0]!.answers["qwen3.5:9b"]).toMatchObject({
      latency_ms: 1000,
      eval_count: 100,
      tokens_per_sec: 25,
      error: null,
    });
    expect(a.load_ms["qwen3.5:9b"]).toBe(1000);
    expect(saves).toBe(7);
    expect(fake.loaded).toEqual([]);
    // Progress never carries question or answer text.
    expect(log.join("\n")).not.toMatch(/soup|好的|shoes/u);
  });

  it("leaves a model loaded if it was loaded before the run", async () => {
    const fake = new FakeOllama();
    fake.loaded = ["qwen3.8:27b"];
    const a = newAnswers(SAMPLE, answersFor([]));
    await replay(a, ["qwen3.8:27b"], {
      ollama: new TutorOllama("http://ollama.test", fake.fetch),
      prompt: PROMPT,
      save: () => {},
      log: (l) => log.push(l),
    });
    expect(fake.calls.some((c) => c.body?.keep_alive === 0)).toBe(false);
    expect(log.at(-1)).toMatch(/left loaded/u);
  });

  it("refuses unpulled models before loading anything", async () => {
    const fake = new FakeOllama();
    const a = newAnswers(SAMPLE, answersFor([]));
    await expect(
      replay(a, ["qwen3.5:9b", "nope:1b"], {
        ollama: new TutorOllama("http://ollama.test", fake.fetch),
        prompt: PROMPT,
        save: () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/not pulled.*nope:1b/u);
    expect(fake.calls.some((c) => c.path === "/api/generate")).toBe(false);
  });

  it("records errors, retries only failed answers on resume, survives a failed load", async () => {
    const fake = new FakeOllama();
    fake.failChat = (m, q) => m === "qwen3.5:9b" && q.includes("soup");
    fake.failLoad = "qwen3.8:27b";
    const ollama = new TutorOllama("http://ollama.test", fake.fetch);
    const deps = { ollama, prompt: PROMPT, save: () => {}, log: (l: string) => log.push(l) };
    const a = newAnswers(SAMPLE, answersFor([]));
    await replay(a, ["qwen3.5:9b", "qwen3.8:27b"], deps);
    expect(a.questions[0]!.answers["qwen3.5:9b"]!.error).toMatch(/HTTP 500 boom/u);
    expect(a.questions[1]!.answers["qwen3.5:9b"]!.error).toBeNull();
    expect(a.questions.every((q) => /load failed/u.test(q.answers["qwen3.8:27b"]!.error!))).toBe(
      true,
    );

    fake.failChat = null;
    fake.failLoad = null;
    fake.calls = [];
    await replay(a, ["qwen3.5:9b", "qwen3.8:27b"], deps);
    expect(fake.calls.filter((c) => c.path === "/api/chat")).toHaveLength(1 + 3);
    expect(a.questions.every((q) => Object.values(q.answers).every((x) => !x.error))).toBe(true);
  });

  it("computes tokens per second only from both counters", () => {
    expect(tokensPerSec(100, 4e9)).toBe(25);
    expect(tokensPerSec(null, 4e9)).toBeNull();
    expect(tokensPerSec(100, 0)).toBeNull();
  });
});

describe("bamboo-eval CLI (dry run end to end)", () => {
  let home: string;
  let fake: FakeOllama;
  const TOKEN = "synthetic-test-token";
  let engineCalls: string[];
  let deps: EvalDeps;
  const err: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bamboo-eval-"));
    fake = new FakeOllama();
    engineCalls = [];
    err.length = 0;
    const fetchAll = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === "engine.test") {
        engineCalls.push(url.pathname + url.search);
        const auth = new Headers(init?.headers).get("authorization");
        if (auth !== `Bearer ${TOKEN}`)
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        return new Response(JSON.stringify(SAMPLE), { status: 200 });
      }
      return fake.fetch(input, init);
    };
    writeFileSync(
      join(home, "agent.env"),
      `BAMBOO_API_URL=https://engine.test\nBAMBOO_AGENT_API_TOKEN=${TOKEN}\n`,
    );
    deps = {
      env: {
        HOME: home,
        BAMBOO_AGENT_ENV: join(home, "agent.env"),
        OLLAMA_URL: "http://ollama.test",
      },
      fetch: fetchAll as typeof fetch,
      log: (l) => err.push(l),
      now: () => new Date("2026-03-04T05:06:07Z"),
      prompt: () => PROMPT,
    };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("run → judge.html + key.json, serve, then score", async () => {
    const r = await runEval(["run", "--seed", "abc", "--limit", "3"], deps);
    expect(r.err).toBeUndefined();
    expect(r.code).toBe(0);
    expect(engineCalls).toEqual(["/api/agent/eval/turns?limit=3&seed=abc"]);
    const dir = join(home, "bamboo-eval", "2026-03-04T050607");
    expect(r.out).toContain(join(dir, "judge.html"));
    for (const f of ["turns.json", "answers.json", "judge.html", "key.json"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
      expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
    }
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const answers = AnswersFile.parse(JSON.parse(readFileSync(join(dir, "answers.json"), "utf8")));
    expect(answers).toMatchObject({
      run_id: "2026-03-04T050607",
      seed: "abc",
      prompt_sha: PROMPT.sha,
    });
    const html = readFileSync(join(dir, "judge.html"), "utf8");
    expect(html).not.toMatch(/qwen|gemini/iu);
    const key = KeyFile.parse(JSON.parse(readFileSync(join(dir, "key.json"), "utf8")));
    expect(key.questions).toHaveLength(3);

    // Serve: the page and results only, under the secret path.
    const s = await runEval(["serve", "--out", dir, "--port", "0"], deps);
    expect(s.code).toBe(0);
    const url = s.served!.url;
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/u);
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toBe(html);
      const origin = new URL(url).origin;
      expect((await fetch(`${origin}/`)).status).toBe(404);
      expect((await fetch(`${url}key.json`)).status).toBe(404);
      expect((await fetch(`${origin}/judge.html`)).status).toBe(404);
      const labelOf = (qi: number, source: string) =>
        Object.entries(key.questions[qi]!.labels).find(([, v]) => v.source === source)![0];
      const results: ResultsFile = {
        run_id: key.run_id,
        questions: Object.fromEntries(
          key.questions.map((q, qi) => [
            q.id,
            {
              ratings: Object.fromEntries(
                Object.entries(q.labels).map(([l, v]) => [
                  l,
                  { accuracy: v.source === GEMINI ? 5 : 3, naturalness: 4 },
                ]),
              ),
              preferred: labelOf(qi, "qwen3.8:27b"),
            },
          ]),
        ),
      };
      const bad = await fetch(`${url}results`, {
        method: "POST",
        body: JSON.stringify({ ...results, run_id: "other" }),
      });
      expect(bad.status).toBe(400);
      expect((await fetch(`${url}results`, { method: "POST", body: "{nope" })).status).toBe(400);
      const saved = await fetch(`${url}results`, { method: "POST", body: JSON.stringify(results) });
      expect(saved.status).toBe(200);
      expect(statSync(join(dir, "results.json")).mode & 0o777).toBe(0o600);
    } finally {
      await s.served!.close();
    }

    const sc = await runEval(["score", "--out", dir], deps);
    expect(sc.code).toBe(0);
    expect(sc.out).toMatch(/gemini\s+5\.00\s+4\.00\s+0%/u);
    expect(sc.out).toMatch(/qwen3\.8:27b\s+3\.00\s+4\.00\s+100%/u);

    // build rewrites the same page (labels are seeded).
    const b = await runEval(["build", "--out", dir], deps);
    expect(b.code).toBe(0);
    expect(readFileSync(join(dir, "judge.html"), "utf8")).toBe(html);
  });

  it("--fixture skips the engine; --models picks models; resumes an existing --out", async () => {
    const fixture = join(home, "fixture.json");
    writeFileSync(fixture, JSON.stringify(SAMPLE));
    const out = join(home, "runs", "x");
    const r = await runEval(
      ["run", "--fixture", fixture, "--models", "qwen3.5:4b", "--out", out, "--limit", "2"],
      deps,
    );
    expect(r.code).toBe(0);
    expect(engineCalls).toEqual([]);
    const a = AnswersFile.parse(JSON.parse(readFileSync(join(out, "answers.json"), "utf8")));
    expect(a.questions).toHaveLength(2);
    expect(a.models).toEqual(["qwen3.5:4b"]);

    fake.calls = [];
    const again = await runEval(["run", "--out", out, "--models", "qwen3.5:4b,qwen3.5:9b"], deps);
    expect(again.code).toBe(0);
    expect(err.some((l) => /resuming/u.test(l))).toBe(true);
    const chats = fake.calls.filter((c) => c.path === "/api/chat").map((c) => c.body!.model);
    expect(chats).toEqual(["qwen3.5:9b", "qwen3.5:9b"]);
  });

  it("refuses an output directory inside the checkout", async () => {
    expect(insideRepo(join(REPO_ROOT, "private", "x"))).toBe(true);
    expect(insideRepo(REPO_ROOT)).toBe(true);
    expect(insideRepo(join(REPO_ROOT, "..", "elsewhere"))).toBe(false);
    const r = await runEval(["run", "--out", join(REPO_ROOT, "out")], deps);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/inside the checkout/u);
  });

  it("reports a missing token, a 401, bad flags and usage", async () => {
    const r = await runEval(["run"], {
      ...deps,
      env: { HOME: home, BAMBOO_AGENT_ENV: join(home, "none") },
    });
    expect(r).toMatchObject({ code: 1 });
    expect(r.err).toMatch(/BAMBOO_AGENT_API_TOKEN not set/u);
    const wrong = await runEval(["run"], {
      ...deps,
      env: { ...deps.env, BAMBOO_AGENT_API_TOKEN: "wrong" },
    });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/401 unauthorized/u);
    expect((await runEval(["run", "--limit", "0"], deps)).code).toBe(2);
    expect((await runEval(["run", "--bogus"], deps)).code).toBe(2);
    expect((await runEval(["nope"], deps)).code).toBe(2);
    expect((await runEval(["score"], deps)).code).toBe(2);
    expect((await runEval([], deps)).out).toMatch(/usage: bamboo-eval/u);
    expect(runIdFor(new Date("2026-11-06T09:56:04.123Z"))).toBe("2026-11-06T095604");
  });
});
