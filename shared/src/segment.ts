// PDF-text segmentation (DESIGN §5.2 *PDF*): `pdftotext -layout -enc UTF-8` output of a printed
// Gemini conversation → title and ordered turns. Pure, so CI tests it without poppler.
import { sharedConfig } from "./config";
import { normalizeText } from "./text";

export interface SegmentedTurn {
  user_text: string;
  reply_text: string;
}

export interface Segmented {
  title: string | null;
  turns: SegmentedTurn[];
}

type Item =
  | { kind: "line"; indent: number; text: string }
  /** A run of blank lines and/or page breaks. */
  | { kind: "gap"; blanks: number; page: boolean };

const cfg = sharedConfig.segment;
const LATIN = /[A-Za-z]/u;

/**
 * Repair the ligature damage of Gemini's PDF font (`Simpli!ed` → `Simplified`): a mapped symbol
 * right after a letter (or at the start of a word) and right before a lowercase letter.
 */
export function repairLigatures(s: string, map: Readonly<Record<string, string>> = cfg.ligatures) {
  const chars = Object.keys(map)
    .map((c) => c.replace(/[\\^\]-]/gu, "\\$&"))
    .join("");
  if (!chars) return s;
  const re = new RegExp(`(^|[A-Za-z\\s"'(“‘])([${chars}])(?=[a-z])`, "gu");
  return s.replace(re, (_, before: string, c: string) => before + (map[c] ?? c));
}

const isBoilerplate = (text: string) => cfg.boilerplate.some((re) => re.test(text));

/** Raw text → lines with their indent and normalized text, and gaps (blank runs, page breaks). */
function toItems(raw: string): { title: string | null; items: Item[] } {
  const items: Item[] = [];
  let title: string | null = null;
  const pushGap = (blanks: number, page: boolean) => {
    const last = items.at(-1);
    if (last?.kind === "gap") {
      last.blanks += blanks;
      last.page ||= page;
    } else if (items.length > 0) {
      items.push({ kind: "gap", blanks, page });
    }
  };
  for (const rawLine of raw.split(/\r\n|\r|\n/u)) {
    let line = rawLine;
    if (line.includes("\f")) {
      pushGap(0, true);
      line = line.replaceAll("\f", "");
    }
    const indent = line.length - line.trimStart().length;
    const text = repairLigatures(normalizeText(line));
    if (text === "") {
      pushGap(1, false);
      continue;
    }
    if (title === null) {
      title = text;
      continue;
    }
    if (isBoilerplate(text)) continue;
    items.push({ kind: "line", indent, text });
  }
  return { title, items };
}

/** Drop each "Explore related" header and its suggestion chips, up to the next big gap. */
function dropExploreBlocks(items: Item[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === "line" && cfg.exploreHeader.test(it.text)) {
      while (i + 1 < items.length) {
        const next = items[i + 1]!;
        if (next.kind === "gap" && (next.page || next.blanks >= cfg.exploreGapBlankLines)) break;
        i++;
      }
      continue;
    }
    out.push(it);
  }
  return out;
}

/**
 * Collapse a line identical to the line before it, when nothing or only a page break lies
 * between (page breaks repeat lines). The page gap goes too, so a prompt split by the break stays
 * one block.
 */
function dropDuplicates(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (it.kind === "line") {
      const prev = out.at(-1);
      const gap = prev?.kind === "gap" ? prev : null;
      const before = gap ? out.at(-2) : prev;
      if (before?.kind === "line" && before.text === it.text && (!gap || gap.page)) {
        if (gap) out.pop();
        continue;
      }
    }
    if (it.kind === "gap" && out.at(-1)?.kind === "gap") {
      const last = out.at(-1) as Extract<Item, { kind: "gap" }>;
      last.blanks += it.blanks;
      last.page ||= it.page;
      continue;
    }
    out.push(it);
  }
  return out;
}

const isUserLine = (it: Item | undefined): it is Extract<Item, { kind: "line" }> =>
  it?.kind === "line" && it.indent >= cfg.userIndentMin && LATIN.test(it.text);

const isPageGap = (it: Item | undefined) => it?.kind === "gap" && it.page;

/**
 * If a user block starts at `i` (after a gap or at the start), its end (exclusive); else -1.
 * A block is a run of indented lines with Latin letters, and the next line after it must be
 * a reply line (indent < `replyIndentMax`).
 */
function userBlockEnd(items: Item[], i: number): number {
  if (!isUserLine(items[i])) return -1;
  if (i > 0 && items[i - 1]!.kind !== "gap") return -1;
  let end = i + 1;
  while (end < items.length) {
    if (isUserLine(items[end])) end++;
    else if (isPageGap(items[end]) && isUserLine(items[end + 1]))
      end += 2; // continued on next page
    else break;
  }
  let next = end;
  while (next < items.length && items[next]!.kind === "gap") next++;
  const after = items[next];
  if (after?.kind !== "line" || after.indent >= cfg.replyIndentMax) return -1;
  return end;
}

const joinReply = (items: Item[]): string =>
  items
    .map((it) => (it.kind === "line" ? it.text : ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

/** Segment `pdftotext -layout` output into a title and turns (DESIGN §5.2 *PDF*). */
export function segmentPdfText(raw: string): Segmented {
  const { title, items: rawItems } = toItems(raw);
  const items = dropDuplicates(dropExploreBlocks(rawItems));
  const turns: SegmentedTurn[] = [];
  let current: { user: string; reply: Item[] } | null = null;
  // A block always has a reply line after it (`userBlockEnd`), so the reply is never empty.
  const flush = () => {
    if (current) turns.push({ user_text: current.user, reply_text: joinReply(current.reply) });
  };
  for (let i = 0; i < items.length; i++) {
    const end = userBlockEnd(items, i);
    if (end > 0) {
      flush();
      const lines = items.slice(i, end).filter((it) => it.kind === "line");
      current = { user: lines.map((it) => (it as { text: string }).text).join(" "), reply: [] };
      i = end - 1;
      continue;
    }
    current?.reply.push(items[i]!);
  }
  flush();
  return { title, turns };
}
