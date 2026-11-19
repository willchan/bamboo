// `pnpm --filter web gen:pinyin-dict [--check]`: build `lib/data/pinyin-dict.json`, pinyin-pro's
// large dictionary (`@pinyin-pro/data/complete`) trimmed to the entries whose reading differs from
// pinyin-pro's built-in result, so the data fits a Vercel function (DESIGN §4.2, §5.5.3).
// Deterministic: the same package versions give the same bytes. `--check` exits nonzero when the
// committed file is stale. Run without `@pinyin-pro/data` loaded into pinyin-pro (this file never
// imports `lib/domain/pinyin.ts`), so "built-in" really means the default dictionary.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pinyin } from "pinyin-pro";

export type DictValue = string | [string] | [string, number] | [string, number, string];
export type Dict = Record<string, DictValue>;

const readingOf = (v: DictValue) => (Array.isArray(v) ? v[0] : v);

/** Entries whose reading differs from pinyin-pro's built-in one, in the source's order. */
export function trimDict(full: Dict): Dict {
  const trimmed: Dict = {};
  for (const [word, value] of Object.entries(full)) {
    if (pinyin(word, { toneSandhi: true }) !== readingOf(value)) trimmed[word] = value;
  }
  return trimmed;
}

/** One entry per line, so a regenerated file diffs readably. */
export function serializeDict(dict: Dict): string {
  const lines = Object.entries(dict).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

export const OUT = fileURLToPath(new URL("../lib/data/pinyin-dict.json", import.meta.url));

export function generate(): string {
  const require = createRequire(import.meta.url);
  const full = JSON.parse(
    readFileSync(require.resolve("@pinyin-pro/data/complete.json"), "utf8"),
  ) as Dict;
  return serializeDict(trimDict(full));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = generate();
  const entries = data.split("\n").length - 3;
  if (process.argv.includes("--check")) {
    const same = readFileSync(OUT, "utf8") === data;
    console.log(`pinyin-dict: ${same ? "up to date" : "STALE, run gen:pinyin-dict"}`);
    process.exit(same ? 0 : 1);
  }
  writeFileSync(OUT, data);
  console.log(`pinyin-dict: ${entries} entries, ${Buffer.byteLength(data)} bytes`);
}
