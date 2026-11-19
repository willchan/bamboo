// POST /api/jobs/claim (worker): lease the next job, or 204 (DESIGN §3.2). The optional body
// `{types}` names the job types the worker can run now; without one (an older worker, which sends
// no body), only extract_turn.
import { ClaimRequest, type ClaimedJob } from "@bamboo/shared";
import { apiError, checkBearer } from "@/lib/api/http";
import { claimJob } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const POST = timedRoute("POST /api/jobs/claim", async (req: Request): Promise<Response> => {
  const denied = checkBearer(req, "worker");
  if (denied) return denied;
  const text = await req.text();
  let types: ClaimRequest["types"];
  if (text.trim()) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return apiError(400, "invalid_body", { message: "not JSON" });
    }
    const parsed = ClaimRequest.safeParse(json);
    if (!parsed.success) return apiError(400, "invalid_body");
    types = parsed.data.types;
  }
  const claimed = await claimJob(getDb(), Date.now(), types);
  return claimed
    ? Response.json(claimed satisfies ClaimedJob)
    : new Response(null, { status: 204 });
});
