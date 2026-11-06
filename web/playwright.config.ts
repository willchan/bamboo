// `pnpm --filter web test:e2e`: Playwright at a phone viewport (DESIGN §6: 390×844) against a dev
// server on its own port and its own fresh database (db/e2e.db), signed in through the dev bypass.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const PORT = 3100;
const E2E_DB = fileURLToPath(new URL("../db/e2e.db", import.meta.url));

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
    {
      name: "phone",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    // A fresh, migrated database every run, then the dev server.
    command: `rm -f "${E2E_DB}" "${E2E_DB}-journal" "${E2E_DB}-wal" "${E2E_DB}-shm" && pnpm --dir .. db:migrate && pnpm exec next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DEV_AUTH_BYPASS: "1",
      TURSO_DATABASE_URL: `file:${E2E_DB}`,
      HOUSEHOLD_TZ: "America/Los_Angeles",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
