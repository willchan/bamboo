// GET /api/agent/eval/turns?limit=&seed= (agent): a seeded sample of past questions with Gemini's
// answers for the local tutor evaluation (docs/ROADMAP.md › Tutor). Read-only; `bamboo-eval` on
// the Mac writes what it gets only to an output directory outside the repo.
import { EvalTurnsQuery, type EvalTurnsResponse } from "@bamboo/shared";
import { apiError, checkBearer } from "@/lib/api/http";
import { getDb } from "@/lib/repo/db";
import { evalTurns } from "@/lib/repo/tutor-eval";

export async function GET(req: Request): Promise<Response> {
  const denied = checkBearer(req, "agent");
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const parsed = EvalTurnsQuery.safeParse({
    limit: params.get("limit") ?? undefined,
    seed: params.get("seed") ?? undefined,
  });
  if (!parsed.success) {
    return apiError(400, "invalid_query", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const body = await evalTurns(getDb(), parsed.data.limit, parsed.data.seed);
  return Response.json(body satisfies EvalTurnsResponse);
}
