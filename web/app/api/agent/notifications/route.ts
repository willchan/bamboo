// GET /api/agent/notifications (agent): finished Discord imports with a ready summary.
import type { NotificationsResponse } from "@bamboo/shared";
import { checkBearer } from "@/lib/api/http";
import { pendingNotifications } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timedRoute } from "@/lib/timing";

export const GET = timedRoute(
  "GET /api/agent/notifications",
  async (req: Request): Promise<Response> => {
    const denied = checkBearer(req, "agent");
    if (denied) return denied;
    const notifications = await pendingNotifications(getDb());
    return Response.json({ notifications } satisfies NotificationsResponse);
  },
);
