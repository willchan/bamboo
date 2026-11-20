"use client";
// The review screen (DESIGN §6 *Review*): one card at a time, front → tap → back → grade. Grading
// shows the next card at once and saves in the background (lib/save-queue.ts). Each save is kept in
// localStorage until confirmed, so a reload resends it (lib/client/pending-saves.ts); a page from
// an older deploy reloads into the new one instead of retrying forever (DESIGN §6 *Saving*).
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type MouseEvent,
  type ReactNode,
} from "react";
import { finishRoundAction, gradeAction, notUsefulAction } from "@/app/actions";
import { LearnMoreButton, NewToday, StartButton } from "@/components/start-button";
import { startRoundAction } from "@/app/actions";
import { Ruby } from "@/components/ruby";
import { speak } from "@/lib/audio";
import { config, type SessionConfig } from "@/lib/config";
import { reinsertIndex } from "@/lib/domain/session";
import { classifyError } from "@/lib/client/client-log";
import { handleFailure } from "@/lib/client/failure";
import {
  addPending,
  listPending,
  removePending,
  type PendingSave,
} from "@/lib/client/pending-saves";
import { sendPendingSave } from "@/lib/client/send-save";
import type { Grade } from "@/lib/domain/fsrs";
import type { ReviewCardView, Today } from "@/lib/repo/review";
import { SaveQueue, type SaveState } from "@/lib/save-queue";

const GRADE_BUTTONS: { grade: Grade; label: string; className: string }[] = [
  { grade: 1, label: "Again", className: "bg-danger/15 text-danger" },
  { grade: 2, label: "Hard", className: "bg-card border border-border" },
  { grade: 3, label: "Good", className: "bg-primary text-primary-foreground" },
  { grade: 4, label: "Easy", className: "bg-card border border-border" },
];

interface Props {
  roundId: string;
  total: number;
  initialCards: ReviewCardView[];
  session: SessionConfig;
}

interface Restored {
  /** Saves kept from before a reload (any round), to send before new ones. */
  resend: PendingSave[];
  /** Cards of this round they cover: graded already, so not shown again. */
  done: Set<string>;
}

// One snapshot per round per page load (useSyncExternalStore needs a stable value), read once and
// kept: a later visit to the same round resends nothing new, and repeats are harmless (reviewId).
const restoredByRound = new Map<string, Restored>();
const noSubscribe = () => () => {};

function restoredFor(roundId: string): Restored {
  let r = restoredByRound.get(roundId);
  if (!r) {
    const resend = listPending();
    const done = new Set(resend.filter((p) => p.roundId === roundId).map((p) => p.cardId));
    r = { resend, done };
    restoredByRound.set(roundId, r);
  }
  return r;
}

/**
 * The review screen, once the browser has said which saves a reload left behind. They live in
 * localStorage, which the server can't read, so nothing renders until the page hydrates.
 */
export function ReviewSession(props: Props) {
  const { roundId } = props;
  const restored = useSyncExternalStore(
    noSubscribe,
    () => restoredFor(roundId),
    () => null,
  );
  if (!restored) return null;
  return (
    <RoundSession
      {...props}
      initialCards={props.initialCards.filter((c) => !restored.done.has(c.cardId))}
      resend={restored.resend}
    />
  );
}

/** A card on screen; `savingAs` marks an in-round repeat waiting for its grade to be saved. */
type ClientCard = ReviewCardView & { savingAs?: string };

function RoundSession({
  roundId,
  total,
  initialCards,
  session,
  resend,
}: Props & { resend: PendingSave[] }) {
  const router = useRouter();
  const [cards, setCards] = useState<ClientCard[]>(initialCards);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [finished, setFinished] = useState<Today | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ pending: 0, failed: false });
  // The page is from an older deploy and couldn't reload itself: offer Reload, not Retry.
  const [stale, setStale] = useState(false);
  const [saves] = useState(
    () =>
      new SaveQueue({
        onChange: setSaveState,
        isFatal: (err) => classifyError(err) === "stale",
        onFail: (err, attempts) => {
          void handleFailure({ where: "save", err, attempts }).then((outcome) => {
            if (outcome === "stale") setStale(true);
          });
        },
      }),
  );
  const restoring = useRef(false);
  const [, startTransition] = useTransition();
  const shownAt = useRef<number>(0);
  const advancedAt = useRef<number>(-Infinity);
  const finishing = useRef(false);

  const current = cards[index];

  // Saves kept from before a reload go out first (their cards are already left out).
  useEffect(() => {
    if (restoring.current) return;
    restoring.current = true;
    for (const p of resend) {
      saves.push(async () => {
        await sendPendingSave(p);
        removePending(p.id);
      });
    }
  }, [resend, saves]);

  // Finish once every grade is saved; if a save is stuck, wait for Retry.
  const finish = useCallback(() => {
    if (finishing.current) return;
    finishing.current = true;
    startTransition(async () => {
      if (!(await saves.idle())) {
        finishing.current = false;
        return;
      }
      const today = await finishRoundAction(roundId);
      setFinished(
        today ?? {
          status: { kind: "done", another: null },
          queueSize: 0,
          learnMore: 0,
          newToday: { introduced: 0, target: 0 },
          keepGoing: false,
        },
      );
    });
  }, [roundId, saves]);

  // A new card: start its timer; Listen cards play straight away. Keyed by position and card, so
  // a repeat's labels arriving from its save don't replay it or restart its timer.
  const currentKey = current ? `${index}:${current.cardId}` : null;
  const autoplay = current?.type === "listen" ? current.hanzi : null;
  useEffect(() => {
    if (currentKey === null) {
      finish();
      return;
    }
    shownAt.current = performance.now();
    if (autoplay !== null) void speak(autoplay);
  }, [currentKey, autoplay, finish]);

  const advance = (next: ClientCard[]) => {
    advancedAt.current = performance.now();
    setCards(next);
    setIndex((i) => i + 1);
    setRevealed(false);
  };

  const reveal = () => {
    if (!current || revealed) return;
    // The next card appears under the finger that just graded: ignore an accidental second tap.
    if (performance.now() - advancedAt.current < config.review.revealGuardMs) return;
    setRevealed(true);
    if (current.type === "say") void speak(current.hanzi);
  };

  /**
   * Grade and move on at once; the grade is saved in the background, in order (DESIGN §6). An
   * in-round repeat (§4.4) is decided from the card's own preview, and gets fresh interval labels
   * when its save comes back.
   */
  const grade = (g: Grade, alreadyKnow = false) => {
    if (!current || current.savingAs) return;
    const durationMs = performance.now() - shownAt.current;
    const reviewId = crypto.randomUUID();
    const effective: Grade = alreadyKnow ? 4 : g;
    const rest = cards.length - index - 1;
    const at = reinsertIndex(rest, current.dueInMsByGrade[effective], session);
    const next = [...cards];
    if (at !== null) {
      next.splice(index + 1 + at, 0, { ...current, firstSight: false, savingAs: reviewId });
    }
    advance(next);
    const { cardId } = current;
    const pending: PendingSave = {
      kind: "grade",
      id: reviewId,
      roundId,
      cardId,
      grade: g,
      alreadyKnow,
      durationMs,
    };
    addPending(pending);
    saves.push(async () => {
      const res = await gradeAction({
        roundId,
        cardId,
        grade: g,
        alreadyKnow,
        durationMs,
        reviewId,
      });
      removePending(reviewId);
      if (!res) {
        setError("That card couldn't be saved. It was skipped.");
        setCards((cs) => cs.filter((c) => c.savingAs !== reviewId));
        return;
      }
      setCards((cs) =>
        cs.map((c) =>
          c.savingAs === reviewId
            ? {
                ...c,
                savingAs: undefined,
                intervals: res.intervals,
                dueInMsByGrade: res.dueInMsByGrade,
              }
            : c,
        ),
      );
    });
  };

  const notUseful = () => {
    if (!current) return;
    const { cardId } = current;
    advance(cards);
    const id = crypto.randomUUID();
    addPending({ kind: "notUseful", id, roundId, cardId });
    saves.push(async () => {
      await notUsefulAction(cardId);
      removePending(id);
    });
  };

  const retrySaves = () => {
    saves.retry();
    if (!current) {
      finishing.current = false;
      finish();
    }
  };

  // Leaving mid-round: let the last grades land first, so Today counts them.
  const leave = (e: MouseEvent<HTMLAnchorElement>) => {
    if (saves.state.pending === 0) return;
    e.preventDefault();
    void saves.idle().then((drained) => {
      if (drained) router.push("/");
    });
  };

  const unsaved = saveState.pending === 1 ? "an answer" : `${saveState.pending} answers`;
  const saveAlert = !saveState.failed ? null : stale ? (
    <div role="alert" className="mb-2 flex items-center justify-center gap-3 text-sm text-danger">
      <span>Bamboo was updated. Reload to save {unsaved}.</span>
      <button
        type="button"
        onClick={() => location.reload()}
        className="rounded-md border border-danger/40 px-2 py-1"
      >
        Reload
      </button>
    </div>
  ) : (
    <div role="alert" className="mb-2 flex items-center justify-center gap-3 text-sm text-danger">
      <span>Couldn&apos;t save {unsaved}.</span>
      <button
        type="button"
        onClick={retrySaves}
        className="rounded-md border border-danger/40 px-2 py-1"
      >
        Retry
      </button>
    </div>
  );

  if (finished || !current) {
    return <RoundDone today={finished} alert={saveAlert} />;
  }

  const position = Math.min(index + 1, cards.length);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-4 pb-6">
      <header className="flex items-center justify-between text-sm text-muted">
        <Link
          href="/"
          onClick={leave}
          className="-ml-2 rounded-md px-2 py-1"
          aria-label="Leave the round"
        >
          ✕
        </Link>
        <span data-testid="progress">
          {position} / {Math.max(total, cards.length)}
        </span>
        <span className="w-6" />
      </header>

      <button
        type="button"
        onClick={reveal}
        disabled={revealed}
        aria-label={revealed ? undefined : "Show answer"}
        className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center"
      >
        {current.type === "say" ? (
          <p className="text-2xl font-semibold" data-testid="card-front">
            {current.english}
          </p>
        ) : (
          // No "you heard" hint on the front: it repeats Will's own mishearing (DESIGN §10 #59).
          <span className="text-5xl" aria-hidden data-testid="card-front">
            🔊
          </span>
        )}

        {revealed ? (
          <div className="flex w-full flex-col items-center gap-4" data-testid="card-back">
            <Ruby pairs={current.pinyin} className="justify-center text-4xl" />
            {current.type === "listen" && current.heardAs ? (
              <p className="-mt-2 text-sm text-muted" data-testid="heard-as">
                you first heard: <i>{current.heardAs}</i>
              </p>
            ) : null}
            {current.type === "listen" ? (
              <p className="text-xl font-semibold">{current.english}</p>
            ) : null}
            {current.breakdown ? <Breakdown view={current.breakdown} /> : null}
            {current.note ? <p className="text-sm text-muted">{current.note}</p> : null}
            {/* With a breakdown, the back shows all of a term's examples; without, as before. */}
            {current.examples.slice(0, current.breakdown ? undefined : 1).map((ex) => (
              <div key={ex.hanzi} className="w-full rounded-xl bg-card p-3 text-left">
                <Ruby pairs={ex.pinyin} className="text-xl" />
                {ex.english ? <p className="mt-1 text-sm text-muted">{ex.english}</p> : null}
              </div>
            ))}
          </div>
        ) : null}
      </button>

      {error ? (
        <p role="alert" className="mb-2 text-center text-sm text-danger">
          {error}
        </p>
      ) : null}
      {saveAlert}

      <div className="flex flex-col gap-3">
        <div className="flex justify-center gap-3">
          <button
            type="button"
            onClick={() => void speak(current.hanzi)}
            className="h-11 rounded-full border border-border px-4 whitespace-nowrap"
            aria-label="Replay"
          >
            🔊 Replay
          </button>
          {revealed ? (
            <>
              <button
                type="button"
                onClick={() => void speak(current.hanzi, { slow: true })}
                className="h-11 rounded-full border border-border px-4 whitespace-nowrap"
                aria-label="Slow replay"
              >
                🐢 Slow
              </button>
              {current.examples[0] ? (
                <button
                  type="button"
                  onClick={() => void speak(current.examples[0]!.hanzi)}
                  className="h-11 rounded-full border border-border px-4 whitespace-nowrap"
                  aria-label="Play example"
                >
                  🔊 Example
                </button>
              ) : null}
            </>
          ) : null}
        </div>

        {revealed ? (
          <>
            {current.firstSight ? (
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={notUseful}
                  className="h-12 rounded-2xl border border-border text-muted disabled:opacity-60"
                >
                  Not useful
                </button>
                <button
                  type="button"
                  onClick={() => grade(4, true)}
                  className="h-12 rounded-2xl border border-border text-muted disabled:opacity-60"
                >
                  Already know
                </button>
              </div>
            ) : null}
            <div className="grid grid-cols-4 gap-2">
              {GRADE_BUTTONS.map((b) => (
                <button
                  key={b.grade}
                  type="button"
                  disabled={current.savingAs !== undefined}
                  onClick={() => grade(b.grade)}
                  className={`flex h-16 flex-col items-center justify-center rounded-2xl font-semibold disabled:opacity-60 ${b.className}`}
                >
                  <span>{b.label}</span>
                  <span className="text-xs font-normal opacity-80">
                    {current.savingAs ? "…" : current.intervals[b.grade]}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={reveal}
            className="h-16 rounded-2xl bg-primary text-lg font-semibold text-primary-foreground"
          >
            Show
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The card back's breakdown (DESIGN §5.5.4): each character (term) or word (sentence) with its
 * pinyin, sliced from the card's own, and a short gloss; then the term's meaning or the sentence's
 * note on how it's built.
 */
function Breakdown({ view }: { view: NonNullable<ReviewCardView["breakdown"]> }) {
  const summary = view.meaning ?? view.note;
  return (
    <div className="w-full rounded-xl bg-card p-3" data-testid="breakdown">
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-3">
        {view.parts.map((p, i) => (
          <div key={i} className="flex max-w-[7rem] flex-col items-center">
            <Ruby pairs={p.pinyin} className="text-2xl" />
            <span className="text-center text-xs text-muted">{p.gloss}</span>
          </div>
        ))}
      </div>
      {summary ? <p className="mt-3 text-center text-sm">{summary}</p> : null}
    </div>
  );
}

/**
 * Keep going (DESIGN §4.4): during a backlog, the round's end starts the next round by itself,
 * new cards first, until today's target is reached. ✕ on the next card stops.
 */
function KeepGoing({ today }: { today: Today }) {
  const form = useRef<HTMLFormElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    form.current?.requestSubmit();
  }, []);
  const left = today.newToday.target - today.newToday.introduced;
  return (
    <>
      <p className="text-2xl font-semibold text-primary" data-testid="keep-going">
        ✓ Round done
      </p>
      <NewToday {...today.newToday} />
      <form ref={form} action={startRoundAction} className="w-full">
        <input type="hidden" name="keepGoing" value="1" />
        <button
          type="submit"
          className="h-12 w-full rounded-2xl border border-border text-base font-medium"
        >
          Keep going ({left} new left)…
        </button>
      </form>
    </>
  );
}

function RoundDone({ today, alert }: { today: Today | null; alert: ReactNode }) {
  const status = today?.status;
  if (today?.keepGoing && status?.kind === "done") {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-5 px-5 text-center">
        {alert}
        <KeepGoing today={today} />
        <Link href="/" className="text-primary underline underline-offset-4">
          Back to Today
        </Link>
      </div>
    );
  }
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-5 px-5 text-center">
      {alert}
      {!today ? (
        <p className="text-muted">Saving…</p>
      ) : (
        <>
          <p className="text-3xl font-semibold text-primary" data-testid="done-for-today">
            ✓ Done for today
          </p>
          {status?.kind === "done" && status.another ? (
            <StartButton primary={false} label={`Another round (${status.another.due} due)`} />
          ) : status?.kind === "start" ? (
            <StartButton primary={false} label="Another round" />
          ) : null}
          {today.learnMore > 0 ? <LearnMoreButton n={today.learnMore} /> : null}
          {today.newToday.introduced > 0 ? <NewToday {...today.newToday} /> : null}
          <Link href="/" className="text-primary underline underline-offset-4">
            Back to Today
          </Link>
        </>
      )}
    </div>
  );
}
