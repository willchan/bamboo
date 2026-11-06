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

export const metadata: Metadata = { title: "Today" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Today (DESIGN §6): "1 round · N due · M new" and Start, or "✓ Done for today".
export default async function TodayPage() {
  const user = await requireUser();
  const { status, queueSize } = await getToday(getDb(), serverClock());

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
        <VoiceHint />
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
