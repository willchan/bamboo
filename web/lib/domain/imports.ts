// Import summaries (DESIGN §5.1 *Results*) and the worker's status line on Today (DESIGN §6).
import type { ImportKind, PinyinPairs } from "@bamboo/db";
import { NOTHING_NEW, PUBLIC_LINK_NOTE } from "@bamboo/shared";
import { config } from "../config";
import { displayPinyin, replyPinyin } from "./pinyin";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Shared with bamboo-tools, whose immediate "Nothing new" reply must match (M5).
export { PUBLIC_LINK_NOTE };

export interface SummaryInput {
  kind: ImportKind;
  turnsNew: number;
  /** New phrases queued, plus dropped/expired ones revived. */
  phrasesNew: number;
  /** Existing phrases asked about again. */
  phrasesAgain: number;
  jobsFailed: number;
  /** The import's phrases at the top of the queue, in queue order. */
  nextUp: readonly NextUpPhrase[];
}

/** A phrase as stored: its computed pinyin and Will's override, shown as the PWA shows them. */
export interface NextUpPhrase {
  hanzi: string;
  english: string;
  pinyin: PinyinPairs;
  pinyinOverride: PinyinPairs | null;
}

/** `高压锅 gāo yā guō (pressure cooker)`: every hanzi in a reply comes with its pinyin. */
export const nextUpLabel = (p: NextUpPhrase) =>
  `${p.hanzi} ${replyPinyin(displayPinyin(p.pinyin, p.pinyinOverride))} (${p.english})`;

/**
 * The ready-to-post Discord reply: "✅ 9 new questions → 14 phrases queued. Next up: 高压锅 gāo yā
 * guō (pressure cooker), …", plus asked-again and failure lines, and the public-link reminder.
 * If it would pass Discord's message limit, Next up names fewer phrases (never without pinyin).
 */
export function importSummary(
  s: SummaryInput,
  maxChars: number = config.imports.discordMaxChars,
): string {
  for (let n = s.nextUp.length; n > 0; n--) {
    const text = summaryText(s, s.nextUp.slice(0, n));
    if (text.length <= maxChars) return text;
  }
  return summaryText(s, []);
}

function summaryText(s: SummaryInput, nextUp: readonly NextUpPhrase[]): string {
  const head =
    s.turnsNew === 0
      ? NOTHING_NEW
      : `✅ ${plural(s.turnsNew, "new question")} → ${
          s.phrasesNew === 0 ? "no new phrases" : `${plural(s.phrasesNew, "phrase")} queued`
        }.`;
  const lines = [head];
  if (nextUp.length > 0) {
    lines[0] += ` Next up: ${nextUp.map(nextUpLabel).join(", ")}.`;
  }
  if (s.phrasesAgain > 0) {
    lines.push(
      `🔁 ${plural(s.phrasesAgain, "phrase")} you'd asked about before ${
        s.phrasesAgain === 1 ? "is" : "are"
      } back in rotation.`,
    );
  }
  if (s.jobsFailed > 0) {
    lines.push(
      `⚠️ ${plural(s.jobsFailed, "question")} couldn't be processed; Retry failed on the Imports page.`,
    );
  }
  if (s.kind === "link") lines.push(PUBLIC_LINK_NOTE);
  return lines.join("\n");
}

export type WorkerStatus =
  | { kind: "idle" }
  | { kind: "online"; waiting: number }
  | { kind: "offline"; waiting: number; lastSeenAt: number | null };

/**
 * Today shows a line only when questions are waiting and the Mac worker hasn't been heard from
 * for `offlineAfterMinutes` (it heartbeats every 10 min).
 */
export function workerStatus(
  waiting: number,
  lastHeartbeatAt: number | null,
  now: number,
  offlineAfterMinutes: number = config.worker.offlineAfterMinutes,
): WorkerStatus {
  if (waiting === 0) return { kind: "idle" };
  const online = lastHeartbeatAt !== null && now - lastHeartbeatAt < offlineAfterMinutes * 60_000;
  return online
    ? { kind: "online", waiting }
    : { kind: "offline", waiting, lastSeenAt: lastHeartbeatAt };
}
