// Request timing (DESIGN §8.5): per page render, server action or API route, the total time, the
// time spent in the database and how many database calls it made. Emitted as one structured log
// line (Vercel logs) and, on API routes, a `Server-Timing` header. Only fixed fields are logged:
// never phrase text, ids or anything Will typed.
import { AsyncLocalStorage } from "node:async_hooks";

export interface Timing {
  route: string;
  startedAt: number;
  /** Summed duration of database calls (parallel calls each count in full). */
  dbMs: number;
  /** Database calls: one per `execute` or `batch` (a batch is one round trip). */
  dbQueries: number;
  /**
   * Database calls started while no other call was in flight: the number of sequential round
   * trips, which is what latency to the database multiplies.
   */
  dbSerial: number;
  inFlight: number;
}

const STORE = Symbol.for("bamboo.timing.store");

// One store per process, not per module copy: Next.js bundles pages, actions and route handlers
// separately, and the one shared DB client (repo/db.ts) is wrapped by whichever bundle opens it.
const holder = globalThis as unknown as { [STORE]?: AsyncLocalStorage<Timing> };
const store = (holder[STORE] ??= new AsyncLocalStorage<Timing>());

/** The timing of the current request, if one is being measured. */
export const currentTiming = (): Timing | undefined => store.getStore();

const now = () => performance.now();

async function track<T>(call: () => Promise<T>): Promise<T> {
  const t = store.getStore();
  if (!t) return call();
  if (t.inFlight === 0) t.dbSerial++;
  t.inFlight++;
  t.dbQueries++;
  const start = now();
  try {
    return await call();
  } finally {
    t.dbMs += now() - start;
    t.inFlight--;
  }
}

const WRAPPED = Symbol.for("bamboo.timing.wrapped");

/**
 * Count and time this client's `execute` and `batch` calls (what Drizzle uses) for the request
 * being measured (a libSQL `Client`). Mutates the client in place, once; outside a measured request it's a no-op.
 */
type AsyncFn = (...args: never[]) => Promise<unknown>;

export function instrumentClient<C extends { execute: AsyncFn; batch: AsyncFn }>(client: C): C {
  const c = client as C & { [WRAPPED]?: true };
  if (c[WRAPPED]) return client;
  const execute = client.execute.bind(client) as (...a: unknown[]) => Promise<unknown>;
  const batch = client.batch.bind(client) as (...a: unknown[]) => Promise<unknown>;
  Object.assign(c, {
    execute: (...a: unknown[]) => track(() => execute(...a)),
    batch: (...a: unknown[]) => track(() => batch(...a)),
    [WRAPPED]: true,
  });
  return client;
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;

/** `Server-Timing` value: total and db durations, with the call count as the db description. */
export function serverTimingHeader(t: Timing, totalMs: number): string {
  return `total;dur=${round1(totalMs)}, db;dur=${round1(t.dbMs)};desc="${t.dbQueries} queries"`;
}

export interface TimingLine {
  msg: "timing";
  route: string;
  status: number;
  total_ms: number;
  db_ms: number;
  db_queries: number;
  db_serial: number;
}

export function timingLine(t: Timing, status: number, totalMs: number): TimingLine {
  return {
    msg: "timing",
    route: t.route,
    status,
    total_ms: round1(totalMs),
    db_ms: round1(t.dbMs),
    db_queries: t.dbQueries,
    db_serial: t.dbSerial,
  };
}

/** Where timing lines go; tests replace it. */
export const timingSink = { log: (line: TimingLine) => console.log(JSON.stringify(line)) };

/**
 * The status a page or action ended with, from what it threw: Next.js signals redirect() and
 * notFound() with errors whose `digest` says so. Undefined for Next's own render bailouts, which
 * aren't request outcomes and aren't logged.
 */
export function statusOfError(err: unknown): number | undefined {
  const digest = (err as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string") return 500;
  if (digest.startsWith("NEXT_REDIRECT")) return Number(digest.split(";")[3]) || 307;
  if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK")) return Number(digest.split(";")[1]) || 404;
  return undefined;
}

function begin(route: string): Timing {
  return { route, startedAt: now(), dbMs: 0, dbQueries: 0, dbSerial: 0, inFlight: 0 };
}

/**
 * Run a page render or server action, measured. `route` is a fixed label (e.g. `page /`,
 * `action grade`), never built from request data.
 */
export async function timed<T>(route: string, fn: () => Promise<T>): Promise<T> {
  const t = begin(route);
  try {
    const out = await store.run(t, fn);
    timingSink.log(timingLine(t, 200, now() - t.startedAt));
    return out;
  } catch (err) {
    const status = statusOfError(err);
    if (status !== undefined) timingSink.log(timingLine(t, status, now() - t.startedAt));
    throw err;
  }
}

/** An API route handler, measured, with a `Server-Timing` header on its response. */
export function timedRoute<A extends unknown[]>(
  route: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const t = begin(route);
    let res: Response;
    try {
      res = await store.run(t, () => handler(...args));
    } catch (err) {
      timingSink.log(timingLine(t, 500, now() - t.startedAt));
      throw err;
    }
    const total = now() - t.startedAt;
    timingSink.log(timingLine(t, res.status, total));
    try {
      res.headers.set("Server-Timing", serverTimingHeader(t, total));
    } catch {
      // Immutable headers (e.g. Response.redirect): copy the response.
      res = new Response(res.body, res);
      res.headers.set("Server-Timing", serverTimingHeader(t, total));
    }
    return res;
  };
}
