import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { turnKey } from "./turns";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("turnKey", () => {
  it("keys link and PDF turns on Will's words only", () => {
    const a = turnKey({ user_text: "How do I say 'bath time'?", reply_text: "洗澡时间" }, "link");
    const b = turnKey({ user_text: "How do I say  'bath time'", reply_text: "该洗澡了！" }, "pdf");
    expect(a).toBe(b);
    expect(a).toBe(sha("howdoisaybathtime"));
  });

  it("normalizes radicals and punctuation before hashing", () => {
    expect(turnKey({ user_text: "⽤⾼压锅？", reply_text: "x" }, "pdf")).toBe(
      turnKey({ user_text: "用高压锅", reply_text: "y" }, "link"),
    );
  });

  it("keys text imports on prompt and reply", () => {
    const k = turnKey({ user_text: "", reply_text: "你可以说：高压锅。" }, "text");
    expect(k).toBe(sha("\n你可以说高压锅"));
    expect(turnKey({ user_text: null, reply_text: "你可以说：高压锅。" }, "text")).toBe(k);
    expect(turnKey({ user_text: "hi", reply_text: "你可以说：高压锅。" }, "text")).toBe(
      sha("hi\n你可以说高压锅"),
    );
  });

  it("keys an image-only prompt (empty) on its reply, so two such turns differ", () => {
    const one = turnKey({ user_text: "", reply_text: "这是高压锅。" }, "link");
    const two = turnKey({ user_text: "", reply_text: "这是奶瓶。" }, "link");
    expect(one).not.toBe(two);
    // Same as a text import of that reply, and the PDF agrees with the link.
    expect(one).toBe(turnKey({ user_text: "", reply_text: "这是高压锅。" }, "text"));
    expect(turnKey({ user_text: "  ", reply_text: "这是高压锅" }, "pdf")).toBe(one);
    // Punctuation alone is still an empty prompt.
    expect(turnKey({ user_text: "？", reply_text: "这是奶瓶。" }, "link")).toBe(two);
  });
});
