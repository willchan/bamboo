// Pure capture rules (DESIGN §4.6–4.7, §5.1, §5.3). The routes test covers them end to end.
import { describe, expect, it } from "vitest";
import { importSummary, PUBLIC_LINK_NOTE, workerStatus, type NextUpPhrase } from "./imports";
import { computePinyin, overrideFromEdits } from "./pinyin";
import { isLeaseExpired, isStaleAttempt, leaseExpiresAt, statusAfterFailure } from "./jobs";
import {
  expiredPhraseIds,
  mergeExamples,
  occursVerbatim,
  planMerge,
  turnTextKey,
  validateExtraction,
  type ExistingPhrase,
} from "./queue";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("occursVerbatim", () => {
  const key = turnTextKey({ userText: "q", replyText: "阿姨，您是说要加水吗？用高压锅。" });

  it("needs Chinese, copied from the turn", () => {
    expect(occursVerbatim("高压锅", "term", key)).toBe(true);
    expect(occursVerbatim("高 压 锅！", "term", key)).toBe(true);
    expect(occursVerbatim("电饭煲", "term", key)).toBe(false);
    expect(occursVerbatim("pressure", "term", key)).toBe(false);
  });

  it("lets a frame's slot (… or ...) stand for anything, in order", () => {
    expect(occursVerbatim("阿姨，您是说…吗？", "frame", key)).toBe(true);
    expect(occursVerbatim("您是说...吗", "frame", key)).toBe(true);
    expect(occursVerbatim("吗…您是说", "frame", key)).toBe(false);
    // Only frames get the slot: a sentence with … must match whole.
    expect(occursVerbatim("您是说…吗", "sentence", key)).toBe(false);
    expect(occursVerbatim("…", "frame", key)).toBe(false);
  });
});

describe("validateExtraction", () => {
  const item = {
    kind: "sentence" as const,
    hanzi: "该洗澡了",
    english: " Bath time ",
    addressee: " toddler ",
    heard_as: "",
    example: { hanzi: "该洗澡了", english: null },
    usefulness: 4,
    tags: [" Baby ", "baby", ""],
  };

  it("cleans fields and ignores examples on non-terms", () => {
    const v = validateExtraction(
      { userText: "how do I say bath time", replyText: "该洗澡了！" },
      { turn_kind: "say", items: [item] },
    );
    expect(v.items).toEqual([
      {
        kind: "sentence",
        hanzi: "该洗澡了",
        hanziKey: "该洗澡了",
        english: "Bath time",
        addressee: "toddler",
        heardAs: null,
        example: null,
        usefulness: 4,
        tags: ["baby"],
        flags: [],
      },
    ]);
  });

  it("matches heard_as ignoring case and spaces", () => {
    const v = validateExtraction(
      { userText: "she said Gao Ya Guo", replyText: "高压锅" },
      {
        turn_kind: "decode",
        items: [{ ...item, kind: "term", hanzi: "高压锅", heard_as: "gaoyaguo", example: null }],
      },
    );
    expect(v.items[0]!.heardAs).toBe("gaoyaguo");
    expect(v.heardAsDropped).toBe(0);
  });
});

describe("mergeExamples", () => {
  const ex = (hanzi: string) => ({ hanzi, english: null, turn_id: null });
  it("appends unless the key is there, keeping at most 3", () => {
    expect(mergeExamples([ex("一")], ex("一！"))).toEqual([ex("一")]);
    expect(mergeExamples([ex("一")], null)).toEqual([ex("一")]);
    expect(mergeExamples([ex("一"), ex("二"), ex("三")], ex("四"))).toHaveLength(3);
    expect(mergeExamples([ex("一")], ex("二"), 5)).toHaveLength(2);
  });
});

describe("planMerge", () => {
  const p: ExistingPhrase = {
    status: "queued",
    kind: "frame",
    hanziKey: "您是说吗",
    introducedAt: null,
    askedCount: 1,
    lastAskedImportId: "i0",
    heardAs: null,
    examples: [],
    usefulness: 3,
    turnKind: "say",
    tags: [],
    flags: ["long"],
  };
  const item = {
    heardAs: null,
    example: { hanzi: "x", english: null },
    flags: ["example_dropped"],
  };
  const ctx = { importId: "i1", turnId: "t1", now: 5 };

  it("bumps once per import and re-scores", () => {
    const plan = planMerge(p, item, ctx);
    expect(plan).toMatchObject({ bumped: true, revived: false, askedAgain: false });
    expect(plan.patch).toMatchObject({ askedCount: 2, lastAskedAt: 5, lastAskedImportId: "i1" });
    expect(plan.patch.baseScore).toBe(3 + 1 + 3);
    // Frames keep no examples; `long` is recomputed (this key is short).
    expect(plan.patch.examples).toEqual([]);
    expect(plan.patch.flags).toEqual(["example_dropped"]);

    const same = planMerge({ ...p, lastAskedImportId: "i1" }, item, ctx);
    expect(same.bumped).toBe(false);
    expect(same.patch.askedCount).toBe(1);
    expect(same.patch).not.toHaveProperty("lastAskedAt");
  });

  it("revives expired phrases: queued if never introduced, active (asked again) if they were", () => {
    expect(planMerge({ ...p, status: "expired" }, item, ctx)).toMatchObject({
      revived: true,
      askedAgain: false,
      patch: { status: "queued", droppedAt: null },
    });
    expect(planMerge({ ...p, status: "dropped", introducedAt: 1 }, item, ctx)).toMatchObject({
      revived: true,
      askedAgain: true,
      patch: { status: "active" },
    });
    // Not twice in one import.
    expect(
      planMerge({ ...p, status: "dropped", lastAskedImportId: "i1" }, item, ctx).patch.status,
    ).toBe("dropped");
  });

  it("flags long phrases", () => {
    const long = planMerge({ ...p, hanziKey: "一".repeat(25), flags: [] }, item, ctx);
    expect(long.patch.flags).toContain("long");
  });
});

describe("expiredPhraseIds", () => {
  const base = {
    id: "a",
    status: "queued" as const,
    pinned: false,
    baseScore: -3,
    lastAskedAt: 0,
    createdAt: 0,
  };
  it("expires old, low, unpinned queued phrases only", () => {
    const now = 31 * DAY;
    expect(expiredPhraseIds([base], now)).toEqual(["a"]);
    expect(expiredPhraseIds([base], 29 * DAY)).toEqual([]);
    expect(expiredPhraseIds([{ ...base, pinned: true }], now)).toEqual([]);
    expect(expiredPhraseIds([{ ...base, status: "active" }], now)).toEqual([]);
    expect(expiredPhraseIds([{ ...base, baseScore: 5 }], now)).toEqual([]);
  });
});

describe("jobs", () => {
  it("leases, staleness, retries", () => {
    expect(leaseExpiresAt(0)).toBe(10 * MIN);
    expect(isStaleAttempt({ status: "leased", attempt: 2 }, 2)).toBe(false);
    expect(isStaleAttempt({ status: "leased", attempt: 2 }, 1)).toBe(true);
    expect(isStaleAttempt({ status: "queued", attempt: 2 }, 2)).toBe(true);
    expect(statusAfterFailure(2)).toBe("queued");
    expect(statusAfterFailure(3)).toBe("failed");
    expect(isLeaseExpired({ status: "leased", leaseExpiresAt: 5 }, 5)).toBe(true);
    expect(isLeaseExpired({ status: "leased", leaseExpiresAt: 6 }, 5)).toBe(false);
    expect(isLeaseExpired({ status: "queued", leaseExpiresAt: null }, 5)).toBe(false);
  });
});

describe("importSummary", () => {
  /** A synthetic phrase as stored: computed pinyin, no override. */
  const phrase = (hanzi: string, english: string): NextUpPhrase => ({
    hanzi,
    english,
    pinyin: computePinyin(hanzi),
    pinyinOverride: null,
  });
  const s = {
    kind: "pdf" as const,
    turnsNew: 1,
    phrasesNew: 1,
    phrasesAgain: 2,
    jobsFailed: 2,
    nextUp: [phrase("高压锅", "pressure cooker")],
  };
  it("reads naturally in the singular and plural", () => {
    expect(importSummary(s)).toBe(
      "✅ 1 new question → 1 phrase queued. Next up: 高压锅 gāo yā guō (pressure cooker).\n" +
        "🔁 2 phrases you'd asked about before are back in rotation.\n" +
        "⚠️ 2 questions couldn't be processed; Retry failed on the Imports page.",
    );
    expect(importSummary({ ...s, phrasesNew: 0, phrasesAgain: 0, jobsFailed: 0, nextUp: [] })).toBe(
      "✅ 1 new question → no new phrases.",
    );
    expect(
      importSummary({
        ...s,
        kind: "link",
        turnsNew: 0,
        phrasesAgain: 0,
        jobsFailed: 0,
        nextUp: [],
      }),
    ).toBe(`✅ Nothing new since last time.\n${PUBLIC_LINK_NOTE}`);
  });

  // Regression: Next up listed hanzi with English only, which Will can't read for new words.
  it("gives the pinyin of every phrase it lists", () => {
    const nextUp = [
      phrase("使劲", "straining"),
      phrase("拍嗝", "burp the baby"),
      phrase("别着急，慢慢来", "no rush, take your time"),
    ];
    const text = importSummary({ ...s, phrasesNew: 3, nextUp });
    for (const [p, py] of [
      [nextUp[0]!, "shǐ jìn"],
      [nextUp[1]!, "pāi gé"],
      [nextUp[2]!, "bié zháo jí màn màn lái"],
    ] as const) {
      expect(text).toContain(`${p.hanzi} ${py} (${p.english})`);
    }
    expect(text).toContain(
      "Next up: 使劲 shǐ jìn (straining), 拍嗝 pāi gé (burp the baby), 别着急，慢慢来",
    );
  });

  it("shows Will's pinyin overrides, as the PWA does", () => {
    const computed = computePinyin("我得走");
    const override = overrideFromEdits(computed, [null, "dé", null]);
    const text = importSummary({
      ...s,
      nextUp: [
        { hanzi: "我得走", english: "I have to go", pinyin: computed, pinyinOverride: override },
      ],
    });
    expect(text).toContain("我得走 wǒ dé zǒu (I have to go)");
  });

  it("keeps a frame's slot as … in both the hanzi and the pinyin", () => {
    const text = importSummary({ ...s, nextUp: [phrase("阿姨，您是说…吗？", "Do you mean …?")] });
    expect(text).toContain("阿姨，您是说…吗？ ā yí nín shì shuō … ma (Do you mean …?)");
  });

  it("names fewer Next-up phrases rather than pass Discord's limit or drop pinyin", () => {
    const nextUp = [phrase("高压锅", "pressure cooker"), phrase("泡打粉", "baking powder")];
    const full = importSummary({ ...s, nextUp });
    expect(full).toContain("泡打粉 pào dǎ fěn (baking powder)");
    const trimmed = importSummary({ ...s, nextUp }, full.length - 1);
    expect(trimmed).toContain("Next up: 高压锅 gāo yā guō (pressure cooker).");
    expect(trimmed).not.toContain("泡打粉");
    expect(trimmed.length).toBeLessThan(full.length);
    const none = importSummary({ ...s, nextUp }, 10);
    expect(none).not.toContain("Next up");
    expect(none.startsWith("✅ 1 new question → 1 phrase queued.\n")).toBe(true);
  });

  it("stays within Discord's 2000 characters with long phrases at the default count", () => {
    const long = "我们今天晚上先把宝宝的奶瓶洗干净然后再用开水烫一下".repeat(4);
    const nextUp = [0, 1, 2].map(() => phrase(long, "x".repeat(120)));
    const text = importSummary({ ...s, kind: "link", nextUp });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain(
      `${long} ${computePinyin(long)
        .map(([, p]) => p)
        .join(" ")}`,
    );
  });
});

describe("workerStatus", () => {
  it("is quiet with nothing waiting, else online or offline by the last heartbeat", () => {
    expect(workerStatus(0, null, 0)).toEqual({ kind: "idle" });
    expect(workerStatus(2, 0, 10 * MIN)).toEqual({ kind: "online", waiting: 2 });
    expect(workerStatus(2, 0, 30 * MIN)).toEqual({ kind: "offline", waiting: 2, lastSeenAt: 0 });
    expect(workerStatus(2, null, 0)).toEqual({ kind: "offline", waiting: 2, lastSeenAt: null });
  });
});
