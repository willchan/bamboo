// Background saves for the review screen (DESIGN §6 *Review*): grades are sent one at a time, in
// order, while the next card is already showing. A failed save is retried with backoff; if it
// still fails the queue pauses (nothing later is sent out of order) until `retry()`.
import { config } from "./config";

export interface SaveState {
  /** Saves not yet confirmed (including one in flight). */
  pending: number;
  /** The head save failed every attempt; the queue waits for `retry()`. */
  failed: boolean;
}

export interface SaveQueueOptions {
  retries?: number;
  retryDelayMs?: number;
  onChange?: (s: SaveState) => void;
  sleep?: (ms: number) => Promise<void>;
}

type Job = () => Promise<void>;

export class SaveQueue {
  private jobs: Job[] = [];
  private running = false;
  private failed = false;
  private waiters: ((drained: boolean) => void)[] = [];
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: SaveQueueOptions = {}) {
    this.retries = opts.retries ?? config.review.saveRetries;
    this.retryDelayMs = opts.retryDelayMs ?? config.review.saveRetryMs;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get state(): SaveState {
    return { pending: this.jobs.length, failed: this.failed };
  }

  /** Queue a save. A job that throws is retried; one that resolves is done. */
  push(job: Job): void {
    this.jobs.push(job);
    this.emit();
    void this.run();
  }

  /** Resume after a failure, starting with the save that failed. */
  retry(): void {
    if (!this.failed) return;
    this.failed = false;
    this.emit();
    void this.run();
  }

  /** Resolves true once everything queued is saved, or false if the queue is paused on a failure. */
  idle(): Promise<boolean> {
    if (this.jobs.length === 0) return Promise.resolve(true);
    if (this.failed) return Promise.resolve(false);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private emit() {
    this.opts.onChange?.(this.state);
  }

  private settle(drained: boolean) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(drained);
  }

  private async run(): Promise<void> {
    if (this.running || this.failed) return;
    this.running = true;
    while (this.jobs.length > 0) {
      const job = this.jobs[0]!;
      let saved = false;
      for (let attempt = 0; attempt <= this.retries && !saved; attempt++) {
        if (attempt > 0) await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
        try {
          await job();
          saved = true;
        } catch {
          // Network or server error: try again.
        }
      }
      if (!saved) {
        this.failed = true;
        this.running = false;
        this.emit();
        this.settle(false);
        return;
      }
      this.jobs.shift();
      this.emit();
    }
    this.running = false;
    this.settle(true);
  }
}
