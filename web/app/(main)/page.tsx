import type { Metadata } from "next";
import Link from "next/link";
import { signOut } from "@/auth";
import { BambooMark } from "@/components/bamboo-mark";
import { StartButton } from "@/components/start-button";
import { VoiceHint } from "@/components/voice-hint";
import { APP_NAME } from "@/lib/app";
import { requireUser } from "@/lib/auth/current";
import { serverClock } from "@/lib/repo/clock";
import { getDb } from "@/lib/repo/db";
import { getToday } from "@/lib/repo/review";
import { getWorkerStatus } from "@/lib/repo/capture";
import { getNudgeTime, isNudgeEnabled } from "@/lib/repo/nudge";
import { setNudgeAction } from "@/app/actions";

export const metadata: Metadata = { title: "Today" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const lastSeen = (ms: number, timeZone: string) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });

// Today (DESIGN §6): "1 round · N due · M new" and Start, or "✓ Done for today".
export default async function TodayPage() {
  const user = await requireUser();
  const clock = serverClock();
  const [{ status, queueSize }, worker, nudgeOn, nudgeAt] = await Promise.all([
    getToday(getDb(), clock),
    getWorkerStatus(getDb(), clock.now),
    isNudgeEnabled(getDb()),
    getNudgeTime(getDb(), clock),
  ]);

  return (
    <>
      <header className="flex items-center gap-2">
        <BambooMark className="size-7 rounded-md" />
        <span className="text-lg font-semibold">{APP_NAME}</span>
      </header>

      <main className="flex flex-1 flex-col justify-center gap-5 py-10 text-center">
        <h1 className="text-3xl font-semibold">Today</h1>
        {status.kind === "start" ? (
          <>
            <p className="text-lg text-muted" data-testid="today-summary">
              1 round · {status.workload.due} due · {status.workload.newAvailable} new
            </p>
            <StartButton />
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold text-primary" data-testid="done-for-today">
              ✓ Done for today
            </p>
            {status.another ? (
              <StartButton
                primary={false}
                label={`Another round (${plural(status.another.due, "due", "due")}${
                  status.another.newAvailable ? ` · ${status.another.newAvailable} new` : ""
                })`}
              />
            ) : queueSize === 0 ? (
              <p className="text-sm text-muted">
                Nothing waiting.{" "}
                <Link href="/phrases/new" className="text-primary underline underline-offset-4">
                  Add a phrase
                </Link>
              </p>
            ) : null}
          </>
        )}
        {worker.kind === "offline" ? (
          <p className="text-sm text-muted" data-testid="worker-offline">
            ⏳ {plural(worker.waiting, "question")} waiting for the Mac worker (
            {worker.lastSeenAt
              ? `last seen ${lastSeen(worker.lastSeenAt, clock.timeZone)}`
              : "never seen"}
            ).
          </p>
        ) : null}
        <VoiceHint />
        <form action={setNudgeAction} className="flex justify-center">
          <input type="hidden" name="enabled" value={nudgeOn ? "0" : "1"} />
          <button
            type="submit"
            role="switch"
            aria-checked={nudgeOn}
            data-testid="nudge-toggle"
            className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted"
          >
            <span
              aria-hidden
              className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
                nudgeOn ? "bg-primary" : "bg-border"
              }`}
            >
              <span
                className={`absolute top-0.5 size-5 rounded-full bg-background shadow transition-all ${
                  nudgeOn ? "left-[1.125rem]" : "left-0.5"
                }`}
              />
            </span>
            <span className="text-left">
              Evening reminder{nudgeOn ? ` · around ${nudgeAt}` : " · off"}
            </span>
          </button>
        </form>
      </main>

      <footer className="flex items-center justify-between gap-3 border-t border-border pt-4 text-sm text-muted">
        <span className="truncate" data-testid="signed-in-as">
          {user.dev ? `Dev sign-in: ${user.email}` : `Signed in as ${user.email}`}
        </span>
        {user.dev ? null : (
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/sign-in" });
            }}
          >
            <button type="submit" className="rounded-md px-2 py-1 underline underline-offset-4">
              Sign out
            </button>
          </form>
        )}
      </footer>
    </>
  );
}
