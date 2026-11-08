import { PHRASE_KINDS, PHRASE_STATUSES, type PhraseKind, type PhraseStatus } from "@bamboo/db";
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/current";
import { getDb } from "@/lib/repo/db";
import { allTags, listPhrases } from "@/lib/repo/phrases";
import { timed } from "@/lib/timing";

export const metadata: Metadata = { title: "Phrases" };

const STATUS_LABEL: Record<PhraseStatus, string> = {
  queued: "up next",
  active: "learning",
  dropped: "dropped",
  expired: "expired",
};

const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

// Phrases (DESIGN §6): search, filter by kind or tag, add, edit.
export default async function PhrasesPage({ searchParams }: PageProps<"/phrases">) {
  return timed("page /phrases", async () => {
    await requireUser();
    const sp = await searchParams;
    const q = typeof sp.q === "string" ? sp.q : "";
    const kind = pick<PhraseKind>(sp.kind, PHRASE_KINDS);
    const status = pick<PhraseStatus>(sp.status, PHRASE_STATUSES);
    const tag = typeof sp.tag === "string" && sp.tag ? sp.tag : undefined;
    const db = getDb();
    const [phrases, tags] = await Promise.all([
      listPhrases(db, { q, kind, tag, status }),
      allTags(db),
    ]);

    const select = "h-10 rounded-lg border border-border bg-card px-2 text-sm";
    return (
      <main className="flex flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Phrases</h1>
          <Link
            href="/phrases/new"
            className="flex h-10 items-center rounded-xl bg-primary px-4 font-medium text-primary-foreground"
          >
            Add
          </Link>
        </header>

        <form className="flex flex-col gap-2" role="search">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search hanzi, pinyin, English"
            className="h-11 rounded-xl border border-border bg-card px-3"
          />
          <div className="flex gap-2">
            <select name="kind" defaultValue={kind ?? ""} className={select} aria-label="Kind">
              <option value="">All kinds</option>
              {PHRASE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select name="tag" defaultValue={tag ?? ""} className={select} aria-label="Tag">
              <option value="">All tags</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              name="status"
              defaultValue={status ?? ""}
              className={select}
              aria-label="Status"
            >
              <option value="">Current</option>
              {PHRASE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <button type="submit" className="h-10 rounded-lg border border-border px-3 text-sm">
              Go
            </button>
          </div>
        </form>

        {phrases.length === 0 ? (
          <p className="py-10 text-center text-muted">No phrases here yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {phrases.map((p) => (
              <li key={p.id}>
                <Link href={`/phrases/${p.id}`} className="flex items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="hanzi block truncate text-lg" lang="zh-CN">
                      {p.hanzi}
                    </span>
                    <span className="block truncate text-sm text-muted">{p.english}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted">
                    {p.kind}
                    <br />
                    {STATUS_LABEL[p.status]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    );
  });
}
