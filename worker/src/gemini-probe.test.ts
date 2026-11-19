// The Gemini probe (H7) against a fake Gemini: synthetic input only, outcomes without replies.
import { sharedConfig } from "@bamboo/shared";
import { describe, expect, it } from "vitest";
import { GeminiClient } from "./gemini";
import { runProbe, syntheticTurn, withoutLimits } from "./gemini-probe";
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
  it("sends five synthetic requests and reports pass/fail without replies", async () => {
    const fake = new FakeGemini();
    fake.replies = [
      '{"ok":true}',
      '{"pinyin":["wǒ"]}',
      '{"choices":[]}',
      {
        status: 400,
        error: {
          status: "INVALID_ARGUMENT",
          message: "Invalid value at 'generation_config.response_json_schema'",
        },
      },
      '{"turn_kind":"other","items":[]}',
    ];
    const r = await runProbe(client(fake), prompts());
    expect(r.map((x) => [x.name, x.ok])).toEqual([
      ["minimal", true],
      ["pinyin_reading", true],
      ["pinyin_referee", true],
      ["extract_turn", false],
      ["extract_turn_no_limits", true],
    ]);
    expect(r[0]!.outcome).toBe("ok (11 chars of JSON)");
    expect(r[3]).toMatchObject({ kind: "rejected" });
    expect(r[3]!.outcome).toContain("response_json_schema");
    // Only the synthetic fixture turn went out.
    const sent = JSON.stringify(fake.bodies[3]!.body);
    expect(sent).toContain(JSON.stringify(syntheticTurn().user_text).slice(1, -1));
  });

  it("a bad key fails every request", async () => {
    const fake = new FakeGemini();
    const r = await runProbe(client(fake, "wrong-key-123456"), prompts());
    expect(r).toHaveLength(5);
    expect(r.every((x) => !x.ok && x.outcome.includes("HTTP 400"))).toBe(true);
  });

  it("strips limits only", () => {
    expect(
      withoutLimits({
        type: "array",
        maxItems: 3,
        items: { type: "string", minLength: 1, enum: ["a"] },
      }),
    ).toEqual({ type: "array", items: { type: "string", enum: ["a"] } });
  });
});
