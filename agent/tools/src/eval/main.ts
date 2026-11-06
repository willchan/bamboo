import { runEval } from "./cli";

const { code, out, err, served } = await runEval(process.argv.slice(2), {
  env: process.env,
  log: (line) => process.stderr.write(`${line}\n`),
});
if (out) process.stdout.write(`${out}\n`);
if (err) process.stderr.write(`${err}\n`);
process.exitCode = code;
if (served) {
  process.on("SIGINT", () => void served.close().then(() => process.exit(0)));
}
