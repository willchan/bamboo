import { describe, expect, it } from "vitest";
import { dayKey, dayStart, localParts, nextDayStart, zonedTime } from "./day";

const LA = { timeZone: "America/Los_Angeles" };
const at = (iso: string) => new Date(iso).getTime();

describe("the 04:00 household day", () => {
  it("counts 01:30 as the evening before", () => {
    // 2026-03-10 01:30 PDT = 08:30Z.
    const now = at("2026-03-10T08:30:00Z");
    expect(dayKey(now, LA)).toBe("2026-03-09");
    expect(dayStart(now, LA)).toBe(at("2026-03-09T11:00:00Z")); // 04:00 PDT on the 9th
    expect(nextDayStart(now, LA)).toBe(at("2026-03-10T11:00:00Z"));
  });

  it("starts a new day at exactly 04:00", () => {
    expect(dayKey(at("2026-03-10T10:59:59Z"), LA)).toBe("2026-03-09");
    expect(dayKey(at("2026-03-10T11:00:00Z"), LA)).toBe("2026-03-10");
  });

  it("handles a DST change (spring forward: the day is 23 hours)", () => {
    // DST starts 2026-03-08 02:00 PST. 04:00 PST on the 7th = 12:00Z; 04:00 PDT on the 8th = 11:00Z.
    const evening = at("2026-03-08T05:00:00Z"); // 21:00 PST on the 7th
    expect(dayStart(evening, LA)).toBe(at("2026-03-07T12:00:00Z"));
    expect(nextDayStart(evening, LA)).toBe(at("2026-03-08T11:00:00Z"));
  });

  it("handles a DST change (fall back)", () => {
    // DST ends 2026-11-01 02:00 PDT. 04:00 PST on Nov 1 = 12:00Z.
    expect(nextDayStart(at("2026-11-01T06:00:00Z"), LA)).toBe(at("2026-11-01T12:00:00Z"));
  });

  it("supports other zones and start hours", () => {
    const tokyo = { timeZone: "Asia/Tokyo", startHour: 0 };
    expect(dayKey(at("2026-01-01T15:00:00Z"), tokyo)).toBe("2026-01-02");
    expect(dayStart(at("2026-01-01T15:00:00Z"), tokyo)).toBe(at("2026-01-01T15:00:00Z"));
    expect(dayKey(at("2026-12-31T23:00:00Z"), { timeZone: "UTC" })).toBe("2026-12-31");
  });

  it("rolls month and year boundaries", () => {
    // 02:00 PST on Jan 1 → still Dec 31.
    expect(dayKey(at("2027-01-01T10:00:00Z"), LA)).toBe("2026-12-31");
    expect(nextDayStart(at("2026-12-31T20:00:00Z"), LA)).toBe(at("2027-01-01T12:00:00Z"));
  });

  it("exposes wall-clock parts and zoned instants", () => {
    expect(localParts(at("2026-07-04T19:05:06Z"), "America/Los_Angeles")).toEqual({
      year: 2026,
      month: 7,
      day: 4,
      hour: 12,
      minute: 5,
      second: 6,
    });
    expect(zonedTime(2026, 7, 4, 4, "America/Los_Angeles")).toBe(at("2026-07-04T11:00:00Z"));
  });
});
