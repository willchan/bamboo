import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ReviewSession } from "@/components/review-session";
import { requireUser } from "@/lib/auth/current";
import { config } from "@/lib/config";
import { serverClock } from "@/lib/repo/clock";
import { getDb } from "@/lib/repo/db";
import { getRound } from "@/lib/repo/review";

export const metadata: Metadata = { title: "Review" };

// Review (DESIGN §6): one card at a time. A reload resumes with the cards not yet graded.
export default async function ReviewPage({ params }: PageProps<"/review/[id]">) {
  await requireUser();
  const { id } = await params;
  const round = await getRound(getDb(), id, serverClock());
  if (!round) notFound();
  if (round.finished) redirect("/");
  return (
    <ReviewSession
      roundId={round.id}
      total={round.total}
      initialCards={round.cards}
      session={config.session}
    />
  );
}
