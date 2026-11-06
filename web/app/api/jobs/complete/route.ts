// POST /api/jobs/complete (worker): a job's result or failure (DESIGN §3.2, §5.3).
import { CompleteRequest, sharedConfig, type CompleteResponse } from "@bamboo/shared";
import { apiError, checkBearer, readBody } from "@/lib/api/http";
import { completeJob } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";

export async function POST(req: Request): Promise<Response> {
  const denied = checkBearer(req, "worker");
  if (denied) return denied;
  const body = await readBody(req, CompleteRequest, sharedConfig.imports.maxBodyBytes);
  if (!body.ok) return body.response;
  const res = await completeJob(getDb(), body.data, Date.now());
  if (res.ok) return Response.json({ job_status: res.jobStatus } satisfies CompleteResponse);
  if (res.error === "invalid_result") {
    return apiError(422, "invalid_result", {
      message: `counted as a failed attempt; job is now ${res.jobStatus}`,
      issues: res.issues,
    });
  }
  return apiError(res.error === "not_found" ? 404 : 409, res.error);
}
