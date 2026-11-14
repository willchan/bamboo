// The #bamboo agent lookups (DESIGN §5.1, §10 #69): routing and whether an agent's AGENTS.md has
// the skill's instructions. Synthetic skill and ids only.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { instructionLines, missingInstructions, routeFor, skillBody } from "./agent";
import { runSetup } from "./main";

const SKILL = `---
name: demo
description: "A synthetic skill for #demo: never open links."
---

# Demo intake

Scope: messages in \`#demo\` only. In any other
channel, this skill does nothing.

Run \`demo-tools import --url <link>\` for a link.

| a | b |
|---|---|
| x | y |
`;
const INSTRUCTIONS = [
  "Run `demo-tools import --url <link>` for a link.",
  "| a | b |",
  "|---|---|",
  "| x | y |",
];

const CH = "111111111111111111";
const OTHER = "555555555555555555";
const MAIN_ALL = { agentId: "main", match: { channel: "discord", accountId: "*" } };
const TELEGRAM = { agentId: "main", match: { channel: "telegram" } };
const binding = (agentId: string, id: string, accountId = "default") => ({
  agentId,
  match: { channel: "discord", accountId, peer: { kind: "channel", id } },
});

describe("routeFor", () => {
  it("is the first matching binding's agent", () => {
    expect(routeFor([binding("willchan", CH), MAIN_ALL], CH)).toBe("willchan");
    expect(routeFor([MAIN_ALL, binding("willchan", CH)], CH)).toBe("main");
    expect(routeFor([binding("pandabase", OTHER), TELEGRAM], CH)).toBeNull();
    expect(routeFor([binding("pandabase", OTHER), MAIN_ALL], OTHER)).toBe("pandabase");
  });

  it("skips other accounts' bindings and direct-message peers", () => {
    expect(routeFor([binding("willchan", CH, "bot2"), MAIN_ALL], CH)).toBe("main");
    expect(routeFor([binding("willchan", CH, "bot2"), MAIN_ALL], CH, "bot2")).toBe("willchan");
    const dm = {
      agentId: "willchan",
      match: { channel: "discord", peer: { kind: "direct", id: CH } },
    };
    expect(routeFor([dm, MAIN_ALL], CH)).toBe("main");
  });

  it("is null for anything but a list", () => {
    expect(routeFor({ ok: false }, CH)).toBeNull();
  });
});

describe("instructionLines / missingInstructions", () => {
  it("are the body's lines after the title and the Scope: paragraph", () => {
    expect(instructionLines(SKILL)).toEqual(INSTRUCTIONS);
    expect(skillBody(SKILL)).toMatch(/^\n# Demo intake/u);
  });

  it("find nothing missing in a section with its own heading and scope", () => {
    const agents = `# Agent\n\n## #demo channel\n\nOnly in #demo.\n\n${INSTRUCTIONS.join("\n")}\n\n## Other\n`;
    expect(missingInstructions(SKILL, agents)).toEqual([]);
    expect(missingInstructions(SKILL, agents.replace(/\n/gu, "\r\n"))).toEqual([]);
  });

  it("list the lines a stale copy lacks", () => {
    const stale = INSTRUCTIONS.join("\n").replace("--url <link>", "<link>");
    expect(missingInstructions(SKILL, stale)).toEqual([INSTRUCTIONS[0]]);
  });

  it("refuse a skill without frontmatter, a Scope: paragraph or instructions", () => {
    expect(() => instructionLines("no frontmatter\n")).toThrow(/frontmatter/u);
    expect(() => instructionLines("---\nname: x\n---\n\n# X\n\nBody.\n")).toThrow(/Scope/u);
    expect(() => instructionLines("---\nname: x\n---\n\nScope: here.\n")).toThrow(/instructions/u);
  });

  it("work on the real skill", () => {
    const real = readFileSync(
      fileURLToPath(new URL("../../../skills/bamboo/SKILL.md", import.meta.url)),
      "utf8",
    );
    const lines = instructionLines(real);
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.join("\n")).toContain("bamboo-tools import --url");
    expect(lines.join("\n")).not.toMatch(/^(name|description):|^# Bamboo intake|^Scope:/mu);
  });
});

describe("runSetup (the helper CLI install.sh and check.sh call)", () => {
  it("prints the route from stdin", () => {
    const r = runSetup(["route", CH], () => JSON.stringify([binding("willchan", CH), MAIN_ALL]));
    expect(r).toEqual({ code: 0, out: "willchan\n" });
    expect(runSetup(["route", CH], () => "[]").out).toBe("\n");
  });

  // Reading an error body (or nothing) as [] would report the default agent.
  it("refuses stdin that isn't a JSON array", () => {
    for (const bad of ["", "not json", '{"ok": false, "error": {}}', "null"]) {
      const r = runSetup(["route", CH], () => bad);
      expect(r.code, bad).toBe(1);
      expect(r.out).toMatch(/bindings: stdin/u);
    }
  });

  it("prints missing instruction lines, one per line", () => {
    const dir = mkdtempSync(join(tmpdir(), "bamboo-skill-"));
    writeFileSync(join(dir, "SKILL.md"), SKILL);
    writeFileSync(join(dir, "AGENTS.md"), INSTRUCTIONS.slice(1).join("\n"));
    expect(runSetup(["missing", join(dir, "SKILL.md"), join(dir, "AGENTS.md")], () => "")).toEqual({
      code: 0,
      out: `${INSTRUCTIONS[0]}\n`,
    });
    expect(runSetup(["missing", join(dir, "SKILL.md"), join(dir, "nope.md")], () => "").code).toBe(
      1,
    );
    expect(runSetup(["nope"], () => "").code).toBe(2);
  });
});
