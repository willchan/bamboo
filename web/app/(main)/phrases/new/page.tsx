import type { Metadata } from "next";
import Link from "next/link";
import { PhraseForm } from "@/components/phrase-form";
import { requireUser } from "@/lib/auth/current";

export const metadata: Metadata = { title: "Add phrase" };

// Add a phrase by hand: it goes to the front of the queue (DESIGN §4.8).
export default async function NewPhrasePage() {
  await requireUser();
  return (
    <main className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <Link href="/phrases" className="text-sm text-muted" aria-label="Back to phrases">
          ←
        </Link>
        <h1 className="text-2xl font-semibold">Add phrase</h1>
      </header>
      <p className="text-sm text-muted">
        It goes to the top of Up next. Check the pinyin after saving.
      </p>
      <PhraseForm
        values={{
          id: null,
          kind: "term",
          hanzi: "",
          english: "",
          addressee: null,
          heardAs: null,
          note: null,
          tags: [],
          examples: [],
          cardTypes: ["say"],
          pinyin: null,
          pinyinOverride: null,
        }}
      />
    </main>
  );
}
