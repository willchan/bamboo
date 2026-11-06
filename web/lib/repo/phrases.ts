// Phrase persistence: create, edit, drop, pin, list. Domain rules live in lib/domain; this layer
// loads, calls them, and writes the results.
import {
  card,
  CARD_TYPES,
  event,
  phrase,
  type Card,
  type CardType,
  type Db,
  type Phrase,
  type PhraseExample,
  type PhraseKind,
  type PhraseStatus,
  type TurnKind,
} from "@bamboo/db";
import { hanziKey } from "@bamboo/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { newCardColumns } from "../domain/fsrs";
import { derivedFields, examplesFor, type PhraseInput } from "../domain/phrase";
import { computePinyin, overrideFromEdits, repinyin } from "../domain/pinyin";
import { effectiveScore, orderQueue } from "../domain/queue";
import { eventRow, newId, runBatch } from "./db";

export type PhraseWithCards = Phrase & { cards: Card[] };

export interface NewPhraseFields {
  status: PhraseStatus;
  kind: PhraseKind;
  hanzi: string;
  english: string;
  addressee?: string | null;
  heardAs?: string | null;
  examples?: PhraseExample[];
  note?: string | null;
  tags?: string[];
  usefulness?: number | null;
  turnKind?: TurnKind | null;
  pinned?: boolean;
  source: "manual" | "import";
  sourceTurnId?: string | null;
  flags?: string[];
  pinyinOverride?: Phrase["pinyinOverride"];
}

/** Build the phrase row and its card rows (FSRS New, due now). Doesn't write. */
export function phraseRows(f: NewPhraseFields, cardTypes: readonly CardType[], now: number) {
  const id = newId();
  const examples = examplesFor(f.kind, f.examples ?? []);
  const tags = f.tags ?? [];
  const derived = derivedFields({
    kind: f.kind,
    hanzi: f.hanzi,
    turnKind: f.turnKind ?? null,
    heardAs: f.heardAs ?? null,
    askedCount: 1,
    usefulness: f.usefulness ?? null,
    tags,
    flags: f.flags ?? [],
  });
  const row: typeof phrase.$inferInsert = {
    id,
    status: f.status,
    kind: f.kind,
    hanzi: f.hanzi,
    hanziKey: derived.hanziKey,
    english: f.english,
    addressee: f.addressee ?? null,
    heardAs: f.heardAs ?? null,
    examples,
    note: f.note ?? null,
    tags,
    pinyin: computePinyin(f.hanzi),
    pinyinOverride: f.pinyinOverride ?? null,
    usefulness: f.usefulness ?? null,
    turnKind: f.turnKind ?? null,
    baseScore: derived.baseScore,
    pinned: f.pinned ?? false,
    pinnedAt: f.pinned ? now : null,
    source: f.source,
    sourceTurnId: f.sourceTurnId ?? null,
    askedCount: 1,
    lastAskedAt: now,
    flags: derived.flags,
    introducedAt: f.status === "active" ? now : null,
    droppedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const cards = cardTypes.map((type): typeof card.$inferInsert => ({
    id: newId(),
    phraseId: id,
    type,
    ...newCardColumns(now),
    createdAt: now,
  }));
  return { phrase: row, cards };
}

export async function findByKey(db: Db, key: string): Promise<Phrase | undefined> {
  return db.query.phrase.findFirst({ where: eq(phrase.hanziKey, key) });
}

export type SaveResult =
  | { ok: true; id: string; overrideDropped: boolean }
  | { ok: false; error: "duplicate"; existingId: string }
  | { ok: false; error: "not_found" };

/** Will adds a phrase by hand: `queued` and pinned, so it's next in line (DESIGN §4.8). */
export async function createManualPhrase(
  db: Db,
  input: PhraseInput,
  now: number,
): Promise<SaveResult> {
  const existing = await findByKey(db, hanziKey(input.hanzi));
  if (existing) return { ok: false, error: "duplicate", existingId: existing.id };

  const computed = computePinyin(input.hanzi);
  const rows = phraseRows(
    {
      status: "queued",
      kind: input.kind,
      hanzi: input.hanzi,
      english: input.english,
      addressee: input.addressee,
      heardAs: input.heardAs,
      examples: input.examples,
      note: input.note,
      tags: input.tags,
      pinned: true,
      source: "manual",
      pinyinOverride: input.pinyinEdits ? overrideFromEdits(computed, input.pinyinEdits) : null,
    },
    input.cardTypes,
    now,
  );
  await db.batch([db.insert(phrase).values(rows.phrase), db.insert(card).values(rows.cards)]);
  return { ok: true, id: rows.phrase.id, overrideDropped: false };
}

/**
 * Save the editor. Pinyin is recomputed; an override survives only if the hanzi is unchanged.
 * Card types toggled off are suspended (history kept), toggled on are created or resumed.
 */
export async function updatePhrase(
  db: Db,
  id: string,
  input: PhraseInput,
  now: number,
): Promise<SaveResult> {
  const prev = await getPhrase(db, id);
  if (!prev) return { ok: false, error: "not_found" };

  const key = hanziKey(input.hanzi);
  if (key !== prev.hanziKey) {
    const clash = await findByKey(db, key);
    if (clash && clash.id !== id) return { ok: false, error: "duplicate", existingId: clash.id };
  }

  const hanziChanged = input.hanzi !== prev.hanzi;
  const py = repinyin(prev, input.hanzi);
  const pinyinOverride =
    !hanziChanged && input.pinyinEdits
      ? overrideFromEdits(py.pinyin, input.pinyinEdits)
      : py.pinyinOverride;
  const derived = derivedFields({
    kind: input.kind,
    hanzi: input.hanzi,
    turnKind: prev.turnKind,
    heardAs: input.heardAs,
    askedCount: prev.askedCount,
    usefulness: prev.usefulness,
    tags: input.tags,
    flags: prev.flags,
  });

  const writes: BatchItem<"sqlite">[] = [
    db
      .update(phrase)
      .set({
        kind: input.kind,
        hanzi: input.hanzi,
        hanziKey: derived.hanziKey,
        english: input.english,
        addressee: input.addressee,
        heardAs: input.heardAs,
        examples: examplesFor(input.kind, input.examples),
        note: input.note,
        tags: input.tags,
        pinyin: py.pinyin,
        pinyinOverride,
        baseScore: derived.baseScore,
        flags: derived.flags,
        updatedAt: now,
      })
      .where(eq(phrase.id, id)),
  ];

  const wanted = new Set(input.cardTypes);
  for (const type of CARD_TYPES) {
    const existing = prev.cards.find((c) => c.type === type);
    if (wanted.has(type) && !existing) {
      writes.push(
        db
          .insert(card)
          .values({ id: newId(), phraseId: id, type, ...newCardColumns(now), createdAt: now }),
      );
    } else if (wanted.has(type) && existing?.suspendedAt) {
      writes.push(db.update(card).set({ suspendedAt: null }).where(eq(card.id, existing.id)));
    } else if (!wanted.has(type) && existing && !existing.suspendedAt) {
      writes.push(db.update(card).set({ suspendedAt: now }).where(eq(card.id, existing.id)));
    }
  }
  await runBatch(db, writes);
  return { ok: true, id, overrideDropped: hanziChanged && py.overrideDropped };
}

export async function getPhrase(db: Db, id: string): Promise<PhraseWithCards | undefined> {
  const p = await db.query.phrase.findFirst({ where: eq(phrase.id, id) });
  if (!p) return undefined;
  const cards = await db
    .select()
    .from(card)
    .where(eq(card.phraseId, id))
    .orderBy(asc(card.createdAt), desc(card.type));
  return { ...p, cards };
}

export type DropVia = "not_useful" | "remove" | "editor";

/**
 * Drop a phrase: it leaves the queue and its cards leave scheduling. Logs `phrase_dropped` with
 * what the ranking needs for tuning (DESIGN §7).
 */
export async function dropPhrase(db: Db, id: string, now: number, via: DropVia): Promise<boolean> {
  const p = await db.query.phrase.findFirst({ where: eq(phrase.id, id) });
  if (!p || p.status === "dropped") return false;
  await db.batch([
    db
      .update(phrase)
      .set({ status: "dropped", droppedAt: now, pinned: false, pinnedAt: null, updatedAt: now })
      .where(eq(phrase.id, id)),
    db.insert(event).values(
      eventRow(
        "phrase_dropped",
        {
          phrase_id: id,
          effective_score: effectiveScore(p, now),
          usefulness: p.usefulness,
          kind: p.kind,
          turn_kind: p.turnKind,
          status_before: p.status,
          via,
        },
        now,
      ),
    ),
  ]);
  return true;
}

/** Undo a drop from the editor: back to the queue (or active if it was ever introduced). */
export async function restorePhrase(db: Db, id: string, now: number): Promise<boolean> {
  const p = await db.query.phrase.findFirst({ where: eq(phrase.id, id) });
  if (!p || (p.status !== "dropped" && p.status !== "expired")) return false;
  await db
    .update(phrase)
    .set({ status: p.introducedAt ? "active" : "queued", droppedAt: null, updatedAt: now })
    .where(eq(phrase.id, id));
  return true;
}

/** Up next › Move to top: pin it (newest pin first). */
export async function pinPhrase(db: Db, id: string, now: number): Promise<boolean> {
  const res = await db
    .update(phrase)
    .set({ pinned: true, pinnedAt: now, updatedAt: now })
    .where(and(eq(phrase.id, id), eq(phrase.status, "queued")));
  return res.rowsAffected > 0;
}

export type QueueRow = Phrase & { effectiveScore: number; rank: number };

/** The ranked queue (DESIGN §4.6). */
export async function listQueue(db: Db, now: number): Promise<QueueRow[]> {
  const rows = await db.select().from(phrase).where(eq(phrase.status, "queued"));
  return orderQueue(rows, now);
}

export interface PhraseFilter {
  q?: string;
  kind?: PhraseKind;
  tag?: string;
  status?: PhraseStatus;
}

/** Phrases list: newest edits first, filtered by kind/tag/status and a free-text search. */
export async function listPhrases(db: Db, f: PhraseFilter = {}): Promise<Phrase[]> {
  const where = [];
  if (f.kind) where.push(eq(phrase.kind, f.kind));
  if (f.status) where.push(eq(phrase.status, f.status));
  else where.push(inArray(phrase.status, ["queued", "active"]));
  const rows = await db
    .select()
    .from(phrase)
    .where(and(...where))
    .orderBy(desc(phrase.updatedAt));
  const q = f.q?.trim().toLowerCase();
  const qKey = q ? hanziKey(q) : "";
  return rows.filter((p) => {
    if (f.tag && !p.tags.includes(f.tag)) return false;
    if (!q) return true;
    return (
      (qKey !== "" && p.hanziKey.includes(qKey)) ||
      p.english.toLowerCase().includes(q) ||
      (p.heardAs ?? "").toLowerCase().includes(q) ||
      p.pinyin.some(([, s]) => s !== null && s.includes(q))
    );
  });
}

/** Every tag in use, for the filter. */
export async function allTags(db: Db): Promise<string[]> {
  const rows = await db.select({ tags: phrase.tags }).from(phrase);
  return [...new Set(rows.flatMap((r) => r.tags))].sort();
}
