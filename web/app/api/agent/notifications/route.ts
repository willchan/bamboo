// GET /api/agent/notifications (agent): finished Discord imports with a ready summary.
import type { NotificationsResponse } from "@bamboo/shared";
import { checkBearer } from "@/lib/api/http";
import { pendingNotifications } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";

export async function GET(req: Request): Promise<Response> {
  const denied = checkBearer(req, "agent");
  if (denied) return denied;
  const notifications = await pendingNotifications(getDb());
  return Response.json({ notifications } satisfies NotificationsResponse);
}
