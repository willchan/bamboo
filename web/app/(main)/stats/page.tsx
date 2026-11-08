import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/current";
import { config } from "@/lib/config";
import type { Rate } from "@/lib/domain/stats";
import { serverClock } from "@/lib/repo/clock";
import { getDb } from "@/lib/repo/db";
import { getStats } from "@/lib/repo/stats";
import { timed } from "@/lib/timing";

export const metadata: Metadata = { title: "Stats" };

const T = config.stats;

const pct = (r: Rate) => (r.rate === null ? "–" : `${Math.round(r.rate * 100)}%`);

const dayLabel = (key: string) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** ✓ on target, ✗ off target, nothing without data. */
function Mark({ ok }: { ok: boolean | null }) {
  if (ok === null) return null;
  return (
    <span
      className={ok ? "text-primary" : "text-danger"}
      aria-label={ok ? "on target" : "off target"}
    >
      {ok ? "✓" : "✗"}
    </span>
  );
}

function Measure({
  title,
  value,
  detail,
  target,
  ok,
  testId,
}: {
  title: string;
  value: string;
  detail?: string;
  target?: string;
  ok?: boolean | null;
  testId: string;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-muted">{title}</h2>
        {target ? <span className="text-xs text-muted">target {target}</span> : null}
      </div>
      <p className="mt-1 flex items-baseline gap-2 text-2xl font-semibold">
        {value} <Mark ok={ok ?? null} />
      </p>
      {detail ? <p className="mt-1 text-sm text-muted">{detail}</p> : null}
    </section>
  );
}

const breakdown = (rates: Record<string, Rate>, label: (k: string) => string = (k) => k) =>
  Object.entries(rates)
    .map(([k, r]) => `${label(k)} ${pct(r)} (${r.hits}/${r.total})`)
    .join(" · ");

// Stats (DESIGN §6–7): PRD §6's measures over the last 4 weeks.
export default async function StatsPage() {
  return timed("page /stats", async () => {
    await requireUser();
    const clock = serverClock();
    const s = await getStats(getDb(), clock);
    const below = (r: Rate, max: number) => (r.rate === null ? null : r.rate < max);

    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Stats</h1>
        <p className="text-sm text-muted">The last {T.weeks} weeks.</p>

        <section className="rounded-2xl border border-border bg-card p-4" data-testid="stats-habit">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-muted">Days with a round</h2>
            <span className="text-xs text-muted">target ≥ {T.habitDaysPerWeek}/week</span>
          </div>
          <ul className="mt-2 flex flex-col gap-1">
            {s.weeks.map((w) => (
              <li key={w.firstDay} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 text-muted">
                  {dayLabel(w.firstDay)} – {dayLabel(w.lastDay)}
                </span>
                <span className="flex flex-1 gap-1" aria-hidden>
                  {Array.from({ length: 7 }, (_, i) => (
                    <span
                      key={i}
                      className={`h-3 flex-1 rounded-sm ${i < w.practiceDays ? "bg-primary" : "bg-border"}`}
                    />
                  ))}
                </span>
                <span className="w-10 text-right font-medium">
                  {w.practiceDays}/7 <Mark ok={w.practiceDays >= T.habitDaysPerWeek} />
                </span>
              </li>
            ))}
          </ul>
        </section>

        <Measure
          testId="stats-retention"
          title="Retention on reviews"
          value={pct(s.retention)}
          detail={`${s.retention.hits} of ${s.retention.total} review cards remembered`}
          target={`≥ ${T.retentionTarget * 100}%`}
          ok={s.retention.rate === null ? null : s.retention.rate >= T.retentionTarget}
        />
        <Measure
          testId="stats-asked-again"
          title="Asked again (phrases already learning)"
          value={String(s.askedAgainActive)}
          detail="Fewer over time means less forgetting."
        />
        <Measure
          testId="stats-not-useful"
          title="Not useful, of phrases introduced"
          value={pct(s.notUseful.all)}
          detail={
            s.notUseful.all.total
              ? `${s.notUseful.all.hits} of ${s.notUseful.all.total}. By kind: ${breakdown(
                  s.notUseful.byKind,
                )}. By usefulness: ${breakdown(s.notUseful.byUsefulness, (k) =>
                  k === "manual" ? "hand-added" : `${k}★`,
                )}.`
              : "No new phrases yet."
          }
          target={`< ${T.notUsefulMax * 100}%`}
          ok={below(s.notUseful.all, T.notUsefulMax)}
        />
        <Measure
          testId="stats-extraction"
          title="Extraction drops (hanzi not in the source)"
          value={pct(s.extractionDrop)}
          detail={`${s.extractionDrop.hits} of ${s.extractionDrop.total} items the model returned`}
          target={`< ${T.extractionDropMax * 100}%`}
          ok={below(s.extractionDrop, T.extractionDropMax)}
        />
        <Measure
          testId="stats-queue"
          title="Up next"
          value={`${s.queueSize} phrase${s.queueSize === 1 ? "" : "s"}`}
        />
        <Measure
          testId="stats-worker"
          title="Mac worker last seen"
          value={
            s.lastHeartbeatAt
              ? new Date(s.lastHeartbeatAt).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: clock.timeZone,
                })
              : "never"
          }
        />
      </main>
    );
  });
}
