import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedConfig } from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import { fill, loadPrompt, parsePrompt, repairMessage, replyForModel, userMessage } from "./prompt";
import { fixtureTurns } from "./test-fakes";

const FILE = (n: string) =>
  `<!-- note ${n} -->\n<!-- system -->\nS${n}\n<!-- user -->\nU {{user_text}}\n<!-- repair -->\nR {{errors}}\n`;

describe("prompt files", () => {
  it("the shipped prompt loads as extract_turn.v2 with all three parts", () => {
    const p = loadPrompt();
    expect(p.version).toBe("extract_turn.v2");
    expect(p.system).toContain("turn_kind");
    expect(p.user).toContain("{{user_text}}");
    expect(p.user).toContain("{{reply_text}}");
    expect(p.user).toContain("{{conversation_title}}");
    expect(p.repair).toContain("{{errors}}");
    // The comment header is not part of the system message.
    expect(p.system).not.toContain("Never edit a released version");
  });

  it("the highest version wins (numerically)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bamboo-prompts-"));
    for (const n of ["1", "2", "10"]) writeFileSync(join(dir, `extract_turn.v${n}.md`), FILE(n));
    writeFileSync(join(dir, "extract_turn.v3.md.bak"), FILE("bak"));
    writeFileSync(join(dir, "other.v99.md"), FILE("99"));
    const p = loadPrompt("extract_turn", dir);
    expect(p.version).toBe("extract_turn.v10");
    expect(p.system).toBe("S10");
    expect(() => loadPrompt("missing", dir)).toThrow(/no missing\.v<N>\.md/u);
  });

  it("refuses a file without a part", () => {
    expect(() => parsePrompt("x.v1", "<!-- system -->\nS\n<!-- user -->\nU\n")).toThrow(/repair/u);
  });
});

describe("messages", () => {
  const p = loadPrompt();

  it("fills placeholders once, leaving braces in the turn alone", () => {
    expect(fill("{{a}} {{b}} {{c}}", { a: "{{b}}", b: "x" })).toBe("{{b}} x {{c}}");
  });

  it("renders the turn, with stand-ins for a missing title or prompt", () => {
    const paste = fixtureTurns.find((t) => t.turn_id === "fx-paste-1")!;
    const m = userMessage(p, paste);
    expect(m).toContain("Conversation title: (none)");
    expect(m).toContain("not available");
    expect(m).toContain("今天外面太冷了");
    expect(m).not.toMatch(/\{\{\w+\}\}/u);
    expect(repairMessage(p, "- items.0: bad")).toContain("- items.0: bad");
  });

  it("cuts a very long reply for the model (by characters, not UTF-16 units)", () => {
    const max = sharedConfig.worker.maxReplyCharsForModel;
    expect(replyForModel("好".repeat(max))).toBe("好".repeat(max));
    const cut = replyForModel("𠀀".repeat(max + 5));
    expect([...cut.split("\n")[0]!]).toHaveLength(max);
    expect(cut).toMatch(/reply cut here/u);
  });
});
