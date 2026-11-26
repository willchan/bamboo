import { expect, test, type Page } from "@playwright/test";

// PLAN T2 (DESIGN §6.1): a card plays its neural clip from /api/tts (Azure stubbed by
// e2e/tts-stub.mjs), and falls back to Web Speech when the clip fails. Each test is a fresh page,
// so the client's fallback cooldown doesn't carry over. Runs after the other phone specs: their
// cap is used up, so the new phrase comes from Learn more.

async function record(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __played: string[]; __spoken: string[] };
    w.__played = [];
    w.__spoken = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (!this.src.startsWith("data:")) w.__played.push(new URL(this.src).pathname);
      return play.call(this);
    };
    if ("speechSynthesis" in window) {
      const speak = speechSynthesis.speak.bind(speechSynthesis);
      speechSynthesis.speak = (u) => {
        if (u.text.trim()) w.__spoken.push(u.text);
        speak(u);
      };
    }
  });
}

const played = (page: Page) =>
  page.evaluate(() => (window as never as { __played: string[] }).__played);
const spoken = (page: Page) =>
  page.evaluate(() => (window as never as { __spoken: string[] }).__spoken);

async function addAndStart(page: Page, hanzi: string, english: string) {
  await page.goto("/phrases/new");
  await page.getByRole("radio", { name: "sentence" }).check({ force: true });
  await page.getByLabel("Chinese", { exact: true }).fill(hanzi);
  await page.getByLabel("English intent", { exact: true }).fill(english);
  await page.getByRole("button", { name: "Add phrase" }).click();
  await expect(page.getByTestId("saved")).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: /^Learn \d+ more/ }).click();
  await expect(page.getByTestId("card-front")).toHaveText(english);
}

async function finish(page: Page) {
  await page.getByRole("button", { name: /^Good/ }).click();
  await expect(page.getByTestId("done-for-today")).toBeVisible();
}

test("a card plays its neural clip", async ({ page }) => {
  await record(page);
  await addAndStart(page, "穿鞋子。", "Put on your shoes.");
  const clip = page.waitForResponse((r) => r.url().includes("/api/tts/"));
  await page.getByRole("button", { name: "Show", exact: true }).click();
  const res = await clip;
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("audio/mpeg");
  expect(res.url()).toMatch(/\/phrase\?v=[0-9a-f]{16}$/u);
  await expect.poll(() => played(page)).toEqual([expect.stringMatching(/\/phrase$/u)]);
  // Slow replays the same clip (playbackRate), not a second synthesis.
  await page.getByRole("button", { name: "Slow replay" }).click();
  await expect.poll(async () => (await played(page)).length).toBe(2);
  expect(await spoken(page)).toEqual([]);
  await finish(page);
});

test("a failed clip falls back to the device voice", async ({ page }) => {
  await record(page);
  await addAndStart(page, "戴帽子。", "Put on your hat.");
  const clip = page.waitForResponse((r) => r.url().includes("/api/tts/"));
  await page.getByRole("button", { name: "Show", exact: true }).click();
  expect((await clip).status()).toBe(502);
  await expect.poll(() => spoken(page)).toEqual(["戴帽子。"]);
  await finish(page);
});
