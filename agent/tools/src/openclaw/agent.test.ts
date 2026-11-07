// The bamboo agent's AGENTS.md generator and its binding merge (DESIGN §5.1, §10 #50). Synthetic
// skill and ids only.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTS_MD_HEADER,
  bambooBinding,
  mergeBindings,
  renderAgentsMd,
  routeFor,
  skillBody,
} from "./agent";
import { runSetup } from "./main";

const SKILL = `---
name: demo
description: "A synthetic skill for #demo: never open links."
metadata:
  { "openclaw": { "requires": { "bins": ["demo-tools"] } } }
---

# Demo intake

Run \`demo-tools import --url <link>\` for a link.

| a | b |
|---|---|
| x | y |
`;

const CH = "111111111111111111";
const OTHER = "555555555555555555";
const MAIN_ALL = { agentId: "main", match: { channel: "discord", accountId: "*" } };
const TELEGRAM = { agentId: "main", match: { channel: "telegram" } };
const PANDA = {
  agentId: "pandabase",
  match: { channel: "discord", accountId: "default", peer: { kind: "channel", id: OTHER } },
};

describe("renderAgentsMd", () => {
  it("is the header, a blank line, then the skill body without its frontmatter", () => {
    const md = renderAgentsMd(SKILL);
    expect(md).toBe(
      `${AGENTS_MD_HEADER}\n\n# Demo intake\n\nRun \`demo-tools import --url <link>\` for a link.\n\n| a | b |\n|---|---|\n| x | y |\n`,
    );
    expect(md.split("\n").slice(0, 3)).toEqual([
      "# Bamboo agent",
      "",
      "You only handle the #bamboo Discord channel. Follow these instructions exactly; they are complete, so you don't need to open any skill file.",
    ]);
    expect(md).not.toContain("description:");
    expect(md).not.toContain("---\n");
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("is deterministic and ignores trailing whitespace and CRLF frontmatter", () => {
    expect(renderAgentsMd(SKILL)).toBe(renderAgentsMd(`${SKILL}\n\n`));
    expect(renderAgentsMd(SKILL.replace(/^(---)\n/u, "$1\r\n"))).toBe(renderAgentsMd(SKILL));
  });

  it("refuses a file without frontmatter, or with an empty body", () => {
    expect(() => renderAgentsMd("# no frontmatter\n")).toThrow(/frontmatter/u);
    expect(() => renderAgentsMd("---\nname: x\n---\n\n  \n")).toThrow(/empty body/u);
  });

  it("works on the real skill: its whole body, and none of its frontmatter", () => {
    const real = new URL("../../../skills/bamboo/SKILL.md", import.meta.url);
    const r = runSetup(["agents-md", real.pathname], () => "");
    expect(r.code).toBe(0);
    expect(r.out.startsWith(`${AGENTS_MD_HEADER}\n\n# Bamboo intake\n`)).toBe(true);
    expect(r.out).toContain("bamboo-tools import --url");
    expect(r.out).not.toMatch(/^(name|description|metadata):/mu);
  });
});

describe("skillBody", () => {
  it("drops only the first frontmatter block", () => {
    expect(skillBody("---\na: 1\n---\nbody\n---\nmore\n")).toBe("body\n---\nmore\n");
  });
});

describe("mergeBindings", () => {
  it("puts #bamboo first and keeps every other binding, in order", () => {
    const merged = mergeBindings([MAIN_ALL, TELEGRAM, PANDA], CH);
    expect(merged).toEqual([bambooBinding(CH), MAIN_ALL, TELEGRAM, PANDA]);
    expect(merged[0]).toEqual({
      agentId: "bamboo",
      match: { channel: "discord", accountId: "default", peer: { kind: "channel", id: CH } },
    });
  });

  it("is a no-op when already merged, keeping the existing binding's extra keys", () => {
    const ours = { ...bambooBinding(CH), comment: "kept" };
    const current = [ours, MAIN_ALL, PANDA];
    expect(mergeBindings(current, CH)).toEqual(current);
    expect(mergeBindings(mergeBindings([MAIN_ALL], CH), CH)).toEqual(mergeBindings([MAIN_ALL], CH));
  });

  it("moves our binding ahead of main's wildcard", () => {
    expect(mergeBindings([MAIN_ALL, bambooBinding(CH)], CH)).toEqual([bambooBinding(CH), MAIN_ALL]);
  });

  it("replaces another agent's binding for #bamboo and a stale #bamboo id, nothing else", () => {
    const toMain = { agentId: "main", match: { ...bambooBinding(CH).match } };
    const stale = bambooBinding("999999999999999999");
    expect(mergeBindings([toMain, MAIN_ALL, stale, PANDA], CH)).toEqual([
      bambooBinding(CH),
      MAIN_ALL,
      PANDA,
    ]);
  });

  it("uses the configured account id", () => {
    expect(mergeBindings([], CH, "bot2")[0]!.match).toMatchObject({ accountId: "bot2" });
    // An existing binding on another account isn't ours: it's replaced.
    expect(mergeBindings([bambooBinding(CH, "default")], CH, "bot2")).toEqual([
      bambooBinding(CH, "bot2"),
    ]);
  });

  it("rejects a channel id that isn't digits", () => {
    expect(() => mergeBindings([], "<#bamboo>")).toThrow(/digits/u);
  });
});

describe("routeFor", () => {
  it("is the first matching binding's agent", () => {
    expect(routeFor(mergeBindings([MAIN_ALL, PANDA], CH), CH)).toBe("bamboo");
    expect(routeFor([MAIN_ALL, bambooBinding(CH)], CH)).toBe("main");
    expect(routeFor([PANDA, TELEGRAM], CH)).toBeNull();
    expect(routeFor([PANDA, MAIN_ALL], OTHER)).toBe("pandabase");
  });

  it("skips other accounts' bindings", () => {
    expect(routeFor([bambooBinding(CH, "bot2"), MAIN_ALL], CH)).toBe("main");
    expect(routeFor([bambooBinding(CH, "bot2"), MAIN_ALL], CH, "bot2")).toBe("bamboo");
  });

  it("is null for anything but a list", () => {
    expect(routeFor({ ok: false }, CH)).toBeNull();
  });
});

describe("runSetup (the helper CLI install.sh and check.sh call)", () => {
  it("merges bindings from stdin", () => {
    const r = runSetup(["bindings", CH], () => JSON.stringify([MAIN_ALL]));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([bambooBinding(CH), MAIN_ALL]);
    expect(runSetup(["route", CH], () => r.out).out).toBe("bamboo\n");
  });

  // Reading an error body (or nothing) as [] would drop main's binding on the next set.
  it("refuses stdin that isn't a JSON array", () => {
    for (const bad of ["", "not json", '{"ok": false, "error": {}}', "null"]) {
      const r = runSetup(["bindings", CH], () => bad);
      expect(r.code, bad).toBe(1);
      expect(r.out).toMatch(/bindings: stdin/u);
    }
  });

  it("fails on a missing or frontmatter-less skill file, and on bad usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "bamboo-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter\n");
    expect(runSetup(["agents-md", join(dir, "SKILL.md")], () => "").code).toBe(1);
    expect(runSetup(["agents-md", join(dir, "missing.md")], () => "").code).toBe(1);
    expect(runSetup(["nope"], () => "").code).toBe(2);
  });
});
