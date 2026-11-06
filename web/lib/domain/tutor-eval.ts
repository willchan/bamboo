// The tutor evaluation's sample (docs/ROADMAP.md › Tutor › Local tutor evaluation): a few of Will's
// past questions, spread across imports so one long conversation doesn't dominate. Pure and seeded:
// the same candidates and seed give the same sample. The repo loads candidates; this picks.
import { seededShuffle } from "@bamboo/shared";

export interface EvalCandidate {
  id: string;
  importId: string;
  userText: string;
  replyText: string;
}

/** A turn worth replaying: it has question text (not image-only) and an answer to compare with. */
export const isEvalCandidate = (t: Pick<EvalCandidate, "userText" | "replyText">): boolean =>
  t.userText.trim() !== "" && t.replyText.trim() !== "";

/**
 * Up to `limit` turn ids: imports in a seeded order, each import's turns in a seeded order, then
 * round-robin (one per import per pass) until `limit`. Independent of the input's order.
 */
export function sampleEvalTurns(
  candidates: readonly Pick<EvalCandidate, "id" | "importId">[],
  limit: number,
  seed: string,
): string[] {
  const byImport = new Map<string, string[]>();
  for (const c of [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const list = byImport.get(c.importId) ?? [];
    list.push(c.id);
    byImport.set(c.importId, list);
  }
  const importIds = seededShuffle([...byImport.keys()].sort(), `${seed}:imports`);
  const queues = importIds.map((id) => seededShuffle(byImport.get(id)!, `${seed}:${id}`));
  const out: string[] = [];
  for (let pass = 0; out.length < limit; pass++) {
    let took = false;
    for (const q of queues) {
      if (out.length >= limit) break;
      if (pass < q.length) {
        out.push(q[pass]!);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}
