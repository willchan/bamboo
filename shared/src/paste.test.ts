import { describe, expect, it } from "vitest";
import { routeText } from "./paste";

// Synthetic text only (CLAUDE.md › Privacy).
const answer = [
  "**Here are a few ways to say it:**",
  "",
  "1. 宝宝要睡觉了。 (Bǎobao yào shuìjiào le.) The baby is going to sleep.",
  "2. 我们去洗澡吧。 (Wǒmen qù xǐzǎo ba.) Let's go take a bath.",
  "3. 慢慢吃，不着急。 (Mànmàn chī, bù zháojí.) Eat slowly, no rush.",
  "",
  "**Tip:** 了 here marks a change of state; you can drop it in casual speech, and the tone of",
  "the sentence softens with 吧 at the end. Both are very common when talking to toddlers.",
].join("\n");

describe("routeText (pasted answer or question)", () => {
  it("routes a long, multi-line answer with Chinese to paste", () => {
    expect(answer.length).toBeGreaterThan(300);
    expect(routeText(answer)).toEqual({ route: "paste", text: answer });
  });

  it("routes short questions to the tutor, with or without Chinese", () => {
    for (const q of [
      "How do I say pressure cooker?",
      "what does 慢慢来 mean",
      "阿姨说：宝宝今天吃得不多，晚上要不要加一顿奶？ what is she asking?",
    ])
      expect(routeText(q).route).toBe("question");
  });

  it("keeps a long question without Chinese a question", () => {
    const q = Array.from({ length: 6 }, (_, i) => `Line ${i}: how would I tell the nanny that…`)
      .join("\n")
      .repeat(3);
    expect(routeText(q).route).toBe("question");
  });

  it("keeps a long single-paragraph decode request a question (too few lines)", () => {
    const q = `What does this mean? ${"宝宝今天很乖，吃了很多饭。".repeat(40)}`;
    expect(q.length).toBeGreaterThan(300);
    expect(routeText(q).route).toBe("question");
  });

  it("honours the paste: and ask: markers, and removes them", () => {
    expect(routeText("paste: 高压锅 gāo yā guō")).toEqual({
      route: "paste",
      text: "高压锅 gāo yā guō",
    });
    expect(routeText("📋 高压锅").route).toBe("paste");
    expect(routeText("Pasted:\n高压锅").route).toBe("paste");
    expect(routeText(`ask: ${answer}`)).toEqual({ route: "question", text: answer });
    expect(routeText("ASK:what is 高压锅").text).toBe("what is 高压锅");
  });

  it("uses the configured thresholds", () => {
    expect(routeText("高压锅\n奶瓶", { minChars: 3, minLines: 2 }).route).toBe("paste");
    expect(routeText("高压锅 奶瓶", { minChars: 3, minLines: 2 }).route).toBe("question");
  });
});
