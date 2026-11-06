// The tutor evaluation's read (docs/ROADMAP.md › Tutor): `GET /api/agent/eval/turns`. Read-only.
import { turn, type Db } from "@bamboo/db";
import type { EvalTurnsResponse } from "@bamboo/shared";
import { and, inArray, ne, sql } from "drizzle-orm";
import { sampleEvalTurns } from "../domain/tutor-eval";

export async function evalTurns(db: Db, limit: number, seed: string): Promise<EvalTurnsResponse> {
  // Image-only prompts are stored with empty user_text (DESIGN §4.5); pasted answers too.
  const candidates = await db
    .select({ id: turn.id, importId: turn.importId })
    .from(turn)
    .where(and(ne(sql`trim(${turn.userText})`, ""), ne(sql`trim(${turn.replyText})`, "")));
  const ids = sampleEvalTurns(candidates, limit, seed);
  const rows = ids.length
    ? await db
        .select({
          id: turn.id,
          importId: turn.importId,
          userText: turn.userText,
          replyText: turn.replyText,
        })
        .from(turn)
        .where(inArray(turn.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    turns: ids.map((id) => {
      const r = byId.get(id)!;
      return {
        turn_id: r.id,
        import_id: r.importId,
        user_text: r.userText,
        reply_text: r.replyText,
      };
    }),
    pool: {
      turns: candidates.length,
      imports: new Set(candidates.map((c) => c.importId)).size,
    },
  };
}
