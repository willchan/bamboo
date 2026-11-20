// POST /api/client-log (DESIGN §8.5): a failure the PWA reports (lib/api/client-log.ts).
import { handleClientLog } from "@/lib/api/client-log";

export const POST = handleClientLog;
