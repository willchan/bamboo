import { describe, expect, it } from "vitest";
import { SaveQueue, type SaveState } from "./save-queue";

const noSleep = () => Promise.resolve();

describe("SaveQueue", () => {
  it("saves in order, one at a time", async () => {
    const log: string[] = [];
    let inFlight = 0;
    const q = new SaveQueue({ sleep: noSleep });
    for (const name of ["a", "b", "c"]) {
      q.push(async () => {
        inFlight++;
        expect(inFlight).toBe(1);
        await new Promise((r) => setTimeout(r, 1));
        log.push(name);
        inFlight--;
      });
    }
    expect(q.state.pending).toBe(3);
    expect(await q.idle()).toBe(true);
    expect(log).toEqual(["a", "b", "c"]);
    expect(q.state).toEqual({ pending: 0, failed: false });
  });

  it("retries a failed save with doubling backoff", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const q = new SaveQueue({
      retries: 3,
      retryDelayMs: 100,
      sleep: async (ms) => void delays.push(ms),
    });
    q.push(async () => {
      if (++attempts < 3) throw new Error("offline");
    });
    expect(await q.idle()).toBe(true);
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("pauses on a save that keeps failing, keeps later saves back, and resumes on retry", async () => {
    const states: SaveState[] = [];
    let online = false;
    const saved: string[] = [];
    const q = new SaveQueue({ retries: 1, sleep: noSleep, onChange: (s) => states.push(s) });
    q.push(async () => {
      if (!online) throw new Error("offline");
      saved.push("first");
    });
    q.push(async () => void saved.push("second"));
    expect(await q.idle()).toBe(false);
    expect(saved).toEqual([]);
    expect(q.state).toEqual({ pending: 2, failed: true });
    expect(states.at(-1)).toEqual({ pending: 2, failed: true });
    // Paused: idle answers at once.
    expect(await q.idle()).toBe(false);

    online = true;
    q.retry();
    expect(await q.idle()).toBe(true);
    expect(saved).toEqual(["first", "second"]);
    q.retry(); // no-op when nothing failed
    expect(q.state).toEqual({ pending: 0, failed: false });
  });

  it("is idle at once when empty", async () => {
    expect(await new SaveQueue().idle()).toBe(true);
  });
});
