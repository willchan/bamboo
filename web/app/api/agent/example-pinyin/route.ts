// POST /api/agent/example-pinyin (agent, §10 #107): queue the example-pinyin backfill's `pinyin`
// jobs for current terms whose examples have no settled pinyin, oldest first, at most `limit`.
// The backfill command on the Mac calls it, then its worker on the paid key reads the jobs one at
// a time under that key's rate limits; the everyday worker never claims them (DESIGN §5.5.6).
// Counts only in the response.
import { ExamplePinyinRequest, type ExamplePinyinResponse } from "@bamboo/shared";
import { checkBearer, readBody } from "@/lib/api/http";
import { getDb } from "@/lib/repo/db";
import { queueExamplePinyin } from "@/lib/repo/pinyin";
import { timedRoute } from "@/lib/timing";

const MAX_BODY_BYTES = 1024;

export const POST = timedRoute(
  "POST /api/agent/example-pinyin",
  async (req: Request): Promise<Response> => {
    const denied = checkBearer(req, "agent");
    if (denied) return denied;
    const body = await readBody(req, ExamplePinyinRequest, MAX_BODY_BYTES);
    if (!body.ok) return body.response;
    const r = await queueExamplePinyin(getDb(), Date.now(), body.data);
    return Response.json(r satisfies ExamplePinyinResponse);
  },
);
