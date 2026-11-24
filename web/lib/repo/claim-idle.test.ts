// An idle `claim` must be cheap (DESIGN §10 #110): the worker polls all day and every database
// round trip costs Vercel free-tier CPU. Synthetic data only.
import { createTestDb, job, type Db } from "@bamboo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimJob, importPastedText } from "./capture";
import { currentTiming, instrumentClient, timed } from "../timing";

const T0 = new Date("2026-11-10T03:00:00Z").getTime();

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  instrumentClient(db.$client);
});
afterEach(() => db.$client.close());

/** Run `fn` and report how many database calls it made. */
async function queries<T>(fn: () => Promise<T>): Promise<{ out: T; n: number }> {
  let n = 0;
  const out = await timed("test", async () => {
    const r = await fn();
    n = currentTiming()!.dbQueries;
    return r;
  });
  return { out, n };
}

describe("claimJob when idle", () => {
  it("makes one database call for every job type", async () => {
    const r = await queries(() => claimJob(db, T0, ["extract_turn", "pinyin"]));
    expect(r.out).toBeNull();
    expect(r.n).toBe(1);
  });

  it("still claims a queued job, and reclaims an expired lease", async () => {
    const imp = await importPastedText(db, "你好，今天怎么样？这是一个测试。", T0);
    if (!imp.ok) throw new Error(imp.error);
    const first = await claimJob(db, T0, ["extract_turn", "pinyin"]);
    expect(first?.type).toBe("extract_turn");
    expect(await claimJob(db, T0 + 1000, ["extract_turn", "pinyin"])).toBeNull();
    // The lease runs out: the next claim requeues it and leases it again (attempt 2).
    const later = first!.lease_expires_at + 1;
    const again = await claimJob(db, later, ["extract_turn", "pinyin"]);
    expect(again).toMatchObject({ job_id: first!.job_id, attempt: 2 });
    expect((await db.select().from(job).where(eq(job.id, first!.job_id)).get())!.status).toBe(
      "leased",
    );
  });
});
