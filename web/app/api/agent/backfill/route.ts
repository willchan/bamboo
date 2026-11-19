// GET /api/agent/backfill?since=<ms> (agent, H7): the backfill's counts (DESIGN §3.2, §5.5.6).
// Read-only and counts only; the backfill command on the Mac prints it before and after a run.
import { BackfillQuery, type BackfillReport } from "@bamboo/shared";
import { apiError, checkBearer } from "@/lib/api/http";
import { backfillReport } from "@/lib/repo/backfill";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const GET = timedRoute(
  "GET /api/agent/backfill",
  async (req: Request): Promise<Response> => {
    const denied = checkBearer(req, "agent");
    if (denied) return denied;
    const parsed = BackfillQuery.safeParse({
      since: new URL(req.url).searchParams.get("since") ?? undefined,
    });
    if (!parsed.success) return apiError(400, "invalid_query");
    const body = await backfillReport(getDb(), parsed.data.since);
    return Response.json(body satisfies BackfillReport);
  },
);
