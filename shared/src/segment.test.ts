import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repairLigatures, segmentPdfText } from "./segment";
import { turnKey } from "./turns";

const fixture = (name: string) =>
  readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), "utf8");

describe("segmentPdfText", () => {
  const expected = JSON.parse(fixture("gemini-export.expected.json")) as {
    title: string;
    turns: { user_text: string; reply_text: string }[];
  };
  const got = segmentPdfText(fixture("gemini-export.txt"));

  it("segments the synthetic export into the exact expected turns", () => {
    expect(got.title).toBe(expected.title);
    expect(got.turns).toEqual(expected.turns);
  });

  it("normalizes radical lookalikes, drops boilerplate, chips and duplicates", () => {
    const all = got.turns.map((t) => `${t.user_text}\n${t.reply_text}`).join("\n");
    expect(all).not.toMatch(/[⺀-⻿⼀-⿟]/u);
    for (const junk of ["Sign in", "Gemini may display", "Your privacy", "Source:", "Explore"])
      expect(all).not.toContain(junk);
    expect(all).not.toContain("gemini.google.com/share");
    expect(all).not.toContain("Rice cooker settings"); // a suggestion chip
    expect(all.match(/汤有点咸，加点水吧。/gu)).toHaveLength(1); // consecutive duplicate
    // the prompt line repeated across the page break appears once
    expect(got.turns[2]!.user_text.match(/too salty/gu)).toHaveLength(1);
  });

  it("repairs ligature damage so a PDF prompt keys like the same prompt from a link", () => {
    expect(got.turns[1]!.user_text).toContain("bottle");
    const fromLink =
      'She said something like "gao ya guo" and\npointed at the bottle on the stove. What is it?';
    expect(turnKey({ user_text: fromLink, reply_text: "x" }, "link")).toBe(
      turnKey(got.turns[1]!, "pdf"),
    );
  });

  it("does not take an indented table cell for a prompt", () => {
    expect(got.turns).toHaveLength(5);
    expect(got.turns[0]!.reply_text).toContain("also 电锅 in Taiwan");
  });

  it("ignores a trailing prompt with no reply, and empty input", () => {
    const cut = ["T", "", " ".repeat(30) + "A question with no answer"].join("\n");
    expect(segmentPdfText(cut)).toEqual({ title: "T", turns: [] });
    expect(segmentPdfText("")).toEqual({ title: null, turns: [] });
  });

  it("needs a reply line right after the block", () => {
    const text = ["T", "", " ".repeat(30) + "Indented, then", "", " ".repeat(12) + "mid"].join(
      "\n",
    );
    expect(segmentPdfText(text).turns).toEqual([]);
  });

  it("continues a prompt across a page break with no repeated line", () => {
    const pad = " ".repeat(26);
    const text = ["T", "", `${pad}First half of`, "", `\f${pad}the prompt`, "", "答：好。"].join(
      "\n",
    );
    expect(segmentPdfText(text).turns).toEqual([
      { user_text: "First half of the prompt", reply_text: "答：好。" },
    ]);
  });
});

describe("repairLigatures", () => {
  it("maps symbols only inside or at the start of words", () => {
    expect(repairLigatures("Simpli!ed bo#le &akes o%en")).toBe("Simplified bottle flakes often");
    expect(repairLigatures("Thanks! & 50% #1 R&D")).toBe("Thanks! & 50% #1 R&D");
    expect(repairLigatures("a!b", {})).toBe("a!b");
  });
});
