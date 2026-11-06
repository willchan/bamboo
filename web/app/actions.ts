"use server";
// UI mutations (DESIGN §3.1: server actions, not routes). Each one checks the signed-in user.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/current";
import { GRADES, type Grade } from "@/lib/domain/fsrs";
import { PhraseInput } from "@/lib/domain/phrase";
import { phraseFormToInput } from "@/lib/phrase-form";
import { hasHanzi } from "@bamboo/shared";
import { importPastedText, retryFailedJobs } from "@/lib/repo/capture";
import { serverClock } from "@/lib/repo/clock";
import { getDb } from "@/lib/repo/db";
import {
  createManualPhrase,
  dropPhrase,
  pinPhrase,
  restorePhrase,
  updatePhrase,
} from "@/lib/repo/phrases";
import {
  finishRound,
  gradeCard,
  markNotUseful,
  startRound,
  type GradeResult,
  type Today,
} from "@/lib/repo/review";

// --- Review ---------------------------------------------------------------------------------

/** Start a round and open it; back to Today if there's nothing to review. */
export async function startRoundAction(): Promise<void> {
  await requireUser();
  const id = await startRound(getDb(), serverClock());
  redirect(id ? `/review/${id}` : "/");
}

export async function gradeAction(input: {
  roundId: string;
  cardId: string;
  grade: Grade;
  alreadyKnow?: boolean;
  durationMs: number | null;
}): Promise<GradeResult | null> {
  await requireUser();
  if (!GRADES.includes(input.grade)) return null;
  return gradeCard(
    getDb(),
    {
      roundId: input.roundId,
      cardId: input.cardId,
      // Already know = Easy (DESIGN §4.4).
      grade: input.alreadyKnow ? 4 : input.grade,
      source: input.alreadyKnow ? "already_know" : "session",
      durationMs:
        input.durationMs !== null && Number.isFinite(input.durationMs)
          ? Math.round(input.durationMs)
          : null,
    },
    serverClock(),
  );
}

export async function notUsefulAction(cardId: string): Promise<boolean> {
  await requireUser();
  return markNotUseful(getDb(), cardId, serverClock());
}

export async function finishRoundAction(roundId: string): Promise<Today | null> {
  await requireUser();
  // No revalidatePath here: it would re-render /review/[id], which sends a finished round to
  // Today, replacing the round's own done screen. Today renders per request anyway.
  return finishRound(getDb(), roundId, serverClock());
}

// --- Phrases --------------------------------------------------------------------------------

export interface PhraseFormState {
  errors?: string[];
  duplicateId?: string;
}

/** Save the phrase editor: create (`id` empty) or update. */
export async function savePhraseAction(
  _prev: PhraseFormState,
  fd: FormData,
): Promise<PhraseFormState> {
  await requireUser();
  const parsed = PhraseInput.safeParse(phraseFormToInput(fd));
  if (!parsed.success) {
    return { errors: [...new Set(parsed.error.issues.map((i) => i.message))] };
  }
  const id = fd.get("id");
  const db = getDb();
  const now = Date.now();
  const res =
    typeof id === "string" && id
      ? await updatePhrase(db, id, parsed.data, now)
      : await createManualPhrase(db, parsed.data, now);
  if (!res.ok) {
    return res.error === "duplicate"
      ? { errors: ["You already have this phrase."], duplicateId: res.existingId }
      : { errors: ["That phrase no longer exists."] };
  }
  revalidatePath("/", "layout");
  redirect(`/phrases/${res.id}?saved=${res.overrideDropped ? "override-dropped" : "1"}`);
}

export async function dropPhraseAction(fd: FormData): Promise<void> {
  await requireUser();
  const id = String(fd.get("id") ?? "");
  const from = String(fd.get("from") ?? "");
  await dropPhrase(getDb(), id, Date.now(), from === "queue" ? "remove" : "editor");
  revalidatePath("/", "layout");
  if (from !== "queue") redirect("/phrases");
}

export async function restorePhraseAction(fd: FormData): Promise<void> {
  await requireUser();
  const id = String(fd.get("id") ?? "");
  await restorePhrase(getDb(), id, Date.now());
  revalidatePath("/", "layout");
}

// --- Imports --------------------------------------------------------------------------------

/** The paste box: one Gemini answer becomes a text import from the web (DESIGN §3.2). */
export async function pasteAnswerAction(fd: FormData): Promise<void> {
  await requireUser();
  const text = String(fd.get("text") ?? "");
  let outcome: "new" | "known" | "invalid" | "busy";
  if (!hasHanzi(text)) {
    outcome = "invalid";
  } else {
    const res = await importPastedText(getDb(), text, Date.now());
    outcome = !res.ok ? "busy" : res.turnsNew > 0 ? "new" : "known";
  }
  revalidatePath("/", "layout");
  redirect(`/imports?pasted=${outcome}`);
}

/** Imports › Retry failed: requeue every failed job with its attempts reset. */
export async function retryFailedAction(): Promise<void> {
  await requireUser();
  await retryFailedJobs(getDb());
  revalidatePath("/imports");
}

export async function pinPhraseAction(fd: FormData): Promise<void> {
  await requireUser();
  await pinPhrase(getDb(), String(fd.get("id") ?? ""), Date.now());
  revalidatePath("/queue");
}
