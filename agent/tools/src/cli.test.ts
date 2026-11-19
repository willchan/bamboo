import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTHING_NEW, PUBLIC_LINK_NOTE, turnKey, type Notification } from "@bamboo/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { Api } from "./api";
import { COMMANDS, FAILURE_REPLIES, NO_REPLY, repliesText, run, USAGE, type Deps } from "./cli";
import { FakeEngine } from "./fake-engine.test-util";
import type { Discord } from "./discord";
import { chunkBodies, uploadConversation, type Conversation } from "./importer";
import { PdfError } from "./pdf";
import { ShareParseError } from "./share";

const CHANNEL = "111111111111111111";
const GUILD = "222222222222222222";

const conv = (n: number, title = "Synthetic Chat"): Conversation => ({
  title,
  turns: Array.from({ length: n }, (_, i) => ({
    user_text: `How do I say thing number ${i}?`,
    reply_text: `第${i}个：你可以说"东西${i}"。`,
  })),
});

let engine: FakeEngine;
let home: string;
let share: Conversation;
let pdf: Conversation | Error;
/** The fake Discord: each post's forum, the lookups made and the replies posted. */
let parents: Record<string, string | null>;
let lookups: string[];
let posted: { channel: string; message: string; text: string }[];
let discordDown: boolean;

const fakeDiscord = (): Discord => ({
  async parentOf(id) {
    lookups.push(id);
    if (discordDown) throw new Error("openclaw message channel failed (1)");
    return parents[id] ?? null;
  },
  async reply(channel, message, text) {
    if (discordDown) throw new Error("openclaw message send failed (1)");
    posted.push({ channel, message, text });
  },
});

function deps(extraEnv: Record<string, string> = {}): Deps {
  return {
    env: {
      HOME: home,
      BAMBOO_API_URL: "https://bamboo.test/",
      BAMBOO_AGENT_API_TOKEN: engine.token,
      ...extraEnv,
    },
    readShare: async () => share,
    readPdf: async () => {
      if (pdf instanceof Error) throw pdf;
      return pdf;
    },
    readText: (file) => (file === "empty.txt" ? "  \n" : "阿姨，您是说要加水吗？"),
    fetch: engine.fetch as typeof fetch,
    retryDelayMs: 0,
    discord: fakeDiscord(),
  };
}

beforeEach(() => {
  engine = new FakeEngine();
  home = mkdtempSync(join(tmpdir(), "bamboo-tools-"));
  mkdirSync(join(home, ".config", "bamboo"), { recursive: true });
  writeFileSync(
    join(home, ".config", "bamboo", "bamboo.config.json"),
    JSON.stringify({ discord: { guild_id: GUILD, channel_id: CHANNEL } }),
  );
  share = conv(4);
  pdf = conv(4);
  parents = {};
  lookups = [];
  posted = [];
  discordDown = false;
});

const importArgs = (src: string[], message = "900") => [
  "import",
  ...src,
  "--channel-id",
  CHANNEL,
  "--message-id",
  message,
];

describe("bamboo-tools import", () => {
  it("uploads a link's turns and prints the acknowledgement", async () => {
    const r = await run(importArgs(["--url", "https://share.gemini.google/x"]), deps());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      import_id: "imp1",
      turns_total: 4,
      turns_new: 4,
      conversation_title: "Synthetic Chat",
      reply: "📥 Got it: *Synthetic Chat*, 4 questions, 4 new. I'll reply when they're processed.",
    });
    const post = engine.calls.find((c) => c.path === "/api/imports")!;
    expect(post.headers.get("idempotency-key")).toBe("discord:900");
    expect(post.body).toMatchObject({
      kind: "link",
      origin: "discord",
      source_ref: "https://share.gemini.google/x",
      discord_channel_id: CHANNEL,
      discord_message_id: "900",
      turns_total: 4,
      more: false,
    });
  });

  it("a re-share uploads only the new turns; an old link is 'Nothing new' with the link line", async () => {
    await run(importArgs(["--url", "https://share.gemini.google/a"], "1"), deps());
    share = conv(6); // re-shared after two more questions: a new link with the whole conversation
    const second = await run(importArgs(["--url", "https://share.gemini.google/b"], "2"), deps());
    expect(JSON.parse(second.out)).toMatchObject({ turns_total: 6, turns_new: 2 });
    const body = engine.calls.filter((c) => c.path === "/api/imports").at(-1)!.body as {
      turns: { position: number }[];
    };
    expect(body.turns.map((t) => t.position)).toEqual([4, 5]);

    const again = await run(importArgs(["--url", "https://share.gemini.google/b"], "3"), deps());
    const out = JSON.parse(again.out) as { turns_new: number; reply: string };
    expect(out.turns_new).toBe(0);
    expect(out.reply).toBe(`${NOTHING_NEW}\n${PUBLIC_LINK_NOTE}`);
    // the import is still recorded (the engine marks it notified at once)
    expect(engine.imports).toHaveLength(3);
  });

  it("a PDF of a conversation already imported by link is nothing new (keys agree)", async () => {
    await run(importArgs(["--url", "https://share.gemini.google/a"], "1"), deps());
    const r = await run(importArgs(["--file", "/tmp/chat.pdf"], "2"), deps());
    expect(JSON.parse(r.out)).toMatchObject({ turns_new: 0, reply: NOTHING_NEW });
    const post = engine.calls.filter((c) => c.path === "/api/imports").at(-1)!;
    expect(post.body).toMatchObject({ kind: "pdf", source_ref: "chat.pdf", turns: [] });
  });

  it("keys an image-only prompt from a link or a PDF on its reply", async () => {
    share = {
      title: "T",
      turns: [
        { user_text: "", reply_text: "这是酱油。" },
        { user_text: "", reply_text: "这是醋。" },
      ],
    };
    const r = await run(importArgs(["--url", "https://share.gemini.google/a"], "1"), deps());
    expect(JSON.parse(r.out)).toMatchObject({ turns_new: 2 });
    const known = engine.calls.find((c) => c.path === "/api/imports/known")!.body as {
      turn_keys: string[];
    };
    expect(known.turn_keys).toEqual(share.turns.map((t) => turnKey(t, "link")));
    pdf = { title: "T", turns: [{ user_text: "", reply_text: "这是糖。" }, ...share.turns] };
    const p = await run(importArgs(["--file", "/tmp/chat.pdf"], "2"), deps());
    expect(JSON.parse(p.out)).toMatchObject({ turns_total: 3, turns_new: 1 });
  });

  it("imports pasted text as one turn with no title", async () => {
    const r = await run(importArgs(["--text-file", "paste.txt"]), deps());
    expect(JSON.parse(r.out)).toMatchObject({
      turns_total: 1,
      turns_new: 1,
      conversation_title: null,
      reply: "📥 Got it: 1 question, 1 new. I'll reply when they're processed.",
    });
    const empty = await run(importArgs(["--text-file", "empty.txt"], "2"), deps());
    expect(empty.code).toBe(1);
    expect(JSON.parse(empty.out)).toMatchObject({ error: "empty", reply: FAILURE_REPLIES.empty });
  });

  it("asks for the PDF when the link can't be read, and for the link when PDFs can't be", async () => {
    const d = deps();
    d.readShare = async () => {
      throw new ShareParseError("batchexecute HTTP 500");
    };
    const r = await run(importArgs(["--url", "https://share.gemini.google/x"]), d);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      error: "share_parse_failed",
      reply: "⚠️ Couldn't read that link. Send the PDF instead.",
    });
    pdf = new PdfError(
      "pdftotext_missing",
      "pdftotext not found: install poppler: brew install poppler",
    );
    const p = await run(importArgs(["--file", "/tmp/a.pdf"]), deps());
    expect(JSON.parse(p.out)).toMatchObject({ error: "pdftotext_missing" });
    expect(p.err).toContain("install poppler: brew install poppler");
    expect(engine.calls).toHaveLength(0);
  });

  it("refuses another channel, and says so when the token isn't set up", async () => {
    const r = await run(
      ["import", "--url", "https://share.gemini.google/x", "--channel-id", "5"],
      deps(),
    );
    expect(JSON.parse(r.out)).toMatchObject({ error: "wrong_channel" });
    const n = await run(
      importArgs(["--url", "https://share.gemini.google/x"]),
      deps({ BAMBOO_AGENT_API_TOKEN: "" }),
    );
    expect(JSON.parse(n.out)).toMatchObject({ error: "not_configured" });
    expect(n.err).toContain("BAMBOO_AGENT_API_TOKEN");
    expect(engine.calls).toHaveLength(0);
  });

  it("reads the token and URL from ~/.config/bamboo/agent.env", async () => {
    writeFileSync(
      join(home, ".config", "bamboo", "agent.env"),
      `# comment\nBAMBOO_API_URL=https://bamboo.test\nBAMBOO_AGENT_API_TOKEN="${engine.token}"\n`,
    );
    const d = deps();
    d.env = { HOME: home };
    const r = await run(importArgs(["--url", "https://share.gemini.google/x"]), d);
    expect(r.code).toBe(0);
  });

  // Bug: OpenClaw passes its own env (PandaBase's AGENT_API_TOKEN) to every tool, and the process
  // env won over agent.env, so bamboo-tools sent PandaBase's token to Bamboo's engine (401).
  it("uses Bamboo's own token even when the gateway env has another app's AGENT_API_TOKEN", async () => {
    writeFileSync(
      join(home, ".config", "bamboo", "agent.env"),
      `BAMBOO_API_URL=https://bamboo.test\nBAMBOO_AGENT_API_TOKEN=${engine.token}\n`,
    );
    const d = deps();
    d.env = { HOME: home, AGENT_API_TOKEN: "pandabase-token" };
    const r = await run(importArgs(["--url", "https://share.gemini.google/x"]), d);
    expect(r.code, r.out).toBe(0);
  });

  it("retries a 409 conflict and a 5xx, and reports other API errors", async () => {
    engine.failNext = { status: 409, error: "conflict", count: 1 };
    const ok = await run(importArgs(["--url", "https://share.gemini.google/x"]), deps());
    expect(ok.code).toBe(0);
    engine.failNext = { status: 503, error: "not_configured", count: 5 };
    const bad = await run(importArgs(["--url", "https://share.gemini.google/x"], "2"), deps());
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({ error: "api", reply: FAILURE_REPLIES.api });
    engine.failNext = { status: 404, error: "not_found", count: 1 };
    const nf = await run(importArgs(["--url", "https://share.gemini.google/x"], "3"), deps());
    expect(nf.err).toContain("404 not_found");
  });

  it("rejects bad usage", async () => {
    expect((await run(["import", "--url", "a", "--file", "b"], deps())).code).toBe(2);
    expect((await run(["import", "--nope", "x"], deps())).code).toBe(2);
    expect((await run(["frobnicate"], deps())).code).toBe(2);
    expect(await run([], deps())).toEqual({ code: 0, out: USAGE });
  });
});

// H5: text in #bamboo is a pasted answer or a tutor question (synthetic text only).
const PASTED = [
  "**Here are a few ways to say it:**",
  "1. 宝宝要睡觉了。 (Bǎobao yào shuìjiào le.) The baby is going to sleep.",
  "2. 我们去洗澡吧。 (Wǒmen qù xǐzǎo ba.) Let's go take a bath.",
  "3. 慢慢吃，不着急。 (Mànmàn chī, bù zháojí.) Eat slowly, no rush.",
  "**Tip:** 了 marks a change of state here; 吧 at the end softens a suggestion, which is very",
  "common when talking to toddlers, and 慢慢 doubles for a gentle, unhurried feel.",
].join("\n");
const files: Record<string, string> = {
  "paste.txt": PASTED,
  "q.txt": "How do I tell the yuesao the baby is gassy?",
  "askq.txt": `ask: ${PASTED}`,
  "a.txt": "你可以说：阿姨，宝宝好像胀气了。\n胀气 (zhàng qì): bloated.",
  "blank.txt": "   ",
};
const textDeps = (extra: Record<string, string> = {}): Deps => ({
  ...deps(extra),
  readText: (f) => files[f] ?? "",
});

describe("#bamboo is a forum (§10 #96)", () => {
  const POST = "333333333333333333";
  const inPost = (message: string) => [
    "import",
    "--url",
    "https://share.gemini.google/x",
    "--channel-id",
    POST,
    "--message-id",
    message,
  ];

  it("takes a message in one of the forum's posts, and remembers the post", async () => {
    parents[POST] = CHANNEL;
    const r = await run(inPost("1"), deps());
    expect(r.code).toBe(0);
    expect(engine.calls.find((c) => c.path === "/api/imports")!.body).toMatchObject({
      discord_channel_id: POST,
    });
    expect(lookups).toEqual([POST]);
    await run(inPost("2"), deps());
    expect(lookups).toEqual([POST]);
  });

  it("refuses a post of another forum, and says so when Discord can't be asked", async () => {
    parents[POST] = "444444444444444444";
    expect(JSON.parse((await run(inPost("1"), deps())).out)).toMatchObject({
      error: "wrong_channel",
    });
    discordDown = true;
    const r = await run(inPost("2"), deps());
    expect(JSON.parse(r.out)).toMatchObject({
      error: "channel_check_failed",
      reply: FAILURE_REPLIES.channel_check_failed,
    });
  });

  it("needs no lookup for the forum itself", async () => {
    await run(importArgs(["--url", "https://share.gemini.google/x"]), deps());
    expect(lookups).toEqual([]);
  });
});

describe("bamboo-tools ask", () => {
  const ask = (file: string, message = "901") => [
    "ask",
    "--text-file",
    file,
    "--channel-id",
    CHANNEL,
    "--message-id",
    message,
  ];

  it("imports a pasted answer as text and posts the acknowledgement", async () => {
    const r = await run(ask("paste.txt"), textDeps());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      route: "paste",
      turns_new: 1,
      reply: "📥 Got it: 1 question, 1 new. I'll reply when they're processed.",
    });
    expect(engine.imports[0]).toMatchObject({ kind: "text", idem: "discord:901" });
  });

  it("sends nothing for a question: the agent answers it first", async () => {
    for (const f of ["q.txt", "askq.txt"]) {
      const r = await run(ask(f), textDeps());
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ route: "question" });
    }
    expect(engine.calls).toEqual([]);
  });

  it("refuses another channel and empty text", async () => {
    const other = await run(
      ["ask", "--text-file", "q.txt", "--channel-id", "999", "--message-id", "1"],
      textDeps(),
    );
    expect(JSON.parse(other.out)).toMatchObject({ error: "wrong_channel" });
    const empty = await run(ask("blank.txt"), textDeps());
    expect(empty.code).toBe(1);
    expect(JSON.parse(empty.out)).toMatchObject({ error: "empty" });
    expect(engine.calls).toEqual([]);
  });
});

describe("bamboo-tools turn", () => {
  const turn = (q = "q.txt", message = "902") => [
    "turn",
    "--question-file",
    q,
    "--answer-file",
    "a.txt",
    "--channel-id",
    CHANNEL,
    "--message-id",
    message,
  ];

  it("saves the question and answer as one tutor turn, idempotent on the message id", async () => {
    const r = await run(turn(), textDeps());
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ import_id: "imp1", turn_new: true });
    const post = engine.calls.find((c) => c.path === "/api/turns")!;
    expect(post.body).toEqual({
      user_text: files["q.txt"],
      reply_text: files["a.txt"],
      discord_channel_id: CHANNEL,
      discord_message_id: "902",
      prompt_version: "tutor.v1",
    });
    const again = await run(turn(), textDeps());
    expect(JSON.parse(again.out)).toEqual({ import_id: "imp1", turn_new: false });
    expect(engine.imports).toHaveLength(1);
  });

  it("drops an ask: marker from the question", async () => {
    await run(turn("askq.txt"), textDeps());
    const post = engine.calls.find((c) => c.path === "/api/turns")!;
    expect((post.body as { user_text: string }).user_text).toBe(PASTED);
  });

  it("needs the message id, and reports a failed save with its own line", async () => {
    const noId = await run(turn().slice(0, -2), textDeps());
    expect(noId.code).toBe(2);
    engine.failNext = { status: 500, error: "internal", count: 10 };
    const r = await run(turn(), textDeps());
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      error: "not_saved",
      reply: FAILURE_REPLIES.not_saved,
    });
    expect(r.out).not.toContain("胀气"); // no turn text in the output or the diagnostic
    expect(r.err).not.toContain("胀气");
  });

  it("requires the agent token", async () => {
    const r = await run(turn(), textDeps({ BAMBOO_AGENT_API_TOKEN: "wrong" }));
    expect(JSON.parse(r.out)).toMatchObject({ error: "not_saved" });
    expect(r.err).toMatch(/401/u);
  });
});

describe("upload chunking and known", () => {
  const api = () =>
    new Api({
      baseUrl: "https://bamboo.test",
      token: engine.token,
      fetch: engine.fetch as typeof fetch,
      retryDelayMs: 0,
    });
  const meta = { kind: "link" as const, sourceRef: "s", channelId: CHANNEL, messageId: "77" };

  it("asks `known` in batches and uploads in chunks under the byte limit", async () => {
    const big = conv(40);
    // pretend half are known already
    for (const t of big.turns.slice(0, 20)) engine.keys.add(turnKey(t, "link"));
    engine.maxBodyBytes = 1_000;
    const out = await uploadConversation(api(), big, meta, {
      maxKnownKeys: 7,
      maxBodyBytes: 1_000,
    });
    expect(out).toMatchObject({ turns_total: 40, turns_new: 20 });
    const known = engine.calls.filter((c) => c.path === "/api/imports/known");
    expect(known.map((c) => (c.body as { turn_keys: string[] }).turn_keys.length)).toEqual([
      7, 7, 7, 7, 7, 5,
    ]);
    const posts = engine.calls.filter((c) => c.path === "/api/imports");
    expect(posts.length).toBeGreaterThan(2);
    posts.forEach((p, i) => {
      const b = p.body as { more: boolean; import_id?: string };
      expect(b.more).toBe(i < posts.length - 1);
      expect(b.import_id).toBe(i === 0 ? undefined : "imp1");
      expect(p.headers.get("idempotency-key")).toBe("discord:77");
      expect(Buffer.byteLength(JSON.stringify(p.body))).toBeLessThanOrEqual(1_000);
    });
  });

  it("a retried import (same message) returns the same import and its running total", async () => {
    const c = conv(3);
    const first = await uploadConversation(api(), c, meta);
    const retry = await uploadConversation(api(), c, meta);
    expect(retry).toEqual(first);
    expect(engine.imports).toHaveLength(1);
  });

  it("deduplicates repeated prompts before asking", async () => {
    const c = conv(2);
    c.turns.push({ ...c.turns[0]! });
    const out = await uploadConversation(api(), c, meta);
    expect(out).toMatchObject({ turns_total: 3, turns_new: 2 });
  });

  it("refuses a single turn over the limit", () => {
    const base = { kind: "link" as const, origin: "discord" as const, turns_total: 1 };
    expect(() =>
      chunkBodies(base, [{ user_text: "x", reply_text: "长".repeat(1000), position: 0 }], 500),
    ).toThrow(/upload limit/u);
    expect(chunkBodies(base, [], 500)).toEqual([{ ...base, turns: [], more: false }]);
  });
});

describe("bamboo-tools replies", () => {
  const note = (id: string, msg: string, summary: string): Notification => ({
    import_id: id,
    kind: "link",
    discord_channel_id: CHANNEL,
    discord_message_id: msg,
    summary,
  });

  it("prints NO_REPLY when idle", async () => {
    expect(await run(["replies"], deps())).toEqual({ code: 0, out: NO_REPLY });
  });

  it("replies inside each import's post and marks the imports notified", async () => {
    engine.notifications = [
      note("i1", "900", "✅ 2 new questions → 3 phrases queued."),
      { ...note("i2", "901", "✅ 1 new question → 1 phrase queued."), discord_channel_id: "55" },
    ];
    const r = await run(["replies"], deps());
    expect(r).toEqual({ code: 0, out: NO_REPLY });
    expect(posted).toEqual([
      { channel: CHANNEL, message: "900", text: "✅ 2 new questions → 3 phrases queued." },
      { channel: "55", message: "901", text: "✅ 1 new question → 1 phrase queued." },
    ]);
    expect(engine.notified).toEqual(["i1", "i2"]);
    expect(await run(["replies"], deps())).toEqual({ code: 0, out: NO_REPLY });
  });

  it("prints what has no post to reply in (announced as a new post)", async () => {
    engine.notifications = [{ ...note("i1", "900", "A"), discord_channel_id: null }];
    expect(await run(["replies"], deps())).toEqual({ code: 0, out: "A" });
    expect(posted).toEqual([]);
    expect(engine.notified).toEqual(["i1"]);
  });

  it("links each message it prints", () => {
    const text = repliesText([note("a", "1", "A"), note("b", "2", "B")], GUILD);
    expect(text).toBe(
      `A\n↪ https://discord.com/channels/${GUILD}/${CHANNEL}/1\n\nB\n↪ https://discord.com/channels/${GUILD}/${CHANNEL}/2`,
    );
    expect(repliesText([note("a", "1", "A"), note("b", "2", "B")], null)).toBe("A\n\nB");
  });

  it("reports a failed post once, and the import stays notified", async () => {
    engine.notifications = [note("i1", "900", "A")];
    discordDown = true;
    const r = await run(["replies"], deps());
    expect(r.code).toBe(1);
    expect(r.out).toContain("couldn't post 1 of 1 replies");
    expect(engine.notified).toEqual(["i1"]);
  });

  it("fails clearly without a token", async () => {
    const r = await run(["replies"], deps({ BAMBOO_AGENT_API_TOKEN: "" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("BAMBOO_AGENT_API_TOKEN");
    expect(r.err).toBeUndefined();
  });
});

describe("bamboo-tools nudge", () => {
  it("prints the reminder, or NO_REPLY", async () => {
    expect((await run(["nudge"], deps())).out).toBe(NO_REPLY);
    engine.nudgeText = "🎋 A round is waiting (10 cards).";
    expect((await run(["nudge"], deps())).out).toBe("🎋 A round is waiting (10 cards).");
  });

  it("reports a 404 as an error now that the route exists", async () => {
    engine.nudgeStatus = 404;
    const r = await run(["nudge"], deps());
    expect(r.code).toBe(1);
    expect(r.out).toContain("404");
    expect(r.err).toBeUndefined();
  });
});

// Regression: one network blip posted "bamboo-tools replies: GET …: fetch failed" to #bamboo
// (OpenClaw announces stderr when stdout is empty). Transient errors must post nothing.
describe("automations stay quiet on a transient error", () => {
  for (const cmd of ["replies", "nudge"]) {
    it(`${cmd}: fetch failed → NO_REPLY, exit 0, nothing on stderr`, async () => {
      const d = deps();
      d.fetch = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      expect(await run([cmd], d)).toEqual({ code: 0, out: NO_REPLY });
    });
  }
});

// A 401 names where the token came from (file and key, or env var), never the token itself.
describe("401: where the token came from", () => {
  const WRONG = "wrong-token-value-9f8e7d";
  const envFile = () => join(home, ".config", "bamboo", "agent.env");

  for (const argv of [
    ["nudge"],
    ["replies"],
    [
      "import",
      "--url",
      "https://share.gemini.google/x",
      "--channel-id",
      CHANNEL,
      "--message-id",
      "1",
    ],
  ]) {
    it(`${argv[0]}: names agent.env and the key`, async () => {
      writeFileSync(
        envFile(),
        `BAMBOO_API_URL=https://bamboo.test\nBAMBOO_AGENT_API_TOKEN=${WRONG}\n`,
      );
      const d = deps();
      d.env = { HOME: home };
      const r = await run(argv, d);
      expect(r.code).toBe(1);
      const all = `${r.out}\n${r.err ?? ""}`;
      // import: on stderr (the skill posts `reply`); automations: on stdout (OpenClaw posts it).
      expect(all).toContain("401");
      expect(all).toContain(`BAMBOO_AGENT_API_TOKEN in ${envFile()}`);
      expect(all).not.toContain(WRONG);
    });

    it(`${argv[0]}: names the environment variable`, async () => {
      const r = await run(argv, deps({ BAMBOO_AGENT_API_TOKEN: WRONG }));
      expect(r.code).toBe(1);
      const all = `${r.out}\n${r.err ?? ""}`;
      expect(all).toContain("environment variable BAMBOO_AGENT_API_TOKEN");
      expect(all).not.toContain(WRONG);
    });
  }

  it("never names the source for other errors", async () => {
    engine.nudgeStatus = 403;
    const r = await run(["nudge"], deps());
    expect(r.out).toContain("403");
    expect(r.out).not.toContain("token from");
  });
});

describe("bamboo-tools segment", () => {
  it("prints the title, count and first/last prompts, with no API calls", async () => {
    share = conv(12);
    share.turns[11]!.user_text = "";
    const r = await run(["segment", "--url", "https://share.gemini.google/x"], deps());
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[1]).toBe("title:   Synthetic Chat");
    expect(lines[2]).toBe("turns:   12 (1 with no prompt text)");
    expect(lines).toContain("first 5 prompts:");
    expect(lines).toContain("last 5 prompts:");
    expect(lines.at(-1)).toBe("  12. (no prompt text: image-only)");
    expect(engine.calls).toHaveLength(0);
  });

  it("short conversations list each prompt once; failures go to stderr", async () => {
    pdf = conv(3);
    const r = await run(["segment", "--file", "/tmp/a.pdf"], deps());
    expect(r.out).toContain("source:  pdf");
    expect(r.out).not.toContain("last");
    pdf = new PdfError(
      "pdftotext_missing",
      "pdftotext not found: install poppler: brew install poppler",
    );
    const bad = await run(["segment", "--file", "/tmp/a.pdf"], deps());
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("install poppler: brew install poppler");
    expect((await run(["segment", "--text-file", "x"], deps())).code).toBe(2);
  });

  it("lists every command the skill may use", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([
      "ask",
      "import",
      "nudge",
      "replies",
      "segment",
      "turn",
    ]);
  });
});
