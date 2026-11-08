// POST /api/imports/known (agent): which turn keys are new? (DESIGN §3.2)
import { KnownRequest, type KnownResponse } from "@bamboo/shared";
import { checkBearer, readBody } from "@/lib/api/http";
import { unknownKeys } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const POST = timedRoute(
  "POST /api/imports/known",
  async (req: Request): Promise<Response> => {
    const denied = checkBearer(req, "agent");
    if (denied) return denied;
    const body = await readBody(req, KnownRequest);
    if (!body.ok) return body.response;
    const unknown = await unknownKeys(getDb(), body.data.turn_keys);
    return Response.json({ unknown } satisfies KnownResponse);
  },
);
