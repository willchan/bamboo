import type { Metadata } from "next";
import Link from "next/link";
import { dropPhraseAction, pinPhraseAction } from "@/app/actions";
import { requireUser } from "@/lib/auth/current";
import { getDb } from "@/lib/repo/db";
import { serverClock } from "@/lib/repo/clock";
import { listQueue } from "@/lib/repo/phrases";
import { timed } from "@/lib/timing";

export const metadata: Metadata = { title: "Up next" };

// Up next (DESIGN §6): the ranked queue, with Move to top and Remove.
export default async function QueuePage() {
  return timed("page /queue", async () => {
    await requireUser();
    const queue = await listQueue(getDb(), serverClock().now);

    return (
      <main className="flex flex-col gap-4">
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold">Up next</h1>
          <span className="text-sm text-muted">{queue.length} waiting</span>
        </header>
        <p className="text-sm text-muted">
          New cards come from the top of this list, up to 3 a day.
        </p>

        {queue.length === 0 ? (
          <p className="py-10 text-center text-muted">
            The queue is empty.{" "}
            <Link href="/phrases/new" className="text-primary underline underline-offset-4">
              Add a phrase
            </Link>
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-border" data-testid="queue">
            {queue.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-3">
                <span className="w-6 text-right text-sm text-muted">{p.rank}</span>
                <Link href={`/phrases/${p.id}`} className="min-w-0 flex-1">
                  <span className="hanzi block truncate text-lg" lang="zh-CN">
                    {p.hanzi}
                  </span>
                  <span className="block truncate text-sm text-muted">{p.english}</span>
                  <span className="block text-xs text-muted">
                    {[
                      p.pinned ? "📌 pinned" : null,
                      p.heardAs ? `heard: ${p.heardAs}` : null,
                      p.askedCount > 1 ? `asked ×${p.askedCount}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </Link>
                <div className="flex shrink-0 flex-col gap-1">
                  {p.rank > 1 ? (
                    <form action={pinPhraseAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <button
                        type="submit"
                        className="h-9 rounded-lg border border-border px-2 text-xs"
                      >
                        Move to top
                      </button>
                    </form>
                  ) : null}
                  <form action={dropPhraseAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="from" value="queue" />
                    <button
                      type="submit"
                      className="h-9 w-full rounded-lg px-2 text-xs text-danger"
                    >
                      Remove
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ol>
        )}
      </main>
    );
  });
}
