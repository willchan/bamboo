import { expect, test } from "@playwright/test";

// PLAN M2: add a phrase → Start → reveal → Good → Done for today, at a phone viewport.
test("add a phrase, review it, done for today", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("done-for-today")).toBeVisible(); // empty: nothing to do

  await page.goto("/phrases/new");
  await page.getByRole("radio", { name: "sentence" }).check({ force: true });
  await page.getByLabel("Chinese", { exact: true }).fill("该吃饭了。");
  await page.getByLabel("English intent", { exact: true }).fill("Time to eat.");
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

  // Say card: the English intent alone (no addressee chip, DESIGN §10 #63), then reveal.
  await expect(page.getByTestId("card-front")).toHaveText("Time to eat.");
  await expect(page.getByText("→", { exact: false })).toHaveCount(0);
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
// failed save is retried. Runs after the test above (its card graduated on Good, §10 #102).
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
  for (const i of [1, 2]) {
    await expect(progress).toHaveText(`${i} / 2`);
    // A tap right after grading doesn't reveal the next card (config.review.revealGuardMs).
    await expect(async () => {
      await page.getByRole("button", { name: "Show", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Good/ })).toBeVisible({ timeout: 300 });
    }).toPass();
    await page.getByRole("button", { name: /^Good/ }).click();
  }
  await expect(page.getByTestId("done-for-today")).toBeVisible();
  expect(failed).toBe(1);

  // Every grade landed: Good graduates a new card, so nothing is due and 3 of 5 are introduced.
  await page.getByRole("link", { name: "Back to Today" }).click();
  await expect(page.getByTestId("new-today")).toHaveText("3 of 5 new today");
  await expect(page.getByRole("button", { name: /^Another round/ })).toHaveCount(0);
});

// Will's iPhone feedback: a Listen card's front is just the audio (no "you heard" hint, no "Tap
// to show"); the back shows what he first heard under the answer. Once today's new cards are used
// up (3 by the tests above, 2 more here: newPerDay is 5), "Learn N more" starts a round with extra
// new cards (DESIGN §4.4).
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

  // Two more phrases use up the rest of today's 5 new cards. Added last, they're pinned newest,
  // so they come first in the queue.
  for (const [hanzi, english] of [
    ["关灯。", "Lights off."],
    ["刷牙了吗？", "Brushed your teeth?"],
  ] as const) {
    await page.goto("/phrases/new");
    await page.getByRole("radio", { name: "sentence" }).check({ force: true });
    await page.getByLabel("Chinese", { exact: true }).fill(hanzi);
    await page.getByLabel("English intent", { exact: true }).fill(english);
    await page.getByRole("button", { name: "Add phrase" }).click();
    await expect(page.getByTestId("saved")).toBeVisible();
  }
  await page.goto("/");
  await page.getByRole("button", { name: /^Another round/ }).click();
  const filler = page.getByTestId("progress");
  await expect(filler).toHaveText(/^1 \/ \d+$/);
  const fillerTotal = Number((await filler.textContent())!.split("/")[1]);
  for (let i = 1; i <= fillerTotal; i++) {
    await expect(filler).toHaveText(`${i} / ${fillerTotal}`);
    await expect(async () => {
      await page.getByRole("button", { name: "Show", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Good/ })).toBeVisible({ timeout: 300 });
    }).toPass();
    await expect(page.getByTestId("card-back").getByText("baking powder")).toHaveCount(0);
    await page.getByRole("button", { name: /^Good/ }).click();
  }
  // Finishing waits for every grade to save; leaving earlier races the last save, and Today
  // would still count that card as new (no "Learn 2 more").
  await expect(page.getByTestId("done-for-today")).toBeVisible();

  // Today's 5 new cards are used, so the new phrases wait for an opt-in.
  await page.goto("/");
  await page.getByRole("button", { name: "Learn 2 more" }).click();

  // The 2 extra new ones (Good graduated everything before them).
  const progress = page.getByTestId("progress");
  let sawListen = false;
  for (const i of [1, 2]) {
    await expect(progress).toHaveText(`${i} / 2`);
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

// Regression (Nov 2026, DESIGN §6 *Saving*): after a deploy, an open page's saves call server
// actions the new build doesn't have; every retry failed and Retry looped forever. Now the page
// reports it, reloads into the new build, resends the kept grade, and doesn't show its card again.
test("a save from an older deploy reloads and resends instead of looping", async ({ page }) => {
  for (const [hanzi, english] of [
    ["开窗。", "Open the window."],
    ["吃水果。", "Eat some fruit."],
  ] as const) {
    await page.goto("/phrases/new");
    await page.getByRole("radio", { name: "sentence" }).check({ force: true });
    await page.getByLabel("Chinese", { exact: true }).fill(hanzi);
    await page.getByLabel("English intent", { exact: true }).fill(english);
    await page.getByRole("button", { name: "Add phrase" }).click();
    await expect(page.getByTestId("saved")).toBeVisible();
  }

  // The first grade reaches a server that doesn't know its action (what Next answers then).
  let stale = 0;
  await page.route("**/review/**", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"] && stale === 0) {
      stale++;
      return route.fulfill({ status: 404, headers: { "x-nextjs-action-not-found": "1" } });
    }
    return route.continue();
  });
  const reports: unknown[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/client-log")) reports.push(req.postDataJSON());
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Learn 2 more" }).click();
  await expect(page.getByTestId("progress")).toHaveText(/^1 \/ \d+$/);
  const first = await page.getByTestId("card-front").textContent();
  await expect(async () => {
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Good/ })).toBeVisible({ timeout: 300 });
  }).toPass();
  await page.getByRole("button", { name: /^Good/ }).click();

  // Reloaded: the graded card isn't shown again, and no Retry loop.
  await page.waitForEvent("load");
  await expect(page.getByTestId("card-front")).toBeVisible();
  await expect(page.getByTestId("card-front")).not.toHaveText(first!);
  await expect(page.getByText(/Couldn.t save|Bamboo was updated/)).toHaveCount(0);
  expect(stale).toBe(1);
  await expect
    .poll(() => reports)
    .toContainEqual(expect.objectContaining({ where: "save", kind: "stale", page: "/review" }));

  // The rest of the round, then it finishes (it waits for every save, the resent one first).
  while (!(await page.getByTestId("done-for-today").isVisible())) {
    await expect(async () => {
      await page.getByRole("button", { name: "Show", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Good/ })).toBeVisible({ timeout: 300 });
    }).toPass();
    await page.getByRole("button", { name: /^Good/ }).click();
    await expect(
      page
        .getByTestId("done-for-today")
        .or(page.getByRole("button", { name: "Show", exact: true })),
    ).toBeVisible();
  }

  // Both grades landed (the kept one resent): nothing is waiting, and nothing new is left.
  expect(await page.evaluate(() => localStorage.getItem("bamboo.pendingSaves.v1"))).toBeNull();
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Learn \d+ more/ })).toHaveCount(0);
});

// Will's iPhone feedback (Nov 2026): a card past its first sight had no way to drop or fix it
// mid-round. The ⋯ menu offers Edit phrase (same tab, back to the round at that card) and Not
// useful on every card (DESIGN §6 *Review*).
test("the ⋯ menu edits a card and comes back, or drops it", async ({ page }) => {
  for (const [hanzi, english] of [
    ["拿勺子。", "Get the spoon."],
    ["擦擦嘴。", "Wipe your mouth."],
  ] as const) {
    await page.goto("/phrases/new");
    await page.getByRole("radio", { name: "sentence" }).check({ force: true });
    await page.getByLabel("Chinese", { exact: true }).fill(hanzi);
    await page.getByLabel("English intent", { exact: true }).fill(english);
    await page.getByRole("button", { name: "Add phrase" }).click();
    await expect(page.getByTestId("saved")).toBeVisible();
  }

  await page.goto("/");
  await page.getByRole("button", { name: "Learn 2 more" }).click();
  const progress = page.getByTestId("progress");
  await expect(progress).toHaveText("1 / 2");
  const front = page.getByTestId("card-front");
  const first = (await front.textContent())!;

  // Edit: the editor opens in the same tab, ← points back at the round, and saving returns to it.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Edit phrase" }).click();
  await expect(page.getByRole("heading", { name: "Edit phrase" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to the round" })).toHaveAttribute(
    "href",
    /^\/review\//,
  );
  await page.getByLabel("English intent", { exact: true }).fill(`${first} (edited)`);
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(progress).toHaveText("1 / 2");
  await expect(front).toHaveText(`${first} (edited)`);

  // Not useful from the menu drops it and moves on.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Not useful" }).click();
  await expect(progress).toHaveText("2 / 2");
  await expect(front).not.toHaveText(`${first} (edited)`);
  await expect(async () => {
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Good/ })).toBeVisible({ timeout: 300 });
  }).toPass();
  await page.getByRole("button", { name: /^Good/ }).click();
  await expect(page.getByTestId("done-for-today")).toBeVisible();

  // The dropped phrase isn't in Up next or waiting for Learn more.
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^Learn \d+ more/ })).toHaveCount(0);
});
