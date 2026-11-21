// A term's examples (DESIGN §4.6 step 3, §10 #103): written by Gemini since extract_turn.v7,
// copied on the Ollama fallback, and never several that reword one another. Synthetic turns only.
import { describe, expect, it } from "vitest";
import { config } from "../config";
import {
  distinctExamples,
  isNearDuplicate,
  mergeExamples,
  rerunExamples,
  validateExtraction,
  writesExamples,
} from "./queue";

// Three wordings of one errand question, all containing the term: what a reply about a grocery
// run looks like.
const Q1 = "做红豆汤除了红豆和冰糖，还要买什么吗？";
const Q2 = "阿姨，红豆和冰糖我都买了，还要买莲子、百合或者陈皮之类的配料吗？";
const Q3 = "阿姨，做红豆汤除了红豆和冰糖，还要买什么吗？比如莲子还是百合？";

describe("isNearDuplicate", () => {
  it("catches one example containing another, or mostly the same character pairs", () => {
    expect(isNearDuplicate(Q1, Q3, "红豆")).toBe(true);
    expect(isNearDuplicate(Q3, Q1, "红豆")).toBe(true);
    expect(isNearDuplicate(Q1, Q2, "红豆")).toBe(true);
    expect(isNearDuplicate("红豆要先泡一晚。", "红豆要先泡一晚！")).toBe(true);
  });

  it("keeps examples that use the word differently", () => {
    expect(isNearDuplicate("红豆要先泡一晚。", "超市的红豆卖完了。")).toBe(false);
    expect(isNearDuplicate("拿一下。", "你拿了吗？")).toBe(false);
    expect(isNearDuplicate("。", "红豆")).toBe(true); // an empty key is inside anything
    expect(isNearDuplicate("红", "豆")).toBe(false);
    // Short examples sharing the term and a 了吗 use the word differently.
    expect(isNearDuplicate("红豆好了吗？", "红豆泡了吗？", "红豆")).toBe(false);
    expect(isNearDuplicate("洗手间在哪？", "洗手间没纸了。", "洗手间")).toBe(false);
  });
});

describe("distinctExamples", () => {
  const ex = (hanzi: string, english: string | null = null) => ({ hanzi, english });

  it("regression: three rewordings of one question make one example, the shortest", () => {
    expect(distinctExamples([ex(Q3, "a"), ex(Q2, "b"), ex(Q1, "c")], "红豆")).toEqual([
      ex(Q1, "c"),
    ]);
  });

  it("keeps order, fills English for the same sentence, and caps", () => {
    const list = [
      ex("红豆要先泡一晚。"),
      ex("红豆要先泡一晚！", "Soak overnight."),
      ex("超市的红豆卖完了。"),
    ];
    expect(distinctExamples(list)).toEqual([
      ex("红豆要先泡一晚。", "Soak overnight."),
      ex("超市的红豆卖完了。"),
    ]);
    expect(distinctExamples(list, "", 1)).toHaveLength(1);
    expect(
      distinctExamples([ex("红豆要先泡一晚。", "kept"), ex("红豆要先泡一晚。", "new")]),
    ).toEqual([ex("红豆要先泡一晚。", "kept")]);
  });

  it("mergeExamples lets a shorter rewording replace a stored long one", () => {
    const stored = [{ hanzi: Q3, english: "a", turn_id: "t1" }];
    expect(mergeExamples(stored, { hanzi: Q1, english: "b", turn_id: "t2" })).toEqual([
      { hanzi: Q1, english: "b", turn_id: "t2" },
    ]);
  });
});

describe("rerunExamples", () => {
  const ex = (hanzi: string, english: string | null, turn_id = "t1") => ({
    hanzi,
    english,
    turn_id,
  });
  it("replaces the stored examples, keeping stored English for the same sentence", () => {
    const stored = [ex(Q1, "old"), ex(Q2, null), ex(Q3, null)];
    expect(rerunExamples(stored, [ex("红豆要先泡一晚。", "Soak.", "t2")])).toEqual([
      ex("红豆要先泡一晚。", "Soak.", "t2"),
    ]);
    expect(
      rerunExamples(stored, [ex("做红豆汤除了红豆和冰糖，还要买什么吗？", "new", "t2")]),
    ).toEqual([ex(Q1, "old", "t2")]);
  });
  it("keeps the stored ones when the re-run has none", () => {
    expect(rerunExamples([ex(Q1, "a")], [])).toEqual([ex(Q1, "a")]);
  });
});

describe("writesExamples", () => {
  it("is Gemini only: the Ollama fallback must still copy", () => {
    expect(writesExamples("gemini-3.8-flash")).toBe(true);
    expect(writesExamples("Gemini-Flash")).toBe(true);
    expect(writesExamples("qwen3.8:27b")).toBe(false);
    expect(writesExamples(null)).toBe(false);
    expect(writesExamples(undefined)).toBe(false);
  });
});

describe("validateExtraction: written examples (extract_turn.v7)", () => {
  const turn = {
    userText: "what else do I buy for red bean soup",
    replyText: `你可以问阿姨：“${Q1}” 或者：“${Q3}” 红豆 = red beans.`,
  };
  const term = (examples: { hanzi: string; english: string | null }[]) => ({
    turn_kind: "errand" as const,
    items: [
      {
        kind: "term" as const,
        hanzi: "红豆",
        english: "red beans",
        note: null,
        heard_as: null,
        example: null,
        examples,
        usefulness: 3,
        tags: ["groceries"],
      },
    ],
  });
  const written = { writtenExamples: true };

  it("keeps a short written example only when Gemini wrote it", () => {
    const r = term([{ hanzi: "红豆要先泡一晚。", english: "Soak the red beans overnight." }]);
    expect(validateExtraction(turn, r, config.extraction, written).items[0]!.examples).toEqual([
      { hanzi: "红豆要先泡一晚。", english: "Soak the red beans overnight." },
    ]);
    const ollama = validateExtraction(turn, r);
    expect(ollama.items[0]!.examples).toEqual([]);
    expect(ollama.items[0]!.flags).toContain("example_dropped");
    expect(ollama.examplesDropped).toBe(1);
  });

  it("still needs the term, no romanization, and a short sentence when written", () => {
    const long = "红豆".padEnd(config.phrase.writtenExampleMaxChars + 1, "很");
    const v = validateExtraction(
      turn,
      term([
        { hanzi: "绿豆要先泡一晚。", english: null },
        { hanzi: "红豆 hongdou 要先泡。", english: null },
        { hanzi: long, english: null },
      ]),
      config.extraction,
      written,
    );
    expect(v.items[0]!.examples).toEqual([]);
    expect(v.examplesDropped).toBe(3);
  });

  it("regression: rewordings copied from the reply collapse to the shortest", () => {
    const v = validateExtraction(
      turn,
      term([
        { hanzi: Q3, english: "a" },
        { hanzi: Q1, english: "b" },
      ]),
    );
    expect(v.items[0]!.examples).toEqual([{ hanzi: Q1, english: "b" }]);
    expect(v.examplesDropped).toBe(1);
  });

  it("never promotes a written example to a say turn's sentence", () => {
    const say = {
      ...term([{ hanzi: "红豆要先泡一晚。", english: "Soak." }]),
      turn_kind: "say" as const,
    };
    const v = validateExtraction(turn, say, config.extraction, written);
    expect(v.items.map((i) => i.kind)).toEqual(["term"]);
    expect(v.sentencePromoted).toBe(0);
    // A copied one still is.
    const copied = { ...term([{ hanzi: Q1, english: "What else?" }]), turn_kind: "say" as const };
    expect(validateExtraction(turn, copied, config.extraction, written).sentencePromoted).toBe(1);
  });
});
