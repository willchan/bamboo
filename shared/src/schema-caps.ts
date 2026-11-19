// Gemini's schemas without the limits it can't serve (H7, DESIGN §5.5.2, §10 #95), and the caps
// enforced here instead. Gemini refused extract_turn.v4's and the referee's `responseJsonSchema`
// with "too many states for serving" (length and count limits, number bounds). So Gemini gets
// the strict schema minus those keywords (`servableSchema`), the prompt states the limits, and
// the reply is cut to the caps (`trimToCaps`) before the strict Zod contract checks it.
import { sharedConfig } from "./config";

/** JSON-schema keywords left out of every schema sent to Gemini. */
export const UNSERVABLE_KEYWORDS = [
  "$schema",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "minProperties",
  "maxProperties",
  "uniqueItems",
] as const;

const UNSERVABLE = new Set<string>(UNSERVABLE_KEYWORDS);

/**
 * The strict schema (zod's JSON schema) without `UNSERVABLE_KEYWORDS`, at any depth. Property
 * names are kept even when they match a keyword (a property called `format` stays).
 */
export function servableSchema<T>(schema: T): T {
  const walk = (node: unknown, inProperties: boolean): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, false));
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([k]) => inProperties || !UNSERVABLE.has(k))
        .map(([k, v]) => [k, walk(v, !inProperties && k === "properties")]),
    );
  };
  return walk(schema, false) as T;
}

/** What `trimToCaps` cut, by kind. */
export interface TrimCounts {
  /** Items past `maxItems`. */
  items: number;
  /** Examples past `maxExamplesPerItem`, over all items. */
  examples: number;
  /** Tags past `maxTags`, over all items. */
  tags: number;
  /** Breakdowns with more than `maxBreakdownParts` parts (the breakdown is dropped). */
  breakdowns: number;
  /** Usefulness values outside 1–5, clamped. */
  usefulness: number;
}

export const trimmedTotal = (t: TrimCounts): number =>
  t.items + t.examples + t.tags + t.breakdowns + t.usefulness;

const E = sharedConfig.extraction;
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * An extract_turn.v4 reply (parsed JSON) cut to the caps the schema no longer enforces: the
 * first `maxItems` items, each with at most `maxExamplesPerItem` examples and `maxTags` tags, a
 * breakdown over `maxBreakdownParts` dropped, usefulness clamped to 1–5. Anything else (a wrong
 * shape, a string over its limit) is left for the strict contract and the repair turn. Pure.
 */
export function trimToCaps(json: unknown): { value: unknown; trimmed: TrimCounts } {
  const trimmed: TrimCounts = { items: 0, examples: 0, tags: 0, breakdowns: 0, usefulness: 0 };
  if (!isObj(json) || !Array.isArray(json.items)) return { value: json, trimmed };
  const cut = <T>(a: T[], max: number, key: keyof TrimCounts): T[] => {
    if (a.length <= max) return a;
    trimmed[key] += a.length - max;
    return a.slice(0, max);
  };
  const items = cut(json.items as unknown[], E.maxItems, "items").map((item) => {
    if (!isObj(item)) return item;
    const out = { ...item };
    if (Array.isArray(out.examples))
      out.examples = cut(out.examples, E.maxExamplesPerItem, "examples");
    if (Array.isArray(out.tags)) out.tags = cut(out.tags, E.maxTags, "tags");
    if (
      isObj(out.breakdown) &&
      Array.isArray(out.breakdown.parts) &&
      out.breakdown.parts.length > E.maxBreakdownParts
    ) {
      out.breakdown = null;
      trimmed.breakdowns += 1;
    }
    if (typeof out.usefulness === "number" && Number.isInteger(out.usefulness)) {
      const u = Math.min(5, Math.max(1, out.usefulness));
      if (u !== out.usefulness) trimmed.usefulness += 1;
      out.usefulness = u;
    }
    return out;
  });
  return { value: { ...json, items }, trimmed };
}

/** A pinyin reply's arrays (`pinyin`, `choices`) cut to `max` entries. Pure. */
export function trimArrays(json: unknown, max: number): unknown {
  if (!isObj(json)) return json;
  return Object.fromEntries(
    Object.entries(json).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, max) : v]),
  );
}
