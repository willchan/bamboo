// `pnpm smoke <url>`: public, read-only checks of a deployed Bamboo (lib/smoke.ts). Exits 1 on any
// failure. Run it after each deploy, e.g. `pnpm smoke https://bamboo-panda.vercel.app`.
import { runSmoke } from "../lib/smoke";

const url = process.argv.slice(2).find((a) => a !== "--");
if (!url || !/^https?:\/\//u.test(url)) {
  console.error("usage: pnpm smoke <url>   (e.g. https://bamboo-panda.vercel.app)");
  process.exit(2);
}
const results = await runSmoke(url);
process.exit(results.every((r) => r.ok) ? 0 : 1);
