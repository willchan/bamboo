// GET /api/cron/daily (Vercel Cron, CRON_SECRET bearer): expiry, lease requeue, event pruning.
import { checkBearer } from "@/lib/api/http";
import { runDaily } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";

export async function GET(req: Request): Promise<Response> {
  const denied = checkBearer(req, "cron");
  if (denied) return denied;
  return Response.json(await runDaily(getDb(), Date.now()));
}
