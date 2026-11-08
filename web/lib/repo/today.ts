// Everything the Today page shows (DESIGN §6), loaded in parallel.
import type { Db } from "@bamboo/db";
import { getWorkerStatus } from "./capture";
import { getNudgeTime, isNudgeEnabled } from "./nudge";
import { getToday, type Clock } from "./review";

export async function loadTodayPage(db: Db, clock: Clock) {
  const [today, worker, nudgeOn, nudgeAt] = await Promise.all([
    getToday(db, clock),
    getWorkerStatus(db, clock.now),
    isNudgeEnabled(db),
    getNudgeTime(db, clock),
  ]);
  return { ...today, worker, nudgeOn, nudgeAt };
}
