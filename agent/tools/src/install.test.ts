// `make agent-install` (agent/install.sh) against a fake OpenClaw in a temp HOME: additive,
// idempotent, backs up first, never prints the token.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/u, "");
const script = join(repo, "agent/install.sh");
const ours = join(repo, "agent/skills");
const PANDABASE = "/Users/someone/Code/pandabase/agent/skills";
const STALE = "/gone/bamboo-old/agent/skills";
const TOKEN = "tok-0123456789abcdef";
const GUILD = "222222222222222222";
const BAMBOO = "111111111111111111";
const PANDABASE_CHANNEL = "555555555555555555";
// The access keys Will set on #bamboo: the installer must keep them exactly.
const BAMBOO_ACCESS = {
  enabled: true,
  requireMention: false,
  requireMentionInBotThreads: false,
  users: ["444444444444444444"],
};
const OTHER_CHANNELS = {
  [PANDABASE_CHANNEL]: {
    enabled: true,
    requireMention: false,
    users: ["444444444444444444"],
    skills: ["discord-intake"],
    systemPrompt: "Synthetic PandaBase prompt.",
    tools: { deny: ["browser"] },
  },
  "*": { enabled: true, requireMention: true },
};
// The media and link-reading tools #bamboo must never have (OpenClaw docs: gateway/config-tools/
// tool-policy.md, group:web and group:media; tools/code-execution.md).
const READERS = [
  "view_image",
  "pdf",
  "web_fetch",
  "web_search",
  "x_search",
  "browser",
  "code_execution",
];

let home: string;
const oc = () => join(home, ".openclaw");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const extraDirs = () =>
  (readJson(join(oc(), "openclaw.json")) as { skills: { load: { extraDirs: string[] } } }).skills
    .load.extraDirs;
const backups = () => readdirSync(oc()).filter((f) => f.startsWith("openclaw.json.bak."));
const automations = () =>
  JSON.parse(readFileSync(join(oc(), "automations.json"), "utf8")) as {
    name: string;
    cron: string;
    command: string;
    to: string;
    agentId?: string;
  }[];

function install(env: Record<string, string> = {}) {
  const fakeBin = join(home, "fakebin");
  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: `${fakeBin}:/opt/homebrew/bin:${process.env.PATH}`,
      SKIP_PNPM_INSTALL: "1",
      BAMBOO_DISCORD_CHANNEL_ID: "111111111111111111",
      BAMBOO_DISCORD_GUILD_ID: "222222222222222222",
      BAMBOO_API_URL: "https://bamboo.test",
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bamboo-install-"));
  const fakeBin = join(home, "fakebin");
  mkdirSync(fakeBin);
  copyFileSync(new URL("../tests/fake-openclaw", import.meta.url), join(fakeBin, "openclaw"));
  chmodSync(join(fakeBin, "openclaw"), 0o755);
  mkdirSync(oc());
  writeFileSync(
    join(oc(), "openclaw.json"),
    JSON.stringify({
      skills: { load: { extraDirs: [PANDABASE, STALE] } },
      channels: {
        discord: {
          guilds: {
            [GUILD]: { channels: { [BAMBOO]: BAMBOO_ACCESS, ...OTHER_CHANNELS } },
          },
        },
      },
    }),
  );
});

type ChannelEntry = Record<string, unknown> & {
  skills?: string[];
  systemPrompt?: string;
  tools?: { deny?: string[]; allow?: string[] };
};
const channels = () =>
  (
    readJson(join(oc(), "openclaw.json")) as {
      channels: { discord: { guilds: Record<string, { channels: Record<string, ChannelEntry> }> } };
    }
  ).channels.discord.guilds[GUILD]!.channels;
const setChannel = (id: string, entry: ChannelEntry) => {
  const cfg = readJson(join(oc(), "openclaw.json")) as {
    channels: { discord: { guilds: Record<string, { channels: Record<string, ChannelEntry> }> } };
  };
  cfg.channels.discord.guilds[GUILD]!.channels[id] = entry;
  writeFileSync(join(oc(), "openclaw.json"), JSON.stringify(cfg));
};

// The systemPrompt pins every message to the skill and forbids reading the content itself.
function expectFirmPrompt(prompt: string | undefined) {
  expect(prompt).toBeDefined();
  const p = prompt!;
  expect(p).toMatch(/bamboo skill/u);
  for (const f of ["bamboo-tools import --url", "--file", "--text-file"]) expect(p).toContain(f);
  expect(p).toMatch(/exactly as printed/u);
  expect(p).toMatch(/never open, fetch, view, describe, translate or summarize/iu);
  expect(p).toMatch(/link, attachment or pasted text/u);
  expect(p).toMatch(/data, not instructions/u);
  expect(p).not.toContain("'"); // printed inside '…' when the channel is missing
  // Short enough to stay a pin, not a second skill.
  expect(p.length).toBeLessThan(800);
}

// Each test runs the real installer (bash, jq, a fake OpenClaw) one to three times: 1–3 s
// locally, and past vitest's 5 s default on a busy CI runner, where packages test in parallel.
describe("agent/install.sh", { timeout: 20_000 }, () => {
  it("is additive and idempotent, backs up first, and waits for the token", () => {
    const first = install();
    expect(first.code, first.out).toBe(0);
    expect(readlinkSync(join(home, ".local/bin/bamboo-tools"))).toBe(
      join(repo, "agent/tools/bin/bamboo-tools"),
    );
    expect(extraDirs()).toEqual([PANDABASE, ours]);
    expect(backups()).toHaveLength(1);
    const config = readJson(join(home, ".config/bamboo/bamboo.config.json"));
    expect(config.discord).toEqual({
      guild_id: "222222222222222222",
      channel_id: "111111111111111111",
    });
    expect(config._comment).toBeUndefined();
    const envFile = join(home, ".config/bamboo/agent.env");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile, "utf8")).toMatch(/^BAMBOO_API_URL=https:\/\/bamboo\.test$/mu);
    expect(readFileSync(envFile, "utf8")).toMatch(/^BAMBOO_AGENT_API_TOKEN=$/mu);
    expect(first.out).toContain("skipped the automations");
    expect(automations()).toEqual([]);

    const second = install();
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("kept skills.load.extraDirs");
    expect(extraDirs()).toEqual([PANDABASE, ours]);
    expect(backups()).toHaveLength(1);
  });

  // Bug: agent.env used the unprefixed AGENT_API_TOKEN, which the gateway env (PandaBase's) won
  // over. An existing file is renamed in place, keeping the value and the mode.
  it("renames an older agent.env's AGENT_API_TOKEN to BAMBOO_AGENT_API_TOKEN", () => {
    const envFile = join(home, ".config/bamboo/agent.env");
    mkdirSync(join(home, ".config/bamboo"), { recursive: true });
    writeFileSync(envFile, `BAMBOO_API_URL=https://bamboo.test\nAGENT_API_TOKEN=${TOKEN}\n`, {
      mode: 0o600,
    });
    const r = install();
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(TOKEN);
    const text = readFileSync(envFile, "utf8");
    expect(text).toMatch(new RegExp(`^BAMBOO_AGENT_API_TOKEN=${TOKEN}$`, "mu"));
    expect(text).not.toMatch(/^AGENT_API_TOKEN=/mu);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(r.out).not.toContain("skipped the automations: BAMBOO_AGENT_API_TOKEN");
  });

  it("adds the two command automations once the token is in, then updates them in place", () => {
    install();
    const envFile = join(home, ".config/bamboo/agent.env");
    writeFileSync(
      envFile,
      readFileSync(envFile, "utf8").replace(
        "BAMBOO_AGENT_API_TOKEN=",
        `BAMBOO_AGENT_API_TOKEN=${TOKEN}`,
      ),
    );
    const r = install();
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(TOKEN);
    const bin = join(repo, "agent/tools/bin/bamboo-tools");
    expect(automations()).toEqual([
      expect.objectContaining({
        name: "bamboo-replies",
        cron: "*/5 * * * *",
        command: `${bin} replies`,
        to: "channel:111111111111111111",
      }),
      expect.objectContaining({
        name: "bamboo-nudge",
        cron: "*/30 17-23 * * *",
        command: `${bin} nudge`,
      }),
    ]);
    install();
    expect(automations()).toHaveLength(2);
    const calls = readFileSync(join(home, "openclaw-calls.log"), "utf8");
    // Regression: OpenClaw refuses `automations add` without --agent once a second agent exists.
    const adds = calls.split("\n").filter((l) => l.includes("automations add"));
    expect(adds).toHaveLength(2);
    for (const l of adds) expect(l).toContain("--agent main");
    expect(calls).not.toContain(TOKEN);
    expect(calls).not.toMatch(/gateway (stop|restart)/u);
    // Nothing touched PandaBase's gateway env.
    expect(existsSync(join(oc(), ".env"))).toBe(false);
  });

  it("warns when #bamboo isn't enabled for the bot, without changing the allowlist", () => {
    const r = install({ BAMBOO_DISCORD_CHANNEL_ID: "333333333333333333" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("#bamboo isn't enabled for the bot yet");
    expect(readFileSync(join(home, "openclaw-calls.log"), "utf8")).not.toMatch(
      /config set channels/u,
    );
    expect(channels()["333333333333333333"]).toBeUndefined();
    // The printed command already pins the channel (Will runs it as is).
    const line = r.out.split("\n").find((l) => l.includes("openclaw config set channels."));
    expect(line, r.out).toBeDefined();
    const json = /'(\{.*\})'/u.exec(line!.replace(/'\\''/gu, "'"))?.[1];
    const entry = JSON.parse(json ?? "null") as ChannelEntry;
    expect(entry).toMatchObject({ enabled: true, requireMention: false, skills: ["bamboo"] });
    expect(entry.tools?.deny).toEqual(expect.arrayContaining(READERS));
    expectFirmPrompt(entry.systemPrompt);
  });

  // Bug (live): in #bamboo the agent called OpenClaw's view_image on a bare Gemini share link
  // instead of using the bamboo skill, and replied about the failed fetch. The installer now pins
  // the channel: only the bamboo skill, a firm systemPrompt, and the content readers denied.
  it("pins #bamboo to the bamboo skill, keeping its access keys and every other channel", () => {
    const others = () => JSON.stringify([channels()[PANDABASE_CHANNEL], channels()["*"]]);
    const before = others();
    const first = install();
    expect(first.code, first.out).toBe(0);
    const entry = channels()[BAMBOO]!;
    expect(entry).toMatchObject(BAMBOO_ACCESS);
    expect(entry.skills).toEqual(["bamboo"]);
    expectFirmPrompt(entry.systemPrompt);
    expect(entry.tools?.deny).toEqual(expect.arrayContaining(READERS));
    // The skill runs bamboo-tools through exec and writes pasted text with write; it reads its
    // own SKILL.md with read.
    for (const t of ["exec", "bash", "process", "write", "read", "group:runtime", "group:fs"])
      expect(entry.tools?.deny).not.toContain(t);
    expect(entry.tools?.allow).toBeUndefined();
    expect(others()).toBe(before);
    expect(backups()).toHaveLength(1);

    const second = install();
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("kept #bamboo");
    expect(channels()[BAMBOO]).toEqual(entry);
    expect(others()).toBe(before);
    expect(backups()).toHaveLength(1);
  });

  it("merges into an existing pin: replaces skills and the prompt, keeps other denies", () => {
    setChannel(BAMBOO, {
      ...BAMBOO_ACCESS,
      skills: ["something-else"],
      systemPrompt: "old",
      tools: { deny: ["canvas", "view_image"] },
    });
    const r = install();
    expect(r.code, r.out).toBe(0);
    const entry = channels()[BAMBOO]!;
    expect(entry).toMatchObject(BAMBOO_ACCESS);
    expect(entry.skills).toEqual(["bamboo"]);
    expectFirmPrompt(entry.systemPrompt);
    expect(entry.tools?.deny?.[0]).toBe("canvas");
    expect(entry.tools?.deny).toEqual(expect.arrayContaining(READERS));
    expect(entry.tools?.deny?.filter((t) => t === "view_image")).toHaveLength(1);
  });

  it("changes nothing in a dry run", () => {
    const before = readFileSync(join(oc(), "openclaw.json"), "utf8");
    const r = install({ DRY_RUN: "1" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("[dry-run]");
    expect(readFileSync(join(oc(), "openclaw.json"), "utf8")).toBe(before);
    expect(backups()).toHaveLength(0);
    expect(existsSync(join(home, ".config/bamboo/agent.env"))).toBe(false);
    expect(existsSync(join(home, ".local/bin/bamboo-tools"))).toBe(false);
  });

  it("refuses to run without an OpenClaw config (the wrong user)", () => {
    const r = spawnSync("bash", ["-c", `rm "${join(oc(), "openclaw.json")}"`]);
    expect(r.status).toBe(0);
    const out = install();
    expect(out.code).toBe(1);
    expect(out.out).toContain("run this as the user that owns the gateway");
  });
});

// The agent that serves #bamboo is the host's (DESIGN §5.1, §10 #69): the installer only reads
// which one it is, and agent/check.sh reports on it. Nothing adds an agent or changes bindings.
describe("agent/install.sh and agent/check.sh: the agent the host binds to #bamboo", () => {
  type Cfg = {
    agents?: {
      defaults?: Record<string, unknown>;
      entries?: Record<string, Record<string, unknown>>;
    };
    bindings?: unknown;
  };
  const cfg = () => readJson(join(oc(), "openclaw.json")) as Cfg;
  const patchCfg = (f: (c: Cfg) => void) => {
    const c = cfg();
    f(c);
    writeFileSync(join(oc(), "openclaw.json"), JSON.stringify(c));
  };
  const check = () => {
    const r = spawnSync("bash", [join(repo, "agent/check.sh")], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${join(home, "fakebin")}:${process.env.PATH}` },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const calls = () => readFileSync(join(home, "openclaw-calls.log"), "utf8");
  const MAIN_ALL = { agentId: "main", match: { channel: "discord", accountId: "*" } };
  const HOST = {
    agentId: "willchan",
    match: { channel: "discord", accountId: "default", peer: { kind: "channel", id: BAMBOO } },
  };
  const ws = () => join(oc(), "workspace-willchan");
  const skill = () => readFileSync(join(repo, "agent/skills/bamboo/SKILL.md"), "utf8");
  // The host's AGENTS.md: its own heading and scope, then the skill's instructions.
  const hostAgentsMd = () => {
    const body = skill().split(/^---$/mu)[2]!;
    const afterScope = body.slice(body.search(/^Scope:/mu)).replace(/^Scope:[\s\S]*?\n\n/u, "");
    return `# willchan\n\n## #bamboo channel\n\nOnly in #bamboo.\n\n${afterScope}\n## Other\n`;
  };
  const withToken = () => {
    install();
    const envFile = join(home, ".config/bamboo/agent.env");
    writeFileSync(
      envFile,
      readFileSync(envFile, "utf8").replace(
        "BAMBOO_AGENT_API_TOKEN=",
        `BAMBOO_AGENT_API_TOKEN=${TOKEN}`,
      ),
    );
  };
  const setUp = (entry: Record<string, unknown> = {}) => {
    install(); // creates ~/.config/bamboo/bamboo.config.json with the channel id
    patchCfg((c) => {
      c.agents = {
        defaults: { model: { primary: "ollama/qwen3.8:27b" }, thinkingDefault: "off" },
        entries: { main: {}, willchan: { model: "ollama/qwen3.8:27b", ...entry } },
      };
      c.bindings = [HOST, MAIN_ALL];
    });
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(ws(), "AGENTS.md"), hostAgentsMd());
  };

  it("changes no agent or binding, and the check passes on the host's setup", () => {
    setUp();
    const before = cfg();
    const r = install();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("#bamboo (111111111111111111) is served by the willchan agent");
    expect(r.out).toContain("agent-check: ok");
    expect(cfg().agents).toEqual(before.agents);
    expect(cfg().bindings).toEqual(before.bindings);
    expect(calls()).not.toMatch(/^(agents add|config set (agents|bindings))/mu);
    const c = check();
    expect(c.code, c.out).toBe(0);
    expect(c.out).toContain("the willchan agent exists (ollama/qwen3.8:27b)");
    expect(c.out).toContain("has SKILL.md's instructions");
    expect(c.out).toContain("willchan thinkingDefault off");
    expect(c.out).not.toContain("⚠");
  });

  // Regression: the installer passed --agent main, so a re-run moved the host's jobs off willchan.
  it("puts the automations on the serving agent, and moves them back there", () => {
    setUp();
    withToken();
    install();
    expect(automations().map((a) => a.agentId)).toEqual(["willchan", "willchan"]);
    const autos = join(oc(), "automations.json");
    writeFileSync(autos, JSON.stringify(automations().map((a) => ({ ...a, agentId: "main" }))));
    expect(check().out).toContain(
      "automations on another agent than willchan: bamboo-replies → main",
    );
    install();
    expect(automations().map((a) => a.agentId)).toEqual(["willchan", "willchan"]);
    expect(automations()).toHaveLength(2);
    install({ OPENCLAW_AGENT: "other" });
    expect(automations().map((a) => a.agentId)).toEqual(["other", "other"]);
  });

  it("follows main's wildcard; fails with no binding, and the jobs fall back to main", () => {
    setUp();
    patchCfg((c) => {
      c.bindings = [MAIN_ALL];
    });
    // main's wildcard is a valid choice for the host: the check follows it.
    const viaMain = check();
    expect(viaMain.code, viaMain.out).toBe(0);
    expect(viaMain.out).toContain("routes to main");
    patchCfg((c) => {
      c.bindings = [];
    });
    withToken();
    const r = install();
    expect(r.out).toContain("no binding routes #bamboo");
    expect(automations().map((a) => a.agentId)).toEqual(["main", "main"]);
    expect(check().out).toContain("isn't bound to an agent");
  });

  it("fails when the agent is missing or its skills allowlist leaves out bamboo", () => {
    setUp({ skills: ["browser-automation"] });
    const bad = check();
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("leaves out bamboo");
    patchCfg((c) => {
      delete c.agents!.entries!.willchan;
    });
    expect(check().out).toContain("no willchan agent");
  });

  it("warns, without failing, on thinking and a stale AGENTS.md", () => {
    setUp({ skills: ["bamboo"], thinkingDefault: "high" });
    writeFileSync(join(ws(), "AGENTS.md"), "# willchan\n\n## #bamboo channel\n\nold copy\n");
    const r = check();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("thinkingDefault is 'high', not off");
    expect(r.out).toMatch(/AGENTS\.md lacks \d+ line\(s\) of SKILL\.md's instructions/u);
    patchCfg((c) => {
      delete c.agents!.entries!.willchan!.thinkingDefault;
      delete c.agents!.defaults!.thinkingDefault;
    });
    expect(check().out).toContain("thinkingDefault is 'OpenClaw default', not off");
  });

  it("skips the lookup without a channel id", () => {
    const r = install({ BAMBOO_DISCORD_CHANNEL_ID: "" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("served by");
    expect(cfg().agents).toBeUndefined();
  });
});

// The skill's description is what the model sees when it picks a skill, so a bare share link must
// match it. OpenClaw parses the frontmatter as YAML: an unquoted value is cut at " #" (a comment),
// which left the old description as "Bamboo intake in the". It must be one double-quoted line.
describe("agent/skills/bamboo/SKILL.md description", () => {
  const skill = readFileSync(join(repo, "agent/skills/bamboo/SKILL.md"), "utf8");
  const line = /^description: (.*)$/mu.exec(skill)?.[1] ?? "";

  it("is a double-quoted YAML string that survives the # in #bamboo", () => {
    expect(line).toMatch(/^"[^"\\]*"$/u);
  });

  it("names #bamboo and every share-link form, and says the link is never opened", () => {
    expect(line).toMatch(/^"/u);
    const description = JSON.parse(line) as string;
    expect(description).toContain("#bamboo");
    for (const host of ["share.gemini.google/", "gemini.google.com/share/", "g.co/gemini/share/"])
      expect(description).toContain(host);
    expect(description).toMatch(/bare/u);
    expect(description).toMatch(/never open/iu);
    expect(Buffer.byteLength(description)).toBeLessThan(1024);
  });
});
