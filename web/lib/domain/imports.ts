// Import summaries (DESIGN §5.1 *Results*) and the worker's status line on Today (DESIGN §6).
import type { ImportKind } from "@bamboo/db";
import { config } from "../config";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const PUBLIC_LINK_NOTE =
  "🔗 This share link is public; you can delete it in Gemini → Settings → Public links.";

export interface SummaryInput {
  kind: ImportKind;
  turnsNew: number;
  /** New phrases queued, plus dropped/expired ones revived. */
  phrasesNew: number;
  /** Existing phrases asked about again. */
  phrasesAgain: number;
  jobsFailed: number;
  /** The import's phrases at the top of the queue, in queue order. */
  nextUp: readonly { hanzi: string; english: string }[];
}

/**
 * The ready-to-post Discord reply: "✅ 9 new questions → 14 phrases queued. Next up: 高压锅
 * (pressure cooker), …", plus asked-again and failure lines, and the public-link reminder.
 */
export function importSummary(s: SummaryInput): string {
  const head =
    s.turnsNew === 0
      ? "✅ Nothing new since last time."
      : `✅ ${plural(s.turnsNew, "new question")} → ${
          s.phrasesNew === 0 ? "no new phrases" : `${plural(s.phrasesNew, "phrase")} queued`
        }.`;
  const lines = [head];
  if (s.nextUp.length > 0) {
    lines[0] += ` Next up: ${s.nextUp.map((p) => `${p.hanzi} (${p.english})`).join(", ")}.`;
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
