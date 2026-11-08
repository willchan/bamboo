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

// DESIGN §6: grading shows the next card at once; the grade is saved in the background, and a
// failed save is retried. Runs after the test above (one card on its 10-minute step).
test("grading moves on at once and a failed save is retried", async ({ page }) => {
  for (const [hanzi, english] of [
    ["喝水吗？", "Want some water?"],
    ["洗手了吗？", "Washed your hands?"],
  ] as const) {
    await page.goto("/phrases/new");
    await page.getByRole("radio", { name: "sentence" }).check({ force: true });
    await page.getByLabel("Chinese", { exact: true }).fill(hanzi);
    await page.getByLabel("English intent", { exact: true }).fill(english);
    await page.getByRole("button", { name: "Add phrase" }).click();
    await expect(page.getByTestId("saved")).toBeVisible();
  }

  // The first grade's request fails once (as on a flaky phone connection).
  let failed = 0;
  await page.route("**/review/**", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"] && failed === 0) {
      failed++;
      return route.abort("internetdisconnected");
    }
    return route.continue();
  });

  await page.goto("/");
  await page.getByRole("button", { name: /^Another round/ }).click();
  const progress = page.getByTestId("progress");
  for (const i of [1, 2, 3]) {
    await expect(progress).toHaveText(`${i} / 3`);
    // A tap right after grading doesn't reveal the next card (config.review.revealGuardMs).
    await expect(async () => {
      await page.getByRole("button", { name: "Show", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Good/ })).toBeVisible({ timeout: 300 });
    }).toPass();
    await page.getByRole("button", { name: /^Good/ }).click();
  }
  await expect(page.getByTestId("done-for-today")).toBeVisible();
  expect(failed).toBe(1);

  // Every grade landed: the two new cards are on their learning step, the first card graduated.
  await page.getByRole("link", { name: "Back to Today" }).click();
  await expect(page.getByRole("button", { name: /^Another round \(2 due\)/ })).toBeVisible();
});

// Will's iPhone feedback: a Listen card's front is just the audio (no "you heard" hint, no "Tap
// to show"); the back shows what he first heard under the answer. Once today's new cards are used
// up (3, by the tests above), "Learn N more" starts a round with extra new cards (DESIGN §4.4).
test("Learn more adds new cards past the cap; a Listen card's hint is on the back", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("done-for-today")).toBeVisible();
  // Nothing new waiting: no Learn more.
  await expect(page.getByRole("button", { name: /^Learn \d+ more/ })).toHaveCount(0);

  await page.goto("/phrases/new");
  await page.getByRole("radio", { name: "term" }).check({ force: true });
  await page.getByLabel("Chinese", { exact: true }).fill("泡打粉");
  await page.getByLabel("English meaning", { exact: true }).fill("baking powder");
  await page.getByLabel("What you heard (optional)").fill("podafen");
  await page.getByRole("checkbox", { name: /^Say it/ }).uncheck();
  await page.getByRole("checkbox", { name: /^Listen/ }).check();
  await page.getByRole("button", { name: "Add phrase" }).click();
  await expect(page.getByTestId("saved")).toBeVisible();

  await page.goto("/phrases/new");
  await page.getByRole("radio", { name: "sentence" }).check({ force: true });
  await page.getByLabel("Chinese", { exact: true }).fill("穿鞋。");
  await page.getByLabel("English intent", { exact: true }).fill("Put on your shoes.");
  await page.getByRole("button", { name: "Add phrase" }).click();
  await expect(page.getByTestId("saved")).toBeVisible();

  // Today's 3 new cards are used, so the new phrases wait for an opt-in.
  await page.goto("/");
  await page.getByRole("button", { name: "Learn 2 more" }).click();

  // The 2 cards still on their learning step, plus the 2 extra new ones.
  const progress = page.getByTestId("progress");
  let sawListen = false;
  for (const i of [1, 2, 3, 4]) {
    await expect(progress).toHaveText(`${i} / 4`);
    await expect(page.getByText("Tap to show")).toHaveCount(0);
    await expect(page.getByText(/you (first )?heard/)).toHaveCount(0);
    // Tapping the card itself reveals it (past the reveal guard).
    await expect(async () => {
      await page.getByRole("button", { name: "Show answer" }).click();
      await expect(page.getByRole("button", { name: /^Good/ })).toBeVisible({ timeout: 300 });
    }).toPass();
    const back = page.getByTestId("card-back");
    if (await back.getByText("baking powder").isVisible()) {
      sawListen = true;
      await expect(back.getByTestId("heard-as")).toHaveText("you first heard: podafen");
    } else {
      await expect(back.getByTestId("heard-as")).toHaveCount(0);
    }
    await page.getByRole("button", { name: /^Good/ }).click();
  }
  expect(sawListen).toBe(true);
  await expect(page.getByTestId("done-for-today")).toBeVisible();
  // Nothing new left to learn.
  await expect(page.getByRole("button", { name: /^Learn \d+ more/ })).toHaveCount(0);
});
