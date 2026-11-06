// One timestamped line per event, to stdout (launchd sends it to ~/Library/Logs/bamboo/worker.log).
// Never log turn text, model output or tokens: ids, counts and states only (CLAUDE.md *Privacy*).

export type Log = (line: string) => void;

export const consoleLog: Log = (line) => {
  console.log(`${new Date().toISOString()} ${line}`);
};
