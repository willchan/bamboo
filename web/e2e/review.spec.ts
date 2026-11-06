import { expect, test } from "@playwright/test";

// PLAN M2: add a phrase → Start → reveal → Good → Done for today, at a phone viewport.
test("add a phrase, review it, done for today", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("done-for-today")).toBeVisible(); // empty: nothing to do

  await page.goto("/phrases/new");
  await page.getByRole("radio", { name: "sentence" }).check({ force: true });
  await page.getByLabel("Chinese", { exact: true }).fill("该吃饭了。");
  await page.getByLabel("English intent", { exact: true }).fill("Time to eat.");
  await page.getByLabel("Who it's for").fill("toddler");
  await page.getByRole("button", { name: "Add phrase" }).click();

  // Saved, with computed ruby pinyin.
  await expect(page.getByTestId("saved")).toBeVisible();
  await expect(page.locator("rt").first()).toHaveText("gāi");
  await expect(page.getByLabel("Pinyin for 吃")).toHaveAttribute("placeholder", "chī");

  // It's at the top of Up next.
  await page.getByRole("link", { name: "Up next" }).click();
  await expect(page.getByTestId("queue").locator("li").first()).toContainText("该吃饭了");

  await page.getByRole("link", { name: "Today" }).click();
  await expect(page.getByTestId("today-summary")).toHaveText("1 round · 0 due · 1 new");
  await page.getByRole("button", { name: "Start" }).click();

  // Say card: English intent and the addressee chip, then reveal.
  await expect(page.getByTestId("card-front")).toHaveText("Time to eat.");
  await expect(page.getByText("→ 宝宝")).toBeVisible();
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByTestId("card-back").locator("rt").first()).toHaveText("gāi");
  // First sight offers Not useful / Already know.
  await expect(page.getByRole("button", { name: "Not useful" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Already know" })).toBeVisible();

  await page.getByRole("button", { name: /^Good/ }).click();
  await expect(page.getByTestId("done-for-today")).toBeVisible();

  // Today agrees: the daily goal is met.
  await page.getByRole("link", { name: "Back to Today" }).click();
  await expect(page.getByTestId("done-for-today")).toBeVisible();
});
