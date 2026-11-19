// The Gemini probe (H7) against a fake Gemini: synthetic input only, outcomes without replies.
import { sharedConfig } from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import { GeminiClient } from "./gemini";
import { UNSERVABLE_KEYWORDS } from "@bamboo/shared";
import { runProbe, syntheticTurn } from "./gemini-probe";
import { loadPrompt } from "./prompt";
import { RateLimiter } from "./rate-limit";
import { FakeGemini } from "./test-fakes";

const prompts = () => ({
  extract: loadPrompt(),
  reading: loadPrompt("pinyin_reading"),
  referee: loadPrompt("pinyin_referee"),
});

function client(fake: FakeGemini, key = fake.key) {
  return new GeminiClient(
    "gemini-test",
    key,
    new RateLimiter({
      requestsPerMinute: 100,
      requestsPerDay: 100,
      timeZone: sharedConfig.worker.gemini.quotaTimeZone,
    }),
    { apiUrl: "https://gemini.test/v1beta", fetchFn: fake.fetch, sleep: async () => {} },
  );
}

describe("gemini probe", () => {
  it("sends four synthetic requests and reports pass/fail without replies", async () => {
    const fake = new FakeGemini();
    fake.replies = [
      '{"ok":true}',
      '{"pinyin":["wǒ"]}',
      {
        status: 400,
        error: {
          status: "INVALID_ARGUMENT",
          message:
            "The specified schema produces a constraint that has too many states for serving.",
        },
      },
      '{"turn_kind":"other","items":[]}',
    ];
    const r = await runProbe(client(fake), prompts());
    expect(r.map((x) => [x.name, x.ok])).toEqual([
      ["minimal", true],
      ["pinyin_reading", true],
      ["pinyin_referee", false],
      ["extract_turn", true],
    ]);
    expect(r[0]!.outcome).toBe("ok (11 chars of JSON)");
    expect(r[2]).toMatchObject({ kind: "rejected" });
    expect(r[2]!.outcome).toContain("too many states for serving");
    // Only the synthetic fixture turn went out.
    const sent = JSON.stringify(fake.bodies[3]!.body);
    // No schema reaches Gemini with a limit it can't serve (H7's 400): all four, referee included.
    expect(fake.bodies).toHaveLength(4);
    for (const b of fake.bodies) {
      const schema = JSON.stringify(
        (b.body.generationConfig as { responseJsonSchema: unknown }).responseJsonSchema,
      );
      for (const k of UNSERVABLE_KEYWORDS) expect(schema).not.toContain(`"${k}"`);
    }
    expect(sent).toContain(JSON.stringify(syntheticTurn().user_text).slice(1, -1));
  });

  it("a bad key fails every request", async () => {
    const fake = new FakeGemini();
    const r = await runProbe(client(fake, "wrong-key-123456"), prompts());
    expect(r).toHaveLength(4);
    expect(r.every((x) => !x.ok && x.outcome.includes("HTTP 400"))).toBe(true);
  });
});
