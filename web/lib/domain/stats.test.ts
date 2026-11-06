import { describe, expect, it } from "vitest";
import { zonedTime } from "./day";
import {
  askedAgainOnActive,
  extractionDropRate,
  notUsefulRates,
  practiceDaysPerWeek,
  rate,
  recentWeeks,
  trueRetention,
} from "./stats";
import { State } from "./state";

const TZ = "America/Los_Angeles";
const LA = { timeZone: TZ };
const at = (month: number, day: number, hour: number) => zonedTime(2026, month, day, hour, TZ);

describe("recentWeeks", () => {
  it("gives 4 whole weeks of household days ending today, newest first", () => {
    const weeks = recentWeeks(at(6, 20, 21), LA);
    expect(weeks.map((w) => [w.firstDay, w.lastDay])).toEqual([
      ["2026-06-14", "2026-06-20"],
      ["2026-06-07", "2026-06-13"],
      ["2026-05-31", "2026-06-06"],
      ["2026-05-24", "2026-05-30"],
    ]);
    expect(weeks[0]!.end).toBe(at(6, 21, 4));
    expect(weeks[0]!.start).toBe(at(6, 14, 4));
    expect(weeks[1]!.end).toBe(weeks[0]!.start);
  });

  it("before 04:00, today is still yesterday's household day", () => {
    expect(recentWeeks(at(6, 21, 2), LA, 1)[0]!.lastDay).toBe("2026-06-20");
  });

  it("spans a DST change", () => {
    const [w] = recentWeeks(at(11, 5, 21), LA, 1);
    expect([w!.firstDay, w!.lastDay]).toEqual(["2026-10-30", "2026-11-05"]);
    expect(w!.start).toBe(at(10, 30, 4));
  });
});

describe("practiceDaysPerWeek", () => {
  it("counts days with a finished round, once per day, by the 04:00 day", () => {
    const weeks = recentWeeks(at(6, 20, 21), LA, 2);
    const finished = [
      at(6, 20, 21),
      at(6, 20, 22), // a second round the same day
      at(6, 21, 1), // 01:00 on the 21st: still the 20th
      at(6, 15, 20),
      at(6, 10, 20), // last week
      at(5, 1, 20), // too old
    ];
    expect(practiceDaysPerWeek(weeks, finished, LA)).toEqual([2, 1]);
  });
});

describe("rates", () => {
  it("is null with no cases", () => {
    expect(rate(0, 0)).toEqual({ hits: 0, total: 0, rate: null });
    expect(rate(1, 4).rate).toBe(0.25);
  });

  it("true retention counts only graded reviews of Review-state cards", () => {
    const r = trueRetention([
      { rating: 3, stateBefore: State.Review, source: "session" },
      { rating: 4, stateBefore: State.Review, source: "session" },
      { rating: 1, stateBefore: State.Review, source: "session" },
      { rating: 2, stateBefore: State.Review, source: "session" },
      { rating: 1, stateBefore: State.Learning, source: "session" },
      { rating: 1, stateBefore: State.Review, source: "asked_again" },
      { rating: 4, stateBefore: State.New, source: "already_know" },
    ]);
    expect(r).toEqual({ hits: 3, total: 4, rate: 0.75 });
  });

  it("asked again counts only phrases that were active", () => {
    expect(
      askedAgainOnActive([{ status: "active" }, { status: "queued" }, { status: "active" }]),
    ).toBe(2);
  });

  it("Not useful among first sights, by kind and by usefulness", () => {
    const r = notUsefulRates([
      { kind: "term", usefulness: 4, notUseful: false },
      { kind: "term", usefulness: 2, notUseful: true },
      { kind: "frame", usefulness: 4, notUseful: false },
      { kind: "sentence", usefulness: null, notUseful: false },
    ]);
    expect(r.all).toEqual({ hits: 1, total: 4, rate: 0.25 });
    expect(r.byKind.term).toEqual({ hits: 1, total: 2, rate: 0.5 });
    expect(r.byKind.frame!.rate).toBe(0);
    expect(Object.keys(r.byUsefulness)).toEqual(["2", "4", "manual"]);
    expect(r.byUsefulness["2"]!.rate).toBe(1);
    expect(notUsefulRates([]).all.rate).toBeNull();
  });

  it("extraction drop rate is not-verbatim drops over items returned", () => {
    expect(
      extractionDropRate([
        { items: 4, dropped_not_verbatim: 1 },
        { items: 6, dropped_not_verbatim: 0 },
        { items: 0, dropped_not_verbatim: 0 },
      ]),
    ).toEqual({ hits: 1, total: 10, rate: 0.1 });
  });
});
