import type { Import } from "@bamboo/db";
import type { Metadata } from "next";
import { pasteAnswerAction, retryFailedAction } from "@/app/actions";
import { requireUser } from "@/lib/auth/current";
import { householdTimeZone } from "@/lib/config";
import { getImportsPage } from "@/lib/repo/capture";
import { getDb } from "@/lib/repo/db";
import { timed } from "@/lib/timing";

export const metadata: Metadata = { title: "Imports" };

const PASTED: Record<string, { text: string; ok: boolean }> = {
  new: { text: "Got it. Its phrases appear in Up next once the Mac has processed it.", ok: true },
  known: { text: "Already imported: nothing new in that answer.", ok: true },
  invalid: { text: "Paste a Gemini answer that contains Chinese.", ok: false },
  busy: { text: "Something else was importing the same answer. Try again.", ok: false },
};

const KIND: Record<Import["kind"], string> = { link: "Link", pdf: "PDF", text: "Pasted" };

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: householdTimeZone(),
  });

// Imports (DESIGN §6): recent imports with status and counts, failed jobs (Retry), and a paste box.
export default async function ImportsPage({ searchParams }: PageProps<"/imports">) {
  return timed("page /imports", async () => {
    await requireUser();
    const sp = await searchParams;
    const pasted = typeof sp.pasted === "string" ? PASTED[sp.pasted] : undefined;
    const { recent, failedJobs } = await getImportsPage(getDb());

    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Imports</h1>

        <form action={pasteAnswerAction} className="flex flex-col gap-2">
          <label htmlFor="paste" className="text-sm font-medium">
            Paste a Gemini answer
          </label>
          <textarea
            id="paste"
            name="text"
            required
            rows={5}
            className="rounded-xl border border-border bg-card p-3"
            placeholder="你可以说：……"
            lang="zh-CN"
          />
          <button
            type="submit"
            className="h-11 rounded-xl bg-primary font-medium text-primary-foreground"
          >
            Import
          </button>
          {pasted ? (
            <p
              role="status"
              data-testid="paste-result"
              className={`text-sm ${pasted.ok ? "text-muted" : "text-danger"}`}
            >
              {pasted.text}
            </p>
          ) : null}
        </form>

        {failedJobs.length > 0 ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Failed ({failedJobs.length})</h2>
              <form action={retryFailedAction}>
                <button type="submit" className="h-9 rounded-lg border border-border px-3 text-sm">
                  Retry failed
                </button>
              </form>
            </div>
            <ul className="flex flex-col divide-y divide-border text-sm">
              {failedJobs.map((j) => (
                <li key={j.id} className="py-2">
                  <span className="block truncate">{j.prompt || "(image only)"}</span>
                  <span className="block text-xs text-muted">
                    {j.attempt} attempts · {j.error ?? "failed"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">Recent</h2>
          {recent.length === 0 ? (
            <p className="text-sm text-muted">
              Nothing yet. Share a Gemini conversation to #bamboo, or paste an answer above.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" data-testid="imports">
              {recent.map((i) => (
                <li key={i.id} className="flex flex-col gap-0.5 py-3 text-sm">
                  <span className="flex justify-between gap-2">
                    <span className="truncate font-medium">
                      {i.conversationTitle ?? KIND[i.kind]}
                    </span>
                    <span className="shrink-0 text-muted">{when(i.createdAt)}</span>
                  </span>
                  <span className="text-muted">
                    {[
                      KIND[i.kind],
                      `${plural(i.turnsTotal, "question")}, ${i.turnsNew} new`,
                      i.status === "done"
                        ? `${plural(i.phrasesNew, "phrase")} queued`
                        : "processing on the Mac…",
                      i.jobsFailed > 0 ? `${i.jobsFailed} failed` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    );
  });
}
