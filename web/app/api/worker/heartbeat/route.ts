// POST /api/worker/heartbeat (worker): logged as `worker_heartbeat` (DESIGN §3.2).
import { Heartbeat } from "@bamboo/shared";
import { checkBearer, readBody } from "@/lib/api/http";
import { recordHeartbeat } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const POST = timedRoute(
  "POST /api/worker/heartbeat",
  async (req: Request): Promise<Response> => {
    const denied = checkBearer(req, "worker");
    if (denied) return denied;
    const body = await readBody(req, Heartbeat);
    if (!body.ok) return body.response;
    await recordHeartbeat(getDb(), body.data, Date.now());
    return new Response(null, { status: 204 });
  },
);
