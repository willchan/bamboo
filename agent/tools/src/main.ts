import { run } from "./cli";

const { code, out } = run(process.argv.slice(2));
(code === 0 ? console.log : console.error)(out);
process.exitCode = code;
