import { describe, expect, it } from "vitest";
import { config } from "../config";
import { derivedFields, examplesFor, initialCardTypes, PhraseInput } from "./phrase";
import { frequencyPoints } from "./queue";

describe("initialCardTypes (DESIGN §4.8)", () => {
  it("gives decoded terms a Listen card", () => {
    expect(initialCardTypes("term", "decode")).toEqual(["listen"]);
  });

  it("gives everything else a Say card", () => {
    expect(initialCardTypes("term", "say")).toEqual(["say"]);
    expect(initialCardTypes("term", null)).toEqual(["say"]);
    expect(initialCardTypes("frame", "decode")).toEqual(["say"]);
    expect(initialCardTypes("sentence", "other")).toEqual(["say"]);
  });
});

describe("PhraseInput", () => {
  const ok = { kind: "term", hanzi: "泡打粉", english: "baking powder", cardTypes: ["say"] };

  it("normalizes text and tidies optional fields", () => {
    const p = PhraseInput.parse({
      ...ok,
      hanzi: " ⾼压锅\n",
      english: "  pressure cooker ",
      heardAs: " gaoyaguo ",
      note: undefined,
      tags: ["Food", "food", " ", "household"],
      examples: [
        { hanzi: "用⾼压锅煮。", english: " Cook it. " },
        { hanzi: "", english: "ignored: no Chinese" },
        { hanzi: "abc", english: null },
      ],
    });
    expect(p).toMatchObject({
      hanzi: "高压锅",
      english: "pressure cooker",
      heardAs: "gaoyaguo",
      note: null,
      tags: ["food", "household"],
      examples: [{ hanzi: "用高压锅煮。", english: "Cook it.", turn_id: null }],
    });
  });

  it("rejects missing Chinese, English or card types", () => {
    const r = PhraseInput.safeParse({ ...ok, hanzi: "hello", english: " ", cardTypes: [] });
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toContain("The Chinese must contain at least one character.");
    expect(messages).toContain("Enter the English meaning or intent.");
    expect(messages).toContain("Keep at least one card type.");
  });

  it("caps examples at 3", () => {
    const ex = { hanzi: "泡打粉好", english: null };
    expect(PhraseInput.safeParse({ ...ok, examples: [ex, ex, ex, ex] }).success).toBe(false);
  });
});

describe("examplesFor", () => {
  it("keeps examples for terms only", () => {
    expect(examplesFor("term", [1])).toEqual([1]);
    expect(examplesFor("frame", [1])).toEqual([]);
  });
});

describe("derivedFields", () => {
  const base = {
    kind: "sentence" as const,
    turnKind: null,
    heardAs: null,
    askedCount: 1,
    usefulness: null,
    tags: [],
    flags: ["heard_as_dropped", "long"],
  };

  it("computes the key and score, and sets or clears `long`", () => {
    const short = derivedFields({ ...base, hanzi: "该睡觉了。" });
    expect(short).toEqual({
      hanziKey: "该睡觉了",
      baseScore: expect.closeTo(
        config.rank.kindWeight.sentence +
          frequencyPoints({ kind: "sentence", tags: [], hanziKey: "该睡觉了" }),
        2,
      ),
      flags: ["heard_as_dropped"],
    });
    const long = derivedFields({
      ...base,
      hanzi: "一二三四五六七八九十一二三四五六七八九十一",
      flags: [],
    });
    expect(long.flags).toEqual(["long"]);
  });
});
