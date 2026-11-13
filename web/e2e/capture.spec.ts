import { expect, test } from "@playwright/test";

// PLAN M3: paste an answer → a fake worker completes its job through the API with a canned
// ExtractTurnResult → its phrases top Up next. The model returned only a term for this "how do I
// say" answer, so the term's example becomes its sentence (DESIGN §4.6, §10 #67). Synthetic text.
const WORKER = { authorization: "Bearer e2e-worker-token" };

const ANSWER = "你可以说：\n高压锅\n例如：用高压锅煮二十分钟就好了。";

test("paste an answer, the worker extracts it, its phrases top Up next", async ({
  page,
  request,
}) => {
  await page.goto("/imports");
  await page.getByLabel("Paste a Gemini answer").fill(ANSWER);
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("paste-result")).toContainText("Got it");
  await expect(page.getByTestId("imports")).toContainText("processing on the Mac");

  // Nothing heartbeats in e2e, so Today says the worker is offline.
  await page.getByRole("link", { name: "Today" }).click();
  await expect(page.getByTestId("worker-offline")).toContainText("1 question waiting");

  // The fake worker: claim, then complete with a canned result.
  const claim = await request.post("/api/jobs/claim", { headers: WORKER });
  expect(claim.status()).toBe(200);
  const job = (await claim.json()) as {
    job_id: string;
    attempt: number;
    input: { reply_text: string };
  };
  expect(job.input.reply_text).toContain("高压锅");
  const complete = await request.post("/api/jobs/complete", {
    headers: WORKER,
    data: {
      job_id: job.job_id,
      attempt: job.attempt,
      status: "done",
      model: "fake",
      prompt_version: "extract_turn.v1",
      result: {
        turn_kind: "say",
        items: [
          {
            kind: "term",
            hanzi: "高压锅",
            english: "pressure cooker",
            note: null,
            heard_as: null,
            example: { hanzi: "用高压锅煮二十分钟就好了。", english: "Twenty minutes in it." },
            usefulness: 5,
            tags: ["food"],
          },
        ],
      },
    },
  });
  expect(complete.status()).toBe(200);
  expect(await complete.json()).toEqual({ job_status: "done" });
  expect((await request.post("/api/jobs/claim", { headers: WORKER })).status()).toBe(204);

  await page.getByRole("link", { name: "Up next" }).click();
  const rows = page.getByTestId("queue").locator("li");
  await expect(rows).toHaveCount(2);
  // The sentence (a say turn's point) first, then the term.
  await expect(rows.nth(0)).toContainText("用高压锅煮二十分钟就好了。");
  await expect(rows.nth(0)).toContainText("Twenty minutes in it.");
  await expect(rows.nth(1)).toContainText("高压锅");
  await expect(rows.nth(1)).toContainText("pressure cooker");

  await page.getByRole("link", { name: "Imports" }).click();
  await expect(page.getByTestId("imports")).toContainText("2 phrases queued");

  // Leave the database as the review test expects it: nothing queued.
  await page.getByRole("link", { name: "Up next" }).click();
  for (const n of [2, 1]) {
    await expect(rows).toHaveCount(n);
    await rows.first().getByRole("button", { name: "Remove" }).click();
  }
  await expect(page.getByText("The queue is empty.")).toBeVisible();
});
