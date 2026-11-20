// GET /api/version (DESIGN §6 *Saving*): the build this server runs, so a page from an older deploy
// can notice and reload before its saves fail (lib/client/build.ts). No auth: it says nothing but
// a deployment id.
import { BUILD_ID } from "@/lib/client/build";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ build: BUILD_ID }, { headers: { "cache-control": "no-store" } });
}
