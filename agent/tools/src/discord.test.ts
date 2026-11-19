import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inForum, parseChannelInfo, type Discord } from "./discord";

// Shaped like `openclaw message channel info --json` for a forum post (synthetic ids).
const info = (parent: string | null) =>
  JSON.stringify({
    action: "channel-info",
    channel: "discord",
    payload: { ok: true, channel: { id: "3", type: 11, parent_id: parent, name: "x" } },
  });

describe("parseChannelInfo", () => {
  it("reads the parent id, past anything printed before the JSON", () => {
    expect(parseChannelInfo(info("1"))).toBe("1");
    expect(parseChannelInfo(`note: warming up\n${info("1")}`)).toBe("1");
    expect(parseChannelInfo(info(null))).toBeNull();
  });

  it("refuses output it doesn't understand", () => {
    expect(() => parseChannelInfo("")).toThrow(/no JSON/u);
    expect(() => parseChannelInfo('{"payload":{"ok":false}}')).toThrow(/unexpected/u);
  });
});

describe("inForum", () => {
  const discord = (parents: Record<string, string>, asked: string[]): Discord => ({
    async parentOf(id) {
      asked.push(id);
      return parents[id] ?? null;
    },
    async reply() {},
  });

  it("knows the forum and its posts, and asks Discord once per post", async () => {
    const env = { HOME: mkdtempSync(join(tmpdir(), "bamboo-discord-")) };
    const asked: string[] = [];
    const d = discord({ "3": "1", "4": "2" }, asked);
    expect(await inForum(env, d, "1", "1")).toBe(true);
    expect(await inForum(env, d, "1", "3")).toBe(true);
    expect(await inForum(env, d, "1", "3")).toBe(true);
    expect(await inForum(env, d, "1", "4")).toBe(false);
    expect(await inForum(env, d, "1", "4")).toBe(false);
    expect(asked).toEqual(["3", "4", "4"]);
  });
});
