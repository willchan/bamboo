// POST /api/client-log's handler (DESIGN §8.5): one failure reported by the PWA (lib/client/client-log.ts),
// written as one structured line to Vercel's logs. Signed-in only; fixed fields only (the Zod
// contract refuses anything else); at most config.client.logPerMinute lines per instance.
import { ClientLogEntry } from "@bamboo/shared";
import { getCurrentUser } from "@/lib/auth/current";
import { config } from "@/lib/config";

/** Where lines go; tests replace it. */
export const clientLogSink = {
  log: (line: ClientLogEntry & { msg: "client_error" }) => console.warn(JSON.stringify(line)),
};

const rate = { start: 0, count: 0 };

/** For tests: start a fresh rate-limit window. */
export function resetClientLogLimit(): void {
  rate.start = 0;
  rate.count = 0;
}

export async function handleClientLog(req: Request): Promise<Response> {
  if (!(await getCurrentUser())) return new Response(null, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  const parsed = ClientLogEntry.safeParse(body);
  if (!parsed.success) return new Response(null, { status: 400 });

  const now = Date.now();
  if (now - rate.start >= 60_000) {
    rate.start = now;
    rate.count = 0;
  }
  if (rate.count >= config.client.logPerMinute) return new Response(null, { status: 429 });
  rate.count++;

  clientLogSink.log({ msg: "client_error", ...parsed.data });
  return new Response(null, { status: 204 });
}
