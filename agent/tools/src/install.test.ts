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
            "222222222222222222": { channels: { "111111111111111111": { enabled: true } } },
          },
        },
      },
    }),
  );
});

describe("agent/install.sh", () => {
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
    expect(readFileSync(envFile, "utf8")).toMatch(/^AGENT_API_TOKEN=$/mu);
    expect(first.out).toContain("skipped the automations");
    expect(automations()).toEqual([]);

    const second = install();
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("kept skills.load.extraDirs");
    expect(extraDirs()).toEqual([PANDABASE, ours]);
    expect(backups()).toHaveLength(1);
  });

  it("adds the two command automations once the token is in, then updates them in place", () => {
    install();
    const envFile = join(home, ".config/bamboo/agent.env");
    writeFileSync(
      envFile,
      readFileSync(envFile, "utf8").replace("AGENT_API_TOKEN=", `AGENT_API_TOKEN=${TOKEN}`),
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
