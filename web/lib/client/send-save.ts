// Send a save kept from before a reload (lib/client/pending-saves.ts). A grade resent with its
// reviewId isn't counted twice; Not useful on a card already dropped is a no-op.
import { gradeAction, notUsefulAction } from "@/app/actions";
import type { PendingSave } from "./pending-saves";

export async function sendPendingSave(p: PendingSave): Promise<void> {
  if (p.kind === "notUseful") {
    await notUsefulAction(p.cardId);
    return;
  }
  await gradeAction({
    roundId: p.roundId,
    cardId: p.cardId,
    grade: p.grade,
    alreadyKnow: p.alreadyKnow,
    durationMs: p.durationMs,
    reviewId: p.id,
  });
}
