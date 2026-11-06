// The OpenClaw skill and the example config stay in step with the CLI (PandaBase's
// test_skills.py idea): the frontmatter parses, and every command the skill names exists.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "./cli";
import { ToolsConfig } from "./env";

const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const skill = readFileSync(repo("agent/skills/bamboo/SKILL.md"), "utf8");

function frontmatter(md: string) {
  const m = /^---\n([\s\S]*?)\n---\n/u.exec(md);
  if (!m) throw new Error("no frontmatter");
  const fm = m[1]!;
  const field = (k: string) => new RegExp(`^${k}: (.+)$`, "mu").exec(fm)?.[1];
  const meta = /^metadata:\n([\s\S]*)$/mu.exec(fm)?.[1];
  return {
    name: field("name"),
    description: field("description"),
    metadata: JSON.parse(meta ?? "null") as {
      openclaw: { emoji: string; requires: { bins: string[]; env?: string[] } };
    },
    body: md.slice(m[0].length),
  };
}

describe("agent/skills/bamboo/SKILL.md", () => {
  const fm = frontmatter(skill);

  it("has a parseable frontmatter gated on bamboo-tools", () => {
    expect(fm.name).toBe("bamboo");
    expect(fm.description).toMatch(/#bamboo/u);
    expect(fm.metadata.openclaw.requires.bins).toEqual(["bamboo-tools"]);
    // The gateway env is PandaBase's (its AGENT_API_TOKEN): Bamboo never gates on it.
    expect(fm.metadata.openclaw.requires.env).toBeUndefined();
  });

  it("names only commands and flags that exist", () => {
    const uses = [...fm.body.matchAll(/bamboo-tools ([a-z]+)((?: --[a-z-]+(?: <[^>]+>)?)*)/gu)];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    const named = new Set<string>();
    for (const [, cmd, rest] of uses) {
      expect(Object.keys(COMMANDS)).toContain(cmd);
      named.add(cmd!);
      const flags = [...(rest ?? "").matchAll(/--([a-z-]+)/gu)].map((f) => f[1]);
      for (const f of flags) expect(COMMANDS[cmd as keyof typeof COMMANDS]).toContain(f);
    }
    expect([...named].sort()).toEqual(["import", "nudge", "replies"]);
  });

  it("covers every import source and the Discord ids", () => {
    for (const f of ["--url", "--file", "--text-file", "--channel-id", "--message-id"])
      expect(fm.body).toContain(f);
  });
});

describe("agent/bamboo.config.example.json", () => {
  it("is a valid tools config with placeholder ids", () => {
    const raw = JSON.parse(readFileSync(repo("agent/bamboo.config.example.json"), "utf8")) as {
      discord: { channel_id: string };
      automations: Record<string, string>;
    };
    expect(ToolsConfig.safeParse(raw).success).toBe(true);
    expect(raw.discord.channel_id).toMatch(/^0+$/u);
    expect(Object.keys(raw.automations).sort()).toEqual(["nudge_cron", "replies_cron", "tz"]);
  });
});
