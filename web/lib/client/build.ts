// Which deploy this page came from (DESIGN §6 *Saving*). A page from an older deploy calls server
// actions the new build doesn't have, and every save fails (Vercel's Skew Protection would keep it
// on its own deploy, but needs a paid plan). So the page asks `/api/version` which build the
// server runs, and reloads into it before it loses a grade, at most once per
// config.client.reloadGuardMs.
import { config } from "../config";

/** Inlined at build time (next.config.ts): the Vercel deployment, else the commit, else "dev". */
export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || "dev";

export type BuildCheck = "same" | "changed" | "unknown";

/** Compare this page's build with the server's. Unknown when the check itself fails. */
export async function checkBuild(
  fetchFn: typeof fetch = fetch,
  build: string = BUILD_ID,
): Promise<BuildCheck> {
  try {
    const res = await fetchFn("/api/version", { cache: "no-store" });
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { build?: unknown };
    if (typeof body.build !== "string") return "unknown";
    return body.build === build ? "same" : "changed";
  } catch {
    return "unknown";
  }
}

const RELOADED_AT = "bamboo.reloadedForBuildAt";

/**
 * Reload into the new deploy, unless this tab already did within the guard window (a mismatch
 * that a reload doesn't cure must not loop). Without sessionStorage to remember that, it doesn't
 * reload: the page offers a Reload button instead. True when it reloads.
 */
export function reloadForNewBuild(
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeSession(),
  now: number = Date.now(),
  reload: () => void = () => location.reload(),
): boolean {
  try {
    if (!storage) return false;
    const last = storage.getItem(RELOADED_AT);
    if (last !== null && now - Number(last) < config.client.reloadGuardMs) return false;
    storage.setItem(RELOADED_AT, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

function safeSession(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}
