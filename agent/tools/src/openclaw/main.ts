// Helper CLI for agent/install.sh and agent/check.sh (run with tsx; not on PATH, not for the model):
//   route <channel id> [account]          stdin: `bindings` array → print the agent #bamboo goes to
//   missing <SKILL.md> <AGENTS.md> [<tutor.md>]   print the skill's (and tutor prompt's) lines
//                                                 AGENTS.md lacks
//   agents-md <header> <SKILL.md> [<tutor.md>]    print the dedicated agent's AGENTS.md
// Exit 1 (message on stderr) on bad input, 2 on bad usage.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { agentsMd, missingInstructions, routeFor } from "./agent";

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
  const [cmd, a, b, c] = argv;
  const tutor = () => (c ? readFileSync(c, "utf8") : undefined);
  try {
    if (cmd === "route" && a)
      return { code: 0, out: `${routeFor(parseBindings(stdin()), a, b) ?? ""}\n` };
    if (cmd === "missing" && a && b) {
      const lines = missingInstructions(readFileSync(a, "utf8"), readFileSync(b, "utf8"), tutor());
      return { code: 0, out: lines.map((l) => `${l}\n`).join("") };
    }
    if (cmd === "agents-md" && a && b)
      return { code: 0, out: agentsMd(readFileSync(a, "utf8"), readFileSync(b, "utf8"), tutor()) };
  } catch (e) {
    return { code: 1, out: `${(e as Error).message}\n` };
  }
  return {
    code: 2,
    out: "usage: route <channel id> [account] | missing <SKILL.md> <AGENTS.md> [<tutor.md>] | agents-md <header> <SKILL.md> [<tutor.md>]\n",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { code, out } = runSetup(process.argv.slice(2), () => readFileSync(0, "utf8"));
  (code === 0 ? process.stdout : process.stderr).write(out);
  process.exitCode = code;
}
