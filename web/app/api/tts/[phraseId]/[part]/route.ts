// GET /api/tts/{phraseId}/{part}?v=<key> (DESIGN §6.1, §3.2): a card part's neural clip, made once
// and stored by content. Signed-in only. `part` is `phrase` or `example-<n>`. A `v` that no longer
// matches (the reading changed) still gets the current clip, just not cached. Any failure is an
// error status, and the PWA speaks with Web Speech instead.
import { getCurrentUser } from "@/lib/auth/current";
import { serverClock } from "@/lib/repo/clock";
import { getDb } from "@/lib/repo/db";
import { getClip } from "@/lib/repo/tts";
import { timedRoute } from "@/lib/timing";

export const GET = timedRoute(
  "GET /api/tts",
  async (
    req: Request,
    ctx: { params: Promise<{ phraseId: string; part: string }> },
  ): Promise<Response> => {
    if (!(await getCurrentUser())) return new Response(null, { status: 401 });
    const { phraseId, part } = await ctx.params;
    const r = await getClip(getDb(), phraseId, part, serverClock().now);
    if (r.status === "off") return new Response(null, { status: 503 });
    if (r.status === "not_found") return new Response(null, { status: 404 });
    // 429 from Azure (F0's rate limit) → 503, anything else → 502; the PWA falls back either way.
    if (r.status === "failed")
      return new Response(null, { status: r.upstream === 429 ? 503 : 502 });
    const v = new URL(req.url).searchParams.get("v");
    const current = v !== null && r.key.startsWith(v) && v.length >= 16;
    return new Response(new Uint8Array(r.audio), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(r.audio.length),
        "Cache-Control": current ? "private, max-age=31536000, immutable" : "private, no-cache",
      },
    });
  },
);
