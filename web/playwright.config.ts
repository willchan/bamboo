// `pnpm --filter web test:e2e`: Playwright at a phone viewport (DESIGN §6: 390×844), signed in
// through the dev bypass. Two dev servers, each on its own port and fresh database:
//   phone   e2e/*.spec.ts on an empty db/e2e.db (the tests build their own state, in order);
//   seeded  e2e/seeded/*.spec.ts on db/e2e-seeded.db with the synthetic seed (scripts/seed-data.ts),
//           the same data `dev:seeded` and `pnpm shot` show.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const PORT = 3100;
const SEEDED_PORT = 3101;
const E2E_DB = fileURLToPath(new URL("../db/e2e.db", import.meta.url));
const SEEDED_DB = fileURLToPath(new URL("../db/e2e-seeded.db", import.meta.url));

const phone = {
  browserName: "chromium" as const,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "phone", testIgnore: "seeded/**", use: phone },
    {
      name: "seeded",
      testMatch: "seeded/**/*.spec.ts",
      use: { ...phone, baseURL: `http://localhost:${SEEDED_PORT}` },
    },
  ],
  webServer: [
    {
      // A fresh, migrated database every run, then the dev server.
      command: `rm -f "${E2E_DB}" "${E2E_DB}-journal" "${E2E_DB}-wal" "${E2E_DB}-shm" && pnpm --dir .. db:migrate && pnpm exec next dev --port ${PORT}`,
      url: `http://localhost:${PORT}/sign-in`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        DEV_AUTH_BYPASS: "1",
        TURSO_DATABASE_URL: `file:${E2E_DB}`,
        HOUSEHOLD_TZ: "America/Los_Angeles",
        // Machine tokens for the fake worker in e2e/capture.spec.ts (local values, not secrets).
        AGENT_API_TOKEN: "e2e-agent-token",
        WORKER_API_TOKEN: "e2e-worker-token",
        CRON_SECRET: "e2e-cron-secret",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
    {
      // dev-server.ts seeds a fresh file and blanks real secrets; its own build directory.
      command: `pnpm exec tsx scripts/dev-server.ts --mode seeded --port ${SEEDED_PORT} --db "${SEEDED_DB}" --dist-dir .next-e2e-seeded`,
      url: `http://localhost:${SEEDED_PORT}/sign-in`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { HOUSEHOLD_TZ: "America/Los_Angeles" },
    },
  ],
});
