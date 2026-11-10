import { expect, test, type Page } from "@playwright/test";

// Will's pending iPhone checks, on the seeded app (scripts/seed-data.ts: due reviews, today's 3
// new cards already learning, 6 phrases waiting in Up next). In order: the second test uses up
// the waiting phrases.

/** What the server renders for Today, without running any client code. */
async function serverToggle(page: Page): Promise<string | null> {
  const html = await (await page.request.get("/")).text();
  const button = /<button[^>]*data-testid="nudge-toggle"[^>]*>/.exec(html)?.[0] ?? "";
  return /aria-checked="(\w+)"/.exec(button)?.[1] ?? null;
}

test("the reminder switch stays off after a reload, then turns back on", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByTestId("nudge-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toContainText("off");

  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toContainText("off");
  expect(await serverToggle(page)).toBe("false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await serverToggle(page)).toBe("true");
});

test("Learn 3 more starts a round with 3 new cards", async ({ page }) => {
  await page.goto("/");
  // Today's 3 new cards are already learning, so new ones wait for the opt-in.
  await expect(page.getByTestId("today-summary")).toContainText("0 new");
  await page.getByRole("button", { name: "Learn 3 more" }).click();
  await page.waitForURL(/\/review\//);

  const progress = page.getByTestId("progress");
  await expect(progress).toHaveText(/^1 \/ \d+$/);
  const total = Number((await progress.textContent())!.split("/")[1]);
  let fresh = 0;
  for (let i = 1; i <= total; i++) {
    await expect(progress).toHaveText(`${i} / ${total}`);
    await expect(async () => {
      await page.getByRole("button", { name: "Show", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Good/ })).toBeVisible({ timeout: 300 });
    }).toPass();
    // A first sight offers Already know.
    if (await page.getByRole("button", { name: "Already know" }).isVisible()) fresh++;
    await page.getByRole("button", { name: /^Good/ }).click();
  }
  expect(fresh).toBe(3);
  await expect(page.getByTestId("done-for-today")).toBeVisible();
});
