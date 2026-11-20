// Saves the review screen hasn't had confirmed yet (DESIGN §6 *Saving*), kept in localStorage so a
// reload (a newer deploy, a killed PWA) resends them instead of losing them. A grade carries its
// `reviewId`, so a resend of one the server already has isn't counted twice. localStorage, not
// IndexedDB: a handful of small records, written once per grade, read by the page only (DESIGN
// §10). Every access is guarded: blocked storage means no resend, never a broken page.
import type { Grade } from "../domain/fsrs";

export type PendingSave =
  | {
      kind: "grade";
      /** Also the grade's reviewId. */
      id: string;
      roundId: string;
      cardId: string;
      grade: Grade;
      alreadyKnow: boolean;
      durationMs: number | null;
    }
  | { kind: "notUseful"; id: string; roundId: string; cardId: string };

const KEY = "bamboo.pendingSaves.v1";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function local(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const isPending = (x: unknown): x is PendingSave => {
  const p = x as Partial<PendingSave> | null;
  return (
    !!p &&
    (p.kind === "grade" || p.kind === "notUseful") &&
    typeof p.id === "string" &&
    typeof p.roundId === "string" &&
    typeof p.cardId === "string"
  );
};

export function listPending(store: Store | null = local()): PendingSave[] {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPending) : [];
  } catch {
    return [];
  }
}

function write(list: PendingSave[], store: Store | null) {
  try {
    if (list.length === 0) store?.removeItem(KEY);
    else store?.setItem(KEY, JSON.stringify(list));
  } catch {
    // Full or blocked: the save still goes out; it just won't survive a reload.
  }
}

export function addPending(save: PendingSave, store: Store | null = local()): void {
  write([...listPending(store).filter((p) => p.id !== save.id), save], store);
}

export function removePending(id: string, store: Store | null = local()): void {
  const list = listPending(store);
  if (list.some((p) => p.id === id))
    write(
      list.filter((p) => p.id !== id),
      store,
    );
}
