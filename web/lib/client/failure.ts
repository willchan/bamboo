// What the page does when a request gives up (DESIGN §6 *Saving*, §8.5): report it, and if the page
// is from an older deploy, reload into the new one (its saves wait in localStorage).
import { checkBuild, reloadForNewBuild } from "./build";
import { classifyError, reportFailure, type Failure } from "./client-log";

export type FailureOutcome = "reloading" | "stale" | "reported";

/**
 * Report a failure. Anything but a lost connection is also checked against the server's build: an
 * older deploy's actions can fail in ways that don't name it. `stale` means the page is out of date
 * but couldn't reload itself; offer a Reload button.
 */
export async function handleFailure(f: Failure): Promise<FailureOutcome> {
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  let kind = f.kind ?? classifyError(f.err, online);
  if (kind !== "stale" && kind !== "offline" && (await checkBuild()) === "changed") kind = "stale";
  reportFailure({ ...f, kind });
  if (kind !== "stale") return "reported";
  return reloadForNewBuild() ? "reloading" : "stale";
}
