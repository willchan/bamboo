import { describe, expect, it } from "vitest";
import { config } from "../config";
import {
  formatInterval,
  newCardColumns,
  previewIntervals,
  Rating,
  reviewCard,
  scheduler,
  State,
} from "./fsrs";

const T0 = new Date("2026-01-01T20:00:00Z").getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("fsrs", () => {
  it("uses the configured model and our numeric enums match ts-fsrs", async () => {
    const s = await scheduler();
    expect(s).toBe(await scheduler()); // cached
    expect(Rating).toMatchObject({ Again: 1, Hard: 2, Good: 3, Easy: 4 });
    expect(State).toEqual({ New: 0, Learning: 1, Review: 2, Relearning: 3 });
    expect(config.fsrs.desiredRetention).toBe(0.85);
  });

  it("starts new cards due at creation", () => {
    expect(newCardColumns(T0)).toMatchObject({
      due: T0,
      state: State.New,
      reps: 0,
      lastReview: null,
    });
  });

  it("follows the 1m / 10m learning steps", async () => {
    const card = newCardColumns(T0);
    const again = await reviewCard("c1", card, 1, T0);
    expect(again.next.state).toBe(State.Learning);
    expect(again.next.due - T0).toBe(1 * MIN);
    expect(again.next.lastReview).toBe(T0);
    expect(again.next.reps).toBe(1);

    const good = await reviewCard("c1", card, 3, T0);
    expect(good.next.state).toBe(State.Learning);
    expect(good.next.due - T0).toBe(10 * MIN);

    const graduate = await reviewCard("c1", good.next, 3, T0 + 10 * MIN);
    expect(graduate.next.state).toBe(State.Review);
    expect(graduate.next.due - (T0 + 10 * MIN)).toBeGreaterThanOrEqual(DAY);
  });

  it("sends Easy (and Already know) straight to review, far out", async () => {
    const easy = await reviewCard("c1", newCardColumns(T0), 4, T0);
    expect(easy.next.state).toBe(State.Review);
    expect(easy.next.due - T0).toBeGreaterThan(30 * DAY);
  });

  it("relearns a lapsed review card in 10m", async () => {
    const easy = await reviewCard("c1", newCardColumns(T0), 4, T0);
    const later = easy.next.due;
    const lapse = await reviewCard("c1", easy.next, 1, later);
    expect(lapse.next.state).toBe(State.Relearning);
    expect(lapse.next.lapses).toBe(1);
    expect(lapse.next.due - later).toBe(10 * MIN);
  });

  it("returns a JSON-safe review log of the card before the review", async () => {
    const r = await reviewCard("c1", newCardColumns(T0), 3, T0);
    expect(r.log).toMatchObject({ rating: 3, state: State.New, reviewTime: T0, cardId: "c1" });
    expect(JSON.parse(JSON.stringify(r.log))).toEqual(r.log);
  });

  it("previews each grade's interval", async () => {
    const p = await previewIntervals("c1", newCardColumns(T0), T0);
    expect(p[1]).toBe(1 * MIN);
    expect(p[3]).toBe(10 * MIN);
    expect(p[4]).toBeGreaterThan(p[3]);
    expect(p[2]).toBeGreaterThan(p[1]);
  });

  it("formats intervals compactly", () => {
    expect(formatInterval(10_000)).toBe("<1m");
    expect(formatInterval(10 * MIN)).toBe("10m");
    expect(formatInterval(3 * 60 * MIN)).toBe("3h");
    expect(formatInterval(4 * DAY)).toBe("4d");
    expect(formatInterval(65 * DAY)).toBe("2mo");
    expect(formatInterval(400 * DAY)).toBe("1.1y");
  });
});
