// POST /api/jobs/claim (worker): lease the next extract_turn job, or 204 (DESIGN §3.2).
import type { ClaimedJob } from "@bamboo/shared";
import { checkBearer } from "@/lib/api/http";
import { claimJob } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const POST = timedRoute("POST /api/jobs/claim", async (req: Request): Promise<Response> => {
  const denied = checkBearer(req, "worker");
  if (denied) return denied;
  const claimed = await claimJob(getDb(), Date.now());
  return claimed
    ? Response.json(claimed satisfies ClaimedJob)
    : new Response(null, { status: 204 });
});
