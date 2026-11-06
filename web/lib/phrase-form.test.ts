import { describe, expect, it } from "vitest";
import { addresseeChip } from "./addressee";
import { phraseFormToInput, splitTags } from "./phrase-form";

const form = (entries: [string, string][]) => {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
};

describe("phraseFormToInput", () => {
  it("reads every field, examples and card types", () => {
    const input = phraseFormToInput(
      form([
        ["kind", "term"],
        ["hanzi", "我得走"],
        ["english", "I have to go"],
        ["addressee", "nanny"],
        ["heardAs", ""],
        ["note", ""],
        ["tags", "household，baby、food, x"],
        ["example0Hanzi", "我得走了"],
        ["example0English", "I have to go now"],
        ["cardTypes", "say"],
        ["cardTypes", "listen"],
        ["pinyinFor", "我得走"],
        ["pinyinCount", "3"],
        ["py0", ""],
        ["py1", "dei3"],
        ["py2", ""],
      ]),
    );
    expect(input).toMatchObject({
      kind: "term",
      hanzi: "我得走",
      tags: ["household", "baby", "food", " x"],
      cardTypes: ["say", "listen"],
      pinyinEdits: ["", "dei3", ""],
    });
    expect(input.examples).toHaveLength(3);
    expect(input.examples![0]).toEqual({ hanzi: "我得走了", english: "I have to go now" });
  });

  it("ignores pinyin inputs rendered for different hanzi", () => {
    const input = phraseFormToInput(
      form([
        ["hanzi", "我得走了"],
        ["pinyinFor", "我得走"],
        ["pinyinCount", "3"],
        ["py1", "dei3"],
      ]),
    );
    expect(input.pinyinEdits).toBeUndefined();
    expect(input.cardTypes).toEqual([]);
  });

  it("splits tags on English and Chinese commas", () => {
    expect(splitTags("a,b，c、d")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("addresseeChip", () => {
  it("shows who a Say card is for", () => {
    expect(addresseeChip("yuesao")).toBe("→ 阿姨");
    expect(addresseeChip("Toddler")).toBe("→ 宝宝");
    expect(addresseeChip("anyone")).toBeNull();
    expect(addresseeChip(null)).toBeNull();
    expect(addresseeChip("grandma")).toBe("→ grandma");
  });
});
