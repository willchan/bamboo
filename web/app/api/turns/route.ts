// POST /api/turns (agent, H5): one question asked in #bamboo and the tutor's answer, stored as a
// `tutor` import with its extract job; idempotent on the Discord message id (DESIGN §3.2, §5.5.1).
import { sharedConfig, TutorTurnRequest, type TutorTurnResponse } from "@bamboo/shared";
import { apiError, checkBearer, readBody } from "@/lib/api/http";
import { receiveTutorTurn } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const POST = timedRoute("POST /api/turns", async (req: Request): Promise<Response> => {
  const denied = checkBearer(req, "agent");
  if (denied) return denied;
  const body = await readBody(req, TutorTurnRequest, sharedConfig.imports.maxBodyBytes);
  if (!body.ok) return body.response;
  const res = await receiveTutorTurn(getDb(), body.data, Date.now());
  if (!res.ok) return apiError(res.error === "not_found" ? 404 : 409, res.error);
  return Response.json({
    import_id: res.importId,
    turn_new: res.turnsAdded > 0,
  } satisfies TutorTurnResponse);
});
