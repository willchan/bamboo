"use client";
// Start (or Another round, or Learn N more): the tap also unlocks iOS speech, which needs a user gesture before
// the first utterance (DESIGN §6 *Audio*).
import { useFormStatus } from "react-dom";
import { startRoundAction } from "@/app/actions";
import { unlockAudio } from "@/lib/audio";

function Submit({ label, primary }: { label: string; primary: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={unlockAudio}
      className={
        primary
          ? "h-14 w-full rounded-2xl bg-primary text-lg font-semibold text-primary-foreground disabled:opacity-60"
          : "h-12 w-full rounded-2xl border border-border text-base font-medium disabled:opacity-60"
      }
    >
      {pending ? "Starting…" : label}
    </button>
  );
}

export function StartButton({
  label = "Start",
  primary = true,
  learnMore = false,
}: {
  label?: string;
  primary?: boolean;
  /** Ask for extra new cards beyond today's cap ("Learn N more", DESIGN §4.4). */
  learnMore?: boolean;
}) {
  return (
    <form action={startRoundAction} className="w-full">
      {learnMore ? <input type="hidden" name="learnMore" value="1" /> : null}
      <Submit label={label} primary={primary} />
    </form>
  );
}

/** "Learn N more": opt-in, once today's new cards are used up and more are waiting. */
export function LearnMoreButton({ n }: { n: number }) {
  return <StartButton primary={false} learnMore label={`Learn ${n} more`} />;
}
