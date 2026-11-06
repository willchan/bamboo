// The extract_turn job lifecycle (DESIGN §3.2, §5.3) as pure rules: queued → leased (claim,
// attempt + 1) → done, or back to queued after a failed or expired attempt until `maxAttempts`.
import type { JobStatus } from "@bamboo/db";
import { config } from "../config";

export interface JobsConfig {
  leaseMinutes: number;
  maxAttempts: number;
}

/** When a lease taken now runs out. */
export const leaseExpiresAt = (now: number, cfg: JobsConfig = config.jobs): number =>
  now + cfg.leaseMinutes * 60_000;

/**
 * A `complete` call is stale unless it is for the job's current lease. An expired lease that
 * nothing has swept or re-claimed yet still counts: the work was done.
 */
export const isStaleAttempt = (job: { status: JobStatus; attempt: number }, attempt: number) =>
  job.status !== "leased" || job.attempt !== attempt;

/** After an attempt fails (an error, an invalid result, or an expired lease). */
export const statusAfterFailure = (
  attempt: number,
  cfg: JobsConfig = config.jobs,
): "queued" | "failed" => (attempt >= cfg.maxAttempts ? "failed" : "queued");

/** Leases that ran out before `now`. */
export const isLeaseExpired = (
  job: { status: JobStatus; leaseExpiresAt: number | null },
  now: number,
): boolean => job.status === "leased" && job.leaseExpiresAt !== null && job.leaseExpiresAt <= now;
