// bamboo-worker (DESIGN §5.3, §8.3): claims extract_turn jobs from the State Engine and runs them
// on the Mac's local Ollama. The claim loop, Ollama client and heartbeat arrive in M4.
import { SHARED_PACKAGE } from "@bamboo/shared";

export const WORKER_NAME = "bamboo-worker";

/** One line for logs and the start banner. */
export function banner(): string {
  return `${WORKER_NAME} (uses ${SHARED_PACKAGE}): not implemented yet (M4)`;
}
