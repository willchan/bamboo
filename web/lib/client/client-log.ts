// Client error reports (DESIGN §8.5): sort a failure into a kind and send its fixed fields to
// `POST /api/client-log`, so a failure on the phone leaves a line in Vercel's logs. Never the
// error's message: it can quote what Will typed.
import type { ClientLogEntry } from "@bamboo/shared";
import { BUILD_ID } from "./build";

type Kind = ClientLogEntry["kind"];

const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const token = (v: unknown): string | undefined =>
  typeof v === "string" && TOKEN.test(v) ? v : undefined;

/**
 * Why a request failed. A stale page's server action is gone from the new build
 * (`UnrecognizedActionError`, Next 16); a fetch that got no answer is a `TypeError` ("Load
 * failed" on iOS); an error the server threw reaches the client with Next's `digest`.
 */
export function classifyError(err: unknown, online = true): Kind {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "UnrecognizedActionError") return "stale";
  if (!online || name === "TypeError") return "offline";
  if (token((err as { digest?: unknown } | null)?.digest)) return "server";
  return "other";
}

/** The page's first path segment: `/review/abc` → `/review`. */
export function pageOf(pathname: string): string {
  const first = pathname.split("/")[1] ?? "";
  return /^[a-z-]{0,31}$/u.test(first) ? `/${first}` : "/";
}

export interface Failure {
  where: ClientLogEntry["where"];
  err: unknown;
  attempts?: number;
  /** Overrides the kind classifyError would pick (e.g. a version check found a newer deploy). */
  kind?: Kind;
}

/** The entry for a failure, from fixed fields only. */
export function logEntry(
  f: Failure,
  env: { pathname: string; online: boolean; build?: string },
): ClientLogEntry {
  const e = f.err as { name?: unknown; digest?: unknown } | null;
  const entry: ClientLogEntry = {
    where: f.where,
    kind: f.kind ?? classifyError(f.err, env.online),
    build: token(env.build ?? BUILD_ID) ?? "unknown",
    page: pageOf(env.pathname),
    online: env.online,
  };
  const name = token(e?.name);
  const digest = token(e?.digest);
  if (name) entry.name = name;
  if (digest) entry.digest = digest;
  if (f.attempts !== undefined) entry.attempts = Math.min(100, Math.max(0, f.attempts));
  return entry;
}

/** Send a failure report; never throws (reporting must not break the page). */
export function reportFailure(f: Failure): void {
  try {
    const entry = logEntry(f, { pathname: location.pathname, online: navigator.onLine });
    const body = JSON.stringify(entry);
    // A beacon survives the reload that often follows (a stale page).
    const sent = navigator.sendBeacon?.(
      "/api/client-log",
      new Blob([body], { type: "application/json" }),
    );
    if (!sent) {
      void fetch("/api/client-log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Nothing to do: the report is best effort.
  }
}
