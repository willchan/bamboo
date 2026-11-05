import type { Metadata } from "next";
import { signOut } from "@/auth";
import { BambooMark } from "@/components/bamboo-mark";
import { APP_NAME } from "@/lib/app";
import { requireUser } from "@/lib/auth/current";

export const metadata: Metadata = { title: "Today" };

// Today (DESIGN §6). M1 placeholder: rounds, due and new counts, and Start arrive in M2.
export default async function TodayPage() {
  const user = await requireUser();

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-6">
      <header className="flex items-center gap-2">
        <BambooMark className="size-7 rounded-md" />
        <span className="text-lg font-semibold">{APP_NAME}</span>
      </header>

      <main className="flex flex-1 flex-col justify-center gap-3 py-10 text-center">
        <h1 className="text-3xl font-semibold">Today</h1>
        <p className="text-muted">Nothing to review yet.</p>
        <p className="text-sm text-muted">Your daily round appears here once you have phrases.</p>
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
    </div>
  );
}
