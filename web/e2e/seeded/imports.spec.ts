import { expect, test } from "@playwright/test";

// Imports › Older extractions (DESIGN §4.6.1), on the seeded app: the newest import was read with
// a newer prompt, so the 4 questions of the older ones can be re-run. Re-running only queues jobs
// (no worker runs here), so the rest of the seeded data is unchanged.

test("Re-run queues the questions read with an older prompt, once", async ({ page }) => {
  await page.goto("/imports");
  const section = page.getByTestId("reextract");
  await expect(section).toContainText("4 questions were read with an older prompt");

  await section.getByRole("button", { name: "Re-run" }).click();
  await expect(page.getByTestId("reextracting")).toContainText("Re-reading 4 questions");
  await expect(page.getByTestId("reextract")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("reextracting")).toContainText("Re-reading 4 questions");
});
