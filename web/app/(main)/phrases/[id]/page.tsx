import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dropPhraseAction, restorePhraseAction } from "@/app/actions";
import { PhraseForm } from "@/components/phrase-form";
import { Ruby } from "@/components/ruby";
import { requireUser } from "@/lib/auth/current";
import { displayPinyin } from "@/lib/domain/pinyin";
import { getDb } from "@/lib/repo/db";
import { getPhrase } from "@/lib/repo/phrases";

export const metadata: Metadata = { title: "Edit phrase" };

const STATUS_TEXT = {
  queued: "Up next",
  active: "Learning",
  dropped: "Dropped",
  expired: "Expired",
} as const;

export default async function EditPhrasePage({ params, searchParams }: PageProps<"/phrases/[id]">) {
  await requireUser();
  const { id } = await params;
  const { saved } = await searchParams;
  const p = await getPhrase(getDb(), id);
  if (!p) notFound();

  const enabled = p.cards.filter((c) => c.suspendedAt === null).map((c) => c.type);
  const gone = p.status === "dropped" || p.status === "expired";

  return (
    <main className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <Link href="/phrases" className="text-sm text-muted" aria-label="Back to phrases">
          ←
        </Link>
        <h1 className="text-2xl font-semibold">Edit phrase</h1>
        <span className="ml-auto rounded-full bg-card px-3 py-1 text-xs text-muted">
          {STATUS_TEXT[p.status]}
          {p.pinned && p.status === "queued" ? " · pinned" : ""}
        </span>
      </header>

      {saved ? (
        <p role="status" className="rounded-xl bg-primary/10 p-3 text-sm" data-testid="saved">
          Saved.
          {saved === "override-dropped"
            ? " The Chinese changed, so your pinyin edits were dropped: check the new pinyin."
            : ""}
        </p>
      ) : null}

      <div className="rounded-2xl bg-card p-4 text-center">
        <Ruby
          pairs={displayPinyin(p.pinyin, p.pinyinOverride)}
          className="justify-center text-3xl"
        />
        <p className="mt-2 text-muted">{p.english}</p>
      </div>

      {gone ? (
        <form action={restorePhraseAction}>
          <input type="hidden" name="id" value={p.id} />
          <button type="submit" className="h-12 w-full rounded-2xl border border-border">
            Restore
          </button>
        </form>
      ) : null}

      <PhraseForm
        key={`${p.id}:${p.updatedAt}`}
        values={{
          id: p.id,
          kind: p.kind,
          hanzi: p.hanzi,
          english: p.english,
          addressee: p.addressee,
          heardAs: p.heardAs,
          note: p.note,
          tags: p.tags,
          examples: p.examples,
          cardTypes: enabled,
          pinyin: p.pinyin,
          pinyinOverride: p.pinyinOverride,
        }}
      />

      {gone ? null : (
        <form action={dropPhraseAction} className="pt-2">
          <input type="hidden" name="id" value={p.id} />
          <button type="submit" className="h-12 w-full rounded-2xl text-danger">
            Drop this phrase
          </button>
        </form>
      )}
    </main>
  );
}
