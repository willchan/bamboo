// Helper CLI for agent/install.sh and agent/check.sh (run with tsx; not on PATH, not for the model):
//   agents-md <SKILL.md>              print the bamboo agent's workspace AGENTS.md
//   bindings <channel id> [account]   stdin: current `bindings` array → print the merged array
//   route <channel id> [account]      stdin: `bindings` array → print the agent #bamboo goes to
// Exit 1 (message on stderr) on bad input, 2 on bad usage.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mergeBindings, renderAgentsMd, routeFor } from "./agent";

/** stdin must be a JSON array: anything else (an error body, nothing) is refused, never read as []. */
const parseBindings = (text: string): unknown[] => {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("bindings: stdin is not JSON");
  }
  if (!Array.isArray(v)) throw new Error("bindings: stdin is not a JSON array");
  return v;
};

export function runSetup(argv: string[], stdin: () => string): { code: number; out: string } {
  const [cmd, a, b] = argv;
  try {
    if (cmd === "agents-md" && a) return { code: 0, out: renderAgentsMd(readFileSync(a, "utf8")) };
    if (cmd === "bindings" && a)
      return { code: 0, out: `${JSON.stringify(mergeBindings(parseBindings(stdin()), a, b))}\n` };
    if (cmd === "route" && a)
      return { code: 0, out: `${routeFor(parseBindings(stdin()), a, b) ?? ""}\n` };
  } catch (e) {
    return { code: 1, out: `${(e as Error).message}\n` };
  }
  return {
    code: 2,
    out: "usage: agents-md <SKILL.md> | bindings <channel id> | route <channel id>\n",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { code, out } = runSetup(process.argv.slice(2), () => readFileSync(0, "utf8"));
  (code === 0 ? process.stdout : process.stderr).write(out);
  process.exitCode = code;
}
