// POST /api/imports/{id}/notified (agent): the Discord reply was posted (DESIGN §3.2).
import { apiError, checkBearer } from "@/lib/api/http";
import { markNotified } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const POST = timedRoute(
  "POST /api/imports/{id}/notified",
  async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
    const denied = checkBearer(req, "agent");
    if (denied) return denied;
    const { id } = await ctx.params;
    const ok = await markNotified(getDb(), id, Date.now());
    return ok ? new Response(null, { status: 204 }) : apiError(404, "not_found");
  },
);
