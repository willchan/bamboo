// GET /api/cron/daily (the Vercel Schedule "daily" in web/vercel.json, CRON_SECRET bearer): expiry,
// lease requeue, event pruning. Idempotent: Schedules may, rarely, deliver a run twice.
import { checkBearer } from "@/lib/api/http";
import { runDaily } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const GET = timedRoute("GET /api/cron/daily", async (req: Request): Promise<Response> => {
  const denied = checkBearer(req, "cron");
  if (denied) return denied;
  return Response.json(await runDaily(getDb(), Date.now()));
});
