// The free tier's limits (DESIGN §5.5.2): requests per minute (a sliding window) and per day
// (reset at midnight Pacific). In memory: a restart forgets the day's count, and Google's 429 is
// the backstop, which `exhaustUntil` records.

/** The next local midnight in `timeZone` after `now` (ms since epoch). */
export function nextMidnight(now: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const local = (t: number) => {
    const parts = fmt.formatToParts(new Date(t));
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    return { h: get("hour"), ms: ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 };
  };
  let at = now - (now % 1000) - local(now).ms + 24 * 3600_000;
  // Across a DST change the day is 23 or 25 hours long: step to where the local clock reads 0.
  const { h } = local(at);
  if (h !== 0) at += h < 12 ? -h * 3600_000 : (24 - h) * 3600_000;
  return at;
}

export interface RateLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  timeZone: string;
}

export class RateLimiter {
  private readonly recent: number[] = [];
  private dayCount = 0;
  private dayEndsAt: number;
  private exhaustedUntil = 0;

  constructor(
    private readonly limits: RateLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.dayEndsAt = nextMidnight(this.now(), limits.timeZone);
  }

  private roll(): void {
    const t = this.now();
    if (t >= this.dayEndsAt) {
      this.dayCount = 0;
      this.dayEndsAt = nextMidnight(t, this.limits.timeZone);
    }
    while (this.recent.length && this.recent[0]! <= t - 60_000) this.recent.shift();
  }

  /** When the daily quota resets, if it's used up now (by our count or Google's 429); else null. */
  quotaResetAt(): number | null {
    this.roll();
    const t = this.now();
    if (this.exhaustedUntil > t) return this.exhaustedUntil;
    return this.dayCount >= this.limits.requestsPerDay ? this.dayEndsAt : null;
  }

  /** How long to wait before the next request fits the per-minute window (0: now). */
  waitMs(): number {
    this.roll();
    if (this.recent.length < this.limits.requestsPerMinute) return 0;
    return Math.max(0, this.recent[0]! + 60_000 - this.now());
  }

  /** Count a request that was sent. */
  record(): void {
    this.roll();
    this.recent.push(this.now());
    this.dayCount += 1;
  }

  /** Google said the daily quota is used up: no requests until the reset. */
  exhaust(): number {
    this.roll();
    this.exhaustedUntil = this.dayEndsAt;
    return this.exhaustedUntil;
  }

  /** Requests counted today (for logs). */
  get today(): number {
    this.roll();
    return this.dayCount;
  }
}
