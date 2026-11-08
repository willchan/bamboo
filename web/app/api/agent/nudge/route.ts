// GET /api/agent/nudge (agent): the evening reminder text, or {text: null} (DESIGN §4.9). A
// non-null answer records that today's reminder was sent.
import type { NudgeResponse } from "@bamboo/shared";
import { checkBearer } from "@/lib/api/http";
import { serverClock } from "@/lib/repo/clock";
import { getDb } from "@/lib/repo/db";
import { takeNudge } from "@/lib/repo/nudge";
import { timedRoute } from "@/lib/timing";

export const GET = timedRoute("GET /api/agent/nudge", async (req: Request): Promise<Response> => {
  const denied = checkBearer(req, "agent");
  if (denied) return denied;
  const appUrl = (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/u, "");
  const text = await takeNudge(getDb(), serverClock(), appUrl);
  return Response.json({ text } satisfies NudgeResponse);
});
