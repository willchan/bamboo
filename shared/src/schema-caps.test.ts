import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sharedConfig } from "./config";
import { ModelExtractTurnResultV4 } from "./contracts/extract";
import {
  UNSERVABLE_KEYWORDS,
  servableSchema,
  trimArrays,
  trimToCaps,
  trimmedTotal,
} from "./schema-caps";

const E = sharedConfig.extraction;

/** Every object key at any depth, with whether it sits directly under `properties`. */
function keys(node: unknown, underProperties = false, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => keys(n, false, out));
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) {
      if (!underProperties) out.push(k);
      keys(v, !underProperties && k === "properties", out);
    }
  return out;
}

describe("servableSchema", () => {
  it("leaves no unservable keyword in the v4 schema, and keeps its shape", () => {
    const strict = z.toJSONSchema(ModelExtractTurnResultV4);
    expect(keys(strict)).toEqual(expect.arrayContaining(["maxItems", "maxLength", "minimum"]));
    const served = servableSchema(strict);
    for (const k of UNSERVABLE_KEYWORDS) expect(keys(served)).not.toContain(k);
    expect(keys(served)).toEqual(
      expect.arrayContaining(["type", "properties", "required", "enum", "anyOf", "items"]),
    );
    // The strict schema is untouched (Ollama still gets it).
    expect(keys(strict)).toContain("maxItems");
  });

  it("keeps a property that is named like a keyword", () => {
    expect(
      servableSchema({
        type: "object",
        properties: { format: { type: "string", format: "date" }, pattern: { type: "string" } },
      }),
    ).toEqual({
      type: "object",
      properties: { format: { type: "string" }, pattern: { type: "string" } },
    });
  });
});

const item = (o: Record<string, unknown> = {}) => ({
  kind: "term",
  hanzi: "高压锅",
  english: "pressure cooker",
  note: null,
  heard_as: null,
  examples: [],
  usefulness: 3,
  tags: [],
  pinyin: [],
  breakdown: null,
  ...o,
});

describe("trimToCaps", () => {
  it("cuts items, examples and tags to the caps, drops a long breakdown, clamps usefulness", () => {
    const ex = { hanzi: "用高压锅煮。", english: null };
    const json = {
      turn_kind: "decode",
      items: [
        item({
          examples: Array(E.maxExamplesPerItem + 2).fill(ex),
          tags: ["food", "cooking", "household", "time"],
          usefulness: 7,
        }),
        item({
          breakdown: {
            parts: Array(E.maxBreakdownParts + 1).fill({ hanzi: "高", gloss: "high" }),
            summary: "s",
          },
          usefulness: 0,
        }),
        ...Array(E.maxItems).fill(item()),
      ],
    };
    const { value, trimmed } = trimToCaps(json);
    expect(trimmed).toEqual({ items: 2, examples: 2, tags: 1, breakdowns: 1, usefulness: 2 });
    expect(trimmedTotal(trimmed)).toBe(8);
    const parsed = ModelExtractTurnResultV4.parse(value);
    expect(parsed.items).toHaveLength(E.maxItems);
    expect(parsed.items[0]).toMatchObject({ usefulness: 5 });
    expect(parsed.items[0]!.examples).toHaveLength(E.maxExamplesPerItem);
    expect(parsed.items[1]).toMatchObject({ breakdown: null, usefulness: 1 });
    // The input isn't changed.
    expect(json.items).toHaveLength(E.maxItems + 2);
  });

  it("leaves a reply within the caps, or of the wrong shape, as it is", () => {
    const ok = { turn_kind: "other", items: [item()] };
    expect(trimToCaps(ok)).toEqual({
      value: ok,
      trimmed: { items: 0, examples: 0, tags: 0, breakdowns: 0, usefulness: 0 },
    });
    expect(trimToCaps("nope").value).toBe("nope");
    expect(trimToCaps({ items: [1, null] }).value).toEqual({ items: [1, null] });
  });
});

describe("trimArrays", () => {
  it("cuts top-level arrays only", () => {
    expect(trimArrays({ pinyin: ["a", "b", "c"], n: 1 }, 2)).toEqual({ pinyin: ["a", "b"], n: 1 });
    expect(trimArrays([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });
});
