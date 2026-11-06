import { expect, test } from "@playwright/test";

// PLAN M6: the reminder toggle on Today, the nudge route behind it, and the Stats page.
const AGENT = { authorization: "Bearer e2e-agent-token" };

test("the reminder toggle turns the nudge off and on", async ({ page, request }) => {
  await page.goto("/");
  const toggle = page.getByTestId("nudge-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toContainText("around 21:00");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toContainText("off");
  // Off: the automation's poll gets nothing, whatever the time.
  const off = await request.get("/api/agent/nudge", { headers: AGENT });
  expect(off.status()).toBe(200);
  expect(await off.json()).toEqual({ text: null });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect((await request.get("/api/agent/nudge")).status()).toBe(401);
});

test("Stats shows the PRD measures", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Stats" }).click();
  await expect(page.getByRole("heading", { name: "Stats" })).toBeVisible();
  await expect(page.getByTestId("stats-habit").locator("li")).toHaveCount(4);
  for (const id of [
    "stats-retention",
    "stats-asked-again",
    "stats-not-useful",
    "stats-extraction",
    "stats-queue",
    "stats-worker",
  ])
    await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("stats-worker")).toContainText("never");
});
