import { expect, test } from "@playwright/test";

// Imports › Older extractions (DESIGN §4.6.1), on the seeded app: the newest import was read with
// a newer prompt, so the 5 questions of the older ones (H5 added a tutor turn) can be re-run. Re-running only queues jobs
// (no worker runs here), so the rest of the seeded data is unchanged.

test("Re-run queues the questions read with an older prompt, once", async ({ page }) => {
  await page.goto("/imports");
  const section = page.getByTestId("reextract");
  await expect(section).toContainText("5 questions were read with an older prompt");

  await section.getByRole("button", { name: "Re-run" }).click();
  await expect(page.getByTestId("reextracting")).toContainText("Re-reading 5 questions");
  await expect(page.getByTestId("reextract")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("reextracting")).toContainText("Re-reading 5 questions");
});

// H6 (DESIGN §5.5.6): the seed has 2 learning phrases a re-run no longer picks. Imports links to
// them; Phrases › unpicked lists them with a bulk Retire, which drops them (history kept). It only
// changes those 2 phrases (both were due reviews; the Today tests don't count them).
test("Imports links to phrases a re-run no longer picks, and Retire drops them", async ({
  page,
}) => {
  await page.goto("/imports");
  await expect(page.getByTestId("unpicked")).toContainText("no longer picks 2 phrases");
  await page.getByRole("link", { name: "Review them" }).click();
  await page.waitForURL(/\/phrases\?unpicked=1/);

  const box = page.getByTestId("unpicked");
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("unpicked");
  await expect(page.getByText("The baby slept well.")).toBeVisible();
  await expect(page.getByText("Eat slowly, no rush.")).toBeVisible();
  await box.getByRole("button", { name: "Retire all 2" }).click();
  await expect(page.getByTestId("retired")).toContainText("Retired 2 phrases");

  await page.goto("/phrases?status=dropped");
  await expect(page.getByText("The baby slept well.")).toBeVisible();
  await page.goto("/phrases?unpicked=1");
  await expect(page.getByTestId("unpicked")).toHaveCount(0);
  await page.goto("/imports");
  await expect(page.getByTestId("unpicked")).toHaveCount(0);
});
