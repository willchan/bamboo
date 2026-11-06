import { run } from "./cli";

const { code, out, err } = await run(process.argv.slice(2));
if (out) process.stdout.write(`${out}\n`);
if (err) process.stderr.write(`${err}\n`);
process.exitCode = code;
