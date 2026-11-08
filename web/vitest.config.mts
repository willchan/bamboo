import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    setupFiles: ["./vitest.setup.ts"],
    // next-auth imports `next/server` without an extension; let Vite resolve it.
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
    // PLAN M2: ≥ 90% coverage on the pure domain rules. `pnpm test` fails below it.
    coverage: {
      provider: "v8",
      include: ["lib/domain/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
