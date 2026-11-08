// POST /api/imports (agent): upload a conversation's new turns, chunked (DESIGN §3.2).
import { ImportRequest, sharedConfig, type ImportResponse } from "@bamboo/shared";
import { apiError, checkBearer, readBody } from "@/lib/api/http";
import { receiveImport } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const POST = timedRoute("POST /api/imports", async (req: Request): Promise<Response> => {
  const denied = checkBearer(req, "agent");
  if (denied) return denied;
  const body = await readBody(req, ImportRequest, sharedConfig.imports.maxBodyBytes);
  if (!body.ok) return body.response;
  const key = req.headers.get("idempotency-key")?.trim().slice(0, 200) || null;
  const res = await receiveImport(getDb(), body.data, key, Date.now());
  if (!res.ok) return apiError(res.error === "not_found" ? 404 : 409, res.error);
  return Response.json({
    import_id: res.importId,
    turns_new: res.turnsNew,
    turns_added: res.turnsAdded,
  } satisfies ImportResponse);
});
