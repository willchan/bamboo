// POST /api/agent/reextract (agent, H6): queue re-runs of stored turns (DESIGN §3.2, §4.6.1,
// §5.5.6), optionally including turns already on the newest prompt and limited to N, oldest
// first. H7's backfill calls it from the Mac; the worker then reads one turn per request.
import { ReextractRequest, type ReextractResponse } from "@bamboo/shared";
import { checkBearer, readBody } from "@/lib/api/http";
import { openReextractions, queueReextraction } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

const MAX_BODY_BYTES = 1024;

export const POST = timedRoute(
  "POST /api/agent/reextract",
  async (req: Request): Promise<Response> => {
    const denied = checkBearer(req, "agent");
    if (denied) return denied;
    const body = await readBody(req, ReextractRequest, MAX_BODY_BYTES);
    if (!body.ok) return body.response;
    const db = getDb();
    const queued = await queueReextraction(db, Date.now(), body.data);
    return Response.json({
      queued,
      open: await openReextractions(db),
    } satisfies ReextractResponse);
  },
);
