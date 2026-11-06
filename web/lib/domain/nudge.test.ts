import { describe, expect, it } from "vitest";
import { config } from "../config";
import { zonedTime } from "./day";
import {
  decideNudge,
  eveningMinutes,
  formatLocalTime,
  median,
  nudgeText,
  nudgeTime,
  practiceStarts,
  type NudgeInput,
} from "./nudge";
import type { Workload } from "./session";

const TZ = "America/Los_Angeles";
const LA = { timeZone: TZ };
const MIN = 60_000;

/** June `day`, 2026, at local `hh:mm` in Los Angeles (`hh` may be 24+ for after midnight). */
const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return zonedTime(2026, 6, day + Math.floor(h / 24), h % 24, TZ) + m * MIN;
};

const work = (o: Partial<Workload> = {}): Workload => ({
  due: 7,
  newAvailable: 2,
  roundCards: 9,
  ...o,
});

const input = (o: Partial<NudgeInput> = {}): NudgeInput => ({
  now: at(20, "21:00"),
  enabled: true,
  lastSentDay: null,
  finishedRoundToday: false,
  workload: work(),
  roundStarts: [],
  appUrl: "https://bamboo.example.test",
  ...o,
});

describe("eveningMinutes and the 04:00 day boundary", () => {
  it("counts after-midnight times as late evening of the day before", () => {
    expect(eveningMinutes(at(20, "21:30"), LA)).toBe(21 * 60 + 30);
    expect(eveningMinutes(at(20, "24:30"), LA)).toBe(24 * 60 + 30);
    expect(eveningMinutes(at(21, "04:00"), LA)).toBe(4 * 60);
    expect(eveningMinutes(at(21, "03:59"), LA)).toBe(27 * 60 + 59);
  });

  it("formats local times", () => {
    expect(formatLocalTime(21 * 60)).toBe("21:00");
    expect(formatLocalTime(18 * 60 + 5)).toBe("18:05");
  });
});

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("nudgeTime", () => {
  const now = at(20, "17:00");

  it("is 21:00 until there are 5 practice days in the last 14", () => {
    const four = [16, 17, 18, 19].map((d) => at(d, "20:00"));
    expect(nudgeTime(now, four, LA)).toBe(config.nudge.defaultLocalTime);
    expect(nudgeTime(now, [], LA)).toBe(21 * 60);
  });

  it("is the median start minus 15 minutes once there are 5", () => {
    const starts = [
      at(15, "20:00"),
      at(16, "20:10"),
      at(17, "20:40"),
      at(18, "19:50"),
      at(19, "21:30"),
    ];
    expect(nudgeTime(now, starts, LA)).toBe(20 * 60 + 10 - 15);
  });

  it("counts each day once, by its first round", () => {
    const starts = [15, 16, 17, 18, 19].map((d) => at(d, "20:00"));
    // Extra rounds late on two days don't move the median.
    const extra = [at(18, "23:00"), at(18, "23:30"), at(19, "23:10")];
    expect(nudgeTime(now, [...starts, ...extra], LA)).toBe(20 * 60 - 15);
    // Four days plus extra rounds on one of them are still four days.
    expect(nudgeTime(now, [...starts.slice(1), ...extra], LA)).toBe(21 * 60);
  });

  it("ignores rounds from today and from before the 14-day window", () => {
    const old = [1, 2, 3, 4, 5].map((d) => at(d, "19:00"));
    expect(nudgeTime(now, old, LA)).toBe(21 * 60);
    const today = [at(20, "05:00")];
    const recent = [16, 17, 18, 19].map((d) => at(d, "20:00"));
    expect(nudgeTime(now, [...recent, ...today], LA)).toBe(21 * 60);
    expect(practiceStarts(now, [...old, ...recent, ...today], LA)).toHaveLength(4);
  });

  it("treats after-midnight rounds as late evening (the 04:00 boundary)", () => {
    const starts = [15, 16, 17, 18, 19].map((d) => at(d, "24:20")); // 00:20 the next morning
    expect(practiceStarts(now, starts, LA)).toHaveLength(5);
    // Median 24:20 − 15 = 24:05, clamped to 23:00.
    expect(nudgeTime(now, starts, LA)).toBe(23 * 60);
  });

  it("clamps to 18:00–23:00", () => {
    const early = [15, 16, 17, 18, 19].map((d) => at(d, "07:30"));
    expect(nudgeTime(now, early, LA)).toBe(18 * 60);
    const late = [15, 16, 17, 18, 19].map((d) => at(d, "23:40"));
    expect(nudgeTime(now, late, LA)).toBe(23 * 60);
  });

  it("takes its numbers from config", () => {
    const starts = [17, 18, 19].map((d) => at(d, "20:00"));
    const nudge = { ...config.nudge, minRounds: 3, leadMinutes: 30 };
    expect(nudgeTime(now, starts, { ...LA, nudge })).toBe(19 * 60 + 30);
  });
});

describe("nudgeText", () => {
  it("says how long the round takes and what's in it", () => {
    expect(nudgeText(work({ roundCards: 10 }), "https://b.test")).toBe(
      "📚 1 round · ~3 min · 7 due · 2 new → https://b.test",
    );
    expect(nudgeText(work({ due: 0, newAvailable: 3, roundCards: 3 }), "https://b.test")).toBe(
      "📚 1 round · ~1 min · 3 new → https://b.test",
    );
    expect(nudgeText(work({ due: 4, newAvailable: 0, roundCards: 4 }), "https://b.test")).toBe(
      "📚 1 round · ~1 min · 4 due → https://b.test",
    );
  });
});

describe("decideNudge", () => {
  it("sends at 21:00 by default, with today's household day", () => {
    const d = decideNudge(input(), LA);
    expect(d).toEqual({
      send: true,
      text: "📚 1 round · ~3 min · 7 due · 2 new → https://bamboo.example.test",
      day: "2026-06-20",
      nudgeAt: 21 * 60,
    });
  });

  it("waits until the nudge time", () => {
    expect(decideNudge(input({ now: at(20, "20:59") }), LA)).toMatchObject({
      send: false,
      reason: "too_early",
    });
    expect(decideNudge(input({ now: at(20, "21:30") }), LA).send).toBe(true);
  });

  it("sends at most once a day", () => {
    expect(decideNudge(input({ lastSentDay: "2026-06-20" }), LA)).toMatchObject({
      send: false,
      reason: "sent_today",
    });
    // Yesterday's reminder doesn't block today's.
    expect(decideNudge(input({ lastSentDay: "2026-06-19" }), LA).send).toBe(true);
    // 01:00 on the 21st is still the 20th's household day.
    expect(
      decideNudge(input({ now: at(20, "25:00"), lastSentDay: "2026-06-20" }), LA),
    ).toMatchObject({ send: false, reason: "sent_today" });
  });

  it("is suppressed after a finished round, with nothing to do, or when off", () => {
    expect(decideNudge(input({ finishedRoundToday: true }), LA)).toMatchObject({
      reason: "round_done",
    });
    expect(
      decideNudge(input({ workload: work({ due: 0, newAvailable: 0, roundCards: 0 }) }), LA),
    ).toMatchObject({ reason: "nothing_to_do" });
    expect(decideNudge(input({ enabled: false }), LA)).toMatchObject({ reason: "disabled" });
  });

  it("follows the learned time", () => {
    const roundStarts = [15, 16, 17, 18, 19].map((d) => at(d, "19:30"));
    expect(decideNudge(input({ now: at(20, "19:14"), roundStarts }), LA)).toMatchObject({
      send: false,
      reason: "too_early",
      nudgeAt: 19 * 60 + 15,
    });
    expect(decideNudge(input({ now: at(20, "19:15"), roundStarts }), LA).send).toBe(true);
  });
});
