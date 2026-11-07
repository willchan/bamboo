import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTHING_NEW, PUBLIC_LINK_NOTE, turnKey, type Notification } from "@bamboo/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { Api } from "./api";
import { COMMANDS, FAILURE_REPLIES, NO_REPLY, repliesText, run, USAGE, type Deps } from "./cli";
import { FakeEngine } from "./fake-engine.test-util";
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

  it("replies to the message and marks the import notified", async () => {
    engine.notifications = [note("i1", "900", "✅ 2 new questions → 3 phrases queued.")];
    const r = await run(["replies"], deps());
    expect(r.out).toBe("[[reply_to:900]] ✅ 2 new questions → 3 phrases queued.");
    expect(engine.notified).toEqual(["i1"]);
    expect(await run(["replies"], deps())).toEqual({ code: 0, out: NO_REPLY });
  });

  it("links each message when several finished at once", () => {
    const text = repliesText([note("a", "1", "A"), note("b", "2", "B")], GUILD);
    expect(text).toBe(
      `A\n↪ https://discord.com/channels/${GUILD}/${CHANNEL}/1\n\nB\n↪ https://discord.com/channels/${GUILD}/${CHANNEL}/2`,
    );
    expect(repliesText([note("a", "1", "A"), note("b", "2", "B")], null)).toBe("A\n\nB");
  });

  it("fails clearly without a token", async () => {
    const r = await run(["replies"], deps({ BAMBOO_AGENT_API_TOKEN: "" }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("BAMBOO_AGENT_API_TOKEN");
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
    expect(r.out).toBe("");
    expect(r.err).toContain("404");
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
      expect(r.err).toContain("401");
      expect(r.err).toContain(`BAMBOO_AGENT_API_TOKEN in ${envFile()}`);
      expect(all).not.toContain(WRONG);
    });

    it(`${argv[0]}: names the environment variable`, async () => {
      const r = await run(argv, deps({ BAMBOO_AGENT_API_TOKEN: WRONG }));
      expect(r.code).toBe(1);
      const all = `${r.out}\n${r.err ?? ""}`;
      expect(r.err).toContain("environment variable BAMBOO_AGENT_API_TOKEN");
      expect(all).not.toContain(WRONG);
    });
  }

  it("never names the source for other errors", async () => {
    engine.nudgeStatus = 500;
    const r = await run(["nudge"], deps());
    expect(r.err).not.toContain("token from");
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
    expect(Object.keys(COMMANDS).sort()).toEqual(["import", "nudge", "replies", "segment"]);
  });
});
