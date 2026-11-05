// bamboo-tools (DESIGN §5.1, §5.2): the deterministic CLI that OpenClaw's bamboo skill calls.
// The commands arrive in M5; until then every invocation prints usage.

export const USAGE = `usage: bamboo-tools <command>

commands (from M5):
  import --url <link> | --file <pdf> | --text-file <txt>
  segment --url <link> | --file <pdf>
  replies
  nudge`;

export interface CliResult {
  code: number;
  out: string;
}

export function run(argv: readonly string[]): CliResult {
  const [command] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    return { code: 0, out: USAGE };
  }
  return { code: 2, out: `bamboo-tools: '${command}' is not implemented yet\n\n${USAGE}` };
}
