"use client";
// The review screen (DESIGN §6 *Review*): one card at a time, front → tap → back → grade.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { finishRoundAction, gradeAction, notUsefulAction } from "@/app/actions";
import { StartButton } from "@/components/start-button";
import { Ruby } from "@/components/ruby";
import { addresseeChip } from "@/lib/addressee";
import { speak } from "@/lib/audio";
import type { SessionConfig } from "@/lib/config";
import { reinsertIndex } from "@/lib/domain/session";
import type { Grade } from "@/lib/domain/fsrs";
import type { ReviewCardView, Today } from "@/lib/repo/review";

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

export function ReviewSession({ roundId, total, initialCards, session }: Props) {
  const [cards, setCards] = useState(initialCards);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [finished, setFinished] = useState<Today | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const shownAt = useRef<number>(0);
  const finishing = useRef(false);

  const current = cards[index];

  const finish = useCallback(() => {
    if (finishing.current) return;
    finishing.current = true;
    startTransition(async () => {
      const today = await finishRoundAction(roundId);
      setFinished(today ?? { status: { kind: "done", another: null }, queueSize: 0 });
    });
  }, [roundId]);

  // A new card: start its timer; Listen cards play straight away.
  useEffect(() => {
    if (!current) {
      finish();
      return;
    }
    shownAt.current = performance.now();
    if (current.type === "listen") void speak(current.hanzi);
  }, [current, finish]);

  const advance = (next: ReviewCardView[]) => {
    setCards(next);
    setIndex((i) => i + 1);
    setRevealed(false);
  };

  const reveal = () => {
    if (!current || revealed) return;
    setRevealed(true);
    if (current.type === "say") void speak(current.hanzi);
  };

  const grade = (g: Grade, alreadyKnow = false) => {
    if (!current || pending) return;
    const durationMs = performance.now() - shownAt.current;
    startTransition(async () => {
      const res = await gradeAction({
        roundId,
        cardId: current.cardId,
        grade: g,
        alreadyKnow,
        durationMs,
      });
      if (!res) {
        setError("That card couldn't be saved. It was skipped.");
        advance(cards);
        return;
      }
      setError(null);
      // Again inside the round: the card comes back after its learning step if that fits.
      const rest = cards.length - index - 1;
      const at = reinsertIndex(rest, res.dueInMs, session);
      const next = [...cards];
      if (at !== null) {
        next.splice(index + 1 + at, 0, { ...current, firstSight: false, intervals: res.intervals });
      }
      advance(next);
    });
  };

  const notUseful = () => {
    if (!current || pending) return;
    startTransition(async () => {
      await notUsefulAction(current.cardId);
      advance(cards);
    });
  };

  if (finished || !current) {
    return <RoundDone today={finished} />;
  }

  const chip = addresseeChip(current.addressee);
  const position = Math.min(index + 1, cards.length);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-4 pb-6">
      <header className="flex items-center justify-between text-sm text-muted">
        <Link href="/" className="-ml-2 rounded-md px-2 py-1" aria-label="Leave the round">
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
          <>
            {chip ? (
              <span className="hanzi rounded-full bg-card px-3 py-1 text-sm text-muted">
                {chip}
              </span>
            ) : null}
            <p className="text-2xl font-semibold" data-testid="card-front">
              {current.english}
            </p>
          </>
        ) : (
          <>
            <span className="text-5xl" aria-hidden>
              🔊
            </span>
            {current.heardAs ? (
              <p className="text-muted">
                you heard: <i>{current.heardAs}</i>
              </p>
            ) : null}
          </>
        )}

        {revealed ? (
          <div className="flex w-full flex-col items-center gap-4" data-testid="card-back">
            <Ruby pairs={current.pinyin} className="justify-center text-4xl" />
            {current.type === "listen" ? (
              <p className="text-xl font-semibold">{current.english}</p>
            ) : null}
            {current.note ? <p className="text-sm text-muted">{current.note}</p> : null}
            {current.examples.slice(0, 1).map((ex) => (
              <div key={ex.hanzi} className="w-full rounded-xl bg-card p-3 text-left">
                <Ruby pairs={ex.pinyin} className="text-xl" />
                {ex.english ? <p className="mt-1 text-sm text-muted">{ex.english}</p> : null}
              </div>
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted">Tap to show</span>
        )}
      </button>

      {error ? (
        <p role="alert" className="mb-2 text-center text-sm text-danger">
          {error}
        </p>
      ) : null}

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
                  disabled={pending}
                  onClick={notUseful}
                  className="h-12 rounded-2xl border border-border text-muted disabled:opacity-60"
                >
                  Not useful
                </button>
                <button
                  type="button"
                  disabled={pending}
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
                  disabled={pending}
                  onClick={() => grade(b.grade)}
                  className={`flex h-16 flex-col items-center justify-center rounded-2xl font-semibold disabled:opacity-60 ${b.className}`}
                >
                  <span>{b.label}</span>
                  <span className="text-xs font-normal opacity-80">
                    {current.intervals[b.grade]}
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

function RoundDone({ today }: { today: Today | null }) {
  const status = today?.status;
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-5 px-5 text-center">
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
          <Link href="/" className="text-primary underline underline-offset-4">
            Back to Today
          </Link>
        </>
      )}
    </div>
  );
}
