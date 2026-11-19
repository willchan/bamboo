import { describe, expect, it } from "vitest";
import { PHRASE_TAGS } from "@bamboo/shared";
import { RESULT_SCHEMA, checkReply, extractTurn } from "./extract";
import { OllamaClient, OllamaError, modelParams } from "./ollama";
import { loadPrompt } from "./prompt";
import { FakeOllama, fixtureTurns, ollamaFixtures as F } from "./test-fakes";

const prompt = loadPrompt();
const turn = fixtureTurns[0]!;
const VALID = F.chat_valid.message.content;
const INVALID = F.chat_invalid_english_too_long.message.content;
const NOT_JSON = F.chat_not_json.message.content;

function setup(...replies: string[]) {
  const fake = new FakeOllama();
  fake.replies = replies;
  const client = new OllamaClient("http://ollama.test", "qwen3.5:9b", fake.fetch);
  return { fake, client };
}

describe("OllamaClient", () => {
  it("finds a pulled model in the recorded /api/tags", async () => {
    const fetchTags: typeof fetch = async () => Response.json(F.tags);
    expect(await new OllamaClient("http://o", "qwen3.5:9b", fetchTags).hasModel()).toBe(true);
    expect(await new OllamaClient("http://o", "qwen3.8:27b", fetchTags).hasModel()).toBe(false);
    // A name without a tag means :latest.
    expect(await new OllamaClient("http://o", "qwen3.5", fetchTags).hasModel()).toBe(false);
  });

  // The 27B is the host's shared reply model: asking for another num_ctx would reload it, and a
  // shorter keep_alive would unload it early for OpenClaw (DESIGN §10 #70).
  it("asks for the host's num_ctx and keep_alive per model, the default for others", async () => {
    const fake = new FakeOllama();
    fake.replies = [VALID, VALID, VALID];
    for (const m of ["qwen3.8:27b", "qwen3.5:9b", "other:1b"])
      await new OllamaClient("http://ollama.test", m, fake.fetch).chat([
        { role: "user", content: "x" },
      ]);
    expect(fake.chatBodies.map((b) => [b.model, b.options, b.keep_alive])).toEqual([
      ["qwen3.8:27b", { temperature: 0, num_ctx: 32768 }, "30m"],
      ["qwen3.5:9b", { temperature: 0, num_ctx: 8192 }, "2m"],
      ["other:1b", { temperature: 0, num_ctx: 8192 }, "2m"],
    ]);
    expect(modelParams("other:1b")).toEqual(modelParams("default"));
  });

  it("throws OllamaError when Ollama is down or answers an error", async () => {
    const { fake, client } = setup();
    fake.down = true;
    await expect(client.hasModel()).rejects.toBeInstanceOf(OllamaError);
    fake.down = false;
    await expect(client.chat([{ role: "user", content: "x" }])).rejects.toThrow(/HTTP 500/u);
  });

  it("sends DESIGN §1.2's request: format schema, think off, temperature 0, num_ctx, keep_alive", async () => {
    const { fake, client } = setup(VALID);
    await client.chat([{ role: "user", content: "x" }]);
    const body = fake.chatBodies[0]!;
    expect(body).toMatchObject({
      model: "qwen3.5:9b",
      stream: false,
      think: false,
      keep_alive: "2m",
      options: { temperature: 0, num_ctx: 8192 },
    });
    expect(body.format).toEqual(RESULT_SCHEMA);
    // The model can only pick tags from the fixed list.
    const tags = (RESULT_SCHEMA.properties as Record<string, unknown>).items as {
      items: { properties: { tags: unknown } };
    };
    expect(tags.items.properties.tags).toMatchObject({
      items: { enum: [...PHRASE_TAGS] },
      maxItems: 3,
    });
    expect(RESULT_SCHEMA).toMatchObject({ type: "object", required: ["turn_kind", "items"] });
    // v2: no addressee; the model always answers `note` (DESIGN §10 #63). v4: no frames, pinyin
    // and a breakdown on every item.
    const items = (RESULT_SCHEMA.properties as Record<string, { items: Record<string, unknown> }>)
      .items!.items;
    expect(items.properties).not.toHaveProperty("addressee");
    expect(items.required).toEqual(
      expect.arrayContaining(["note", "pinyin", "breakdown", "examples"]),
    );
    expect((items.properties as Record<string, unknown>).kind).toMatchObject({
      enum: ["term", "sentence"],
    });
  });
});

describe("checkReply (v4 → the API's contract)", () => {
  it("maps examples, the breakdown's summary, and keeps or drops pinyin", () => {
    const r = checkReply(VALID);
    if (!r.ok) throw new Error(r.errors);
    expect(r.result.items[0]).toMatchObject({
      example: { hanzi: "用高压锅煮汤，二十分钟就好了。" },
      examples: [{ hanzi: "用高压锅煮汤，二十分钟就好了。" }],
      pinyin: ["gāo", "yā", "guō"],
      breakdown: { meaning: "A high-pressure pot." },
    });
    const fallback = checkReply(VALID, { keepPinyin: false });
    expect(fallback.ok && fallback.result.items[0]!.pinyin).toBeNull();
  });

  it("accepts a valid result and explains an invalid one by path", () => {
    expect(checkReply(VALID).ok).toBe(true);
    const bad = checkReply(INVALID);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toContain("items.0.english");
      // An out-of-range rating is clamped (trimToCaps, H7), not an error.
      expect(bad.errors).not.toContain("items.0.usefulness");
    }
    const notJson = checkReply(NOT_JSON);
    expect(!notJson.ok && notJson.errors).toMatch(/not valid JSON/u);
  });
});

describe("extractTurn (recorded fake responses)", () => {
  it("valid on the first reply: no repair", async () => {
    const { fake, client } = setup(VALID);
    const x = await extractTurn(client, prompt, turn);
    expect(x).toMatchObject({ ok: true, repaired: false });
    expect(x.ok && x.result.items[0]!.hanzi).toBe("高压锅");
    expect(fake.chatBodies).toHaveLength(1);
    const [system, user] = fake.chatBodies[0]!.messages;
    expect(system).toEqual({ role: "system", content: prompt.system });
    expect(user!.role).toBe("user");
    expect(user!.content).toContain(turn.user_text);
    expect(user!.content).toContain("Talking with the yuesao");
  });

  it("invalid, then repaired: one repair turn with the bad reply and the errors", async () => {
    const { fake, client } = setup(INVALID, VALID);
    const x = await extractTurn(client, prompt, turn);
    expect(x).toMatchObject({ ok: true, repaired: true });
    expect(fake.chatBodies).toHaveLength(2);
    const msgs = fake.chatBodies[1]!.messages;
    expect(msgs).toHaveLength(4);
    expect(msgs[2]).toEqual({ role: "assistant", content: INVALID });
    expect(msgs[3]!.role).toBe("user");
    expect(msgs[3]!.content).toContain("items.0.english");
    expect(msgs[3]!.content).not.toContain("{{errors}}");
  });

  it("invalid twice: the attempt fails, without a third call", async () => {
    const { fake, client } = setup(NOT_JSON, INVALID, VALID);
    const x = await extractTurn(client, prompt, turn);
    expect(x).toMatchObject({ ok: false, repaired: true });
    expect(!x.ok && x.modelError).toBeUndefined();
    expect(!x.ok && x.error).toMatch(/invalid output after the repair turn/u);
    expect(fake.chatBodies).toHaveLength(2);
  });

  it("Ollama failing mid-job fails the attempt and says Ollama is down", async () => {
    const { fake, client } = setup();
    fake.down = true;
    const x = await extractTurn(client, prompt, turn);
    expect(x).toMatchObject({ ok: false, repaired: false });
    expect(!x.ok && x.modelError).toBeInstanceOf(OllamaError);
  });

  it("measures latency with the given clock", async () => {
    const { client } = setup(VALID);
    let t = 1000;
    const x = await extractTurn(client, prompt, turn, () => (t += 750));
    expect(x.latencyMs).toBe(750);
  });
});
