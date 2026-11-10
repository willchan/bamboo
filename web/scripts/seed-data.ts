// The synthetic seed (CLAUDE.md › Privacy: invented content only), shared by `pnpm db:seed`, the
// `dev:seeded` server, `pnpm --filter web shot` and the seeded e2e project. Relative to `now`, it
// leaves phrases in every state — new (queued), learning (introduced today, which also uses up
// today's new cards, so Today offers "Learn 3 more"), and review cards due now — plus finished
// rounds on past days (Stats), imports with turns, extraction events and one failed job (Imports),
// and a recent worker heartbeat. Idempotent: phrases already present (by hanzi key) are skipped,
// and the imports, rounds and events are only added to a database without imports.
import {
  card,
  event,
  imports,
  job,
  phrase,
  reviewLog,
  round,
  turn,
  type CardType,
  type Db,
  type PhraseKind,
  type TurnKind,
} from "@bamboo/db";
import { hanziKey } from "@bamboo/shared";
import { count, eq } from "drizzle-orm";
import { reviewCard, type FsrsColumns, type Grade } from "../lib/domain/fsrs";
import { initialCardTypes } from "../lib/domain/phrase";
import { eventRow, newId } from "../lib/repo/db";
import { findByKey, phraseRows } from "../lib/repo/phrases";

export interface Seed {
  kind: PhraseKind;
  hanzi: string;
  english: string;
  addressee?: string;
  heardAs?: string;
  examples?: { hanzi: string; english: string }[];
  tags: string[];
  turnKind: TurnKind;
  usefulness: number;
  /** Days ago it was introduced and reviewed (Good, Good); seeded as due now. */
  activeDaysAgo?: number;
  /** Introduced today (one Good, now on its learning step): uses up today's new cards. */
  learningToday?: boolean;
  extraCard?: CardType;
}

export const SEEDS: Seed[] = [
  {
    kind: "term",
    hanzi: "泡打粉",
    english: "baking powder",
    heardAs: "podafen",
    examples: [
      { hanzi: "做蛋糕要放一勺泡打粉。", english: "A cake needs a spoon of baking powder." },
    ],
    tags: ["food"],
    turnKind: "decode",
    usefulness: 4,
    activeDaysAgo: 9,
  },
  {
    kind: "term",
    hanzi: "高压锅",
    english: "pressure cooker",
    heardAs: "gaoyaguo",
    examples: [
      { hanzi: "用高压锅煮二十分钟。", english: "Cook it in the pressure cooker for 20 minutes." },
    ],
    tags: ["household", "food"],
    turnKind: "decode",
    usefulness: 4,
    activeDaysAgo: 6,
    extraCard: "say",
  },
  {
    kind: "term",
    hanzi: "辅食",
    english: "baby's solid food",
    examples: [
      { hanzi: "宝宝今天的辅食吃完了吗？", english: "Did the baby finish today's solids?" },
    ],
    tags: ["feeding", "baby"],
    turnKind: "say",
    usefulness: 5,
    activeDaysAgo: 12,
  },
  {
    kind: "term",
    hanzi: "围兜",
    english: "bib",
    examples: [
      { hanzi: "吃饭前给宝宝戴上围兜。", english: "Put the bib on the baby before eating." },
    ],
    tags: ["feeding", "baby"],
    turnKind: "say",
    usefulness: 4,
    learningToday: true,
  },
  {
    kind: "term",
    hanzi: "保鲜膜",
    english: "cling film",
    heardAs: "baoxianmo",
    examples: [{ hanzi: "剩菜用保鲜膜包好。", english: "Wrap the leftovers in cling film." }],
    tags: ["household", "groceries"],
    turnKind: "decode",
    usefulness: 3,
    learningToday: true,
  },
  {
    kind: "term",
    hanzi: "一勺",
    english: "one spoonful",
    tags: ["units", "food"],
    turnKind: "say",
    usefulness: 3,
  },
  {
    kind: "frame",
    hanzi: "阿姨，您是说…吗？",
    english: "Auntie, do you mean …?",
    addressee: "yuesao",
    tags: ["household"],
    turnKind: "say",
    usefulness: 5,
    activeDaysAgo: 5,
  },
  {
    kind: "frame",
    hanzi: "能不能帮我…？",
    english: "Could you help me …?",
    addressee: "anyone",
    tags: ["household"],
    turnKind: "say",
    usefulness: 4,
    learningToday: true,
  },
  {
    kind: "frame",
    hanzi: "…多少钱一斤？",
    english: "How much is … per jin?",
    addressee: "anyone",
    tags: ["groceries", "units"],
    turnKind: "errand",
    usefulness: 3,
  },
  {
    kind: "sentence",
    hanzi: "宝宝睡得很好。",
    english: "The baby slept well.",
    addressee: "yuesao",
    tags: ["baby"],
    turnKind: "say",
    usefulness: 4,
    activeDaysAgo: 8,
  },
  {
    kind: "sentence",
    hanzi: "我们得给宝宝洗澡了。",
    english: "We need to give the baby a bath now.",
    addressee: "nanny",
    tags: ["baby"],
    turnKind: "say",
    usefulness: 4,
  },
  {
    kind: "sentence",
    hanzi: "慢慢吃，别着急。",
    english: "Eat slowly, no rush.",
    addressee: "toddler",
    tags: ["toddler", "feeding"],
    turnKind: "say",
    usefulness: 5,
    activeDaysAgo: 4,
  },
  {
    kind: "sentence",
    hanzi: "该睡觉了。",
    english: "It's time to sleep.",
    addressee: "toddler",
    tags: ["toddler"],
    turnKind: "say",
    usefulness: 5,
  },
  {
    kind: "sentence",
    hanzi: "谢谢您，辛苦了！",
    english: "Thank you, you've worked so hard!",
    addressee: "yuesao",
    tags: ["household"],
    turnKind: "other",
    usefulness: 3,
  },
  {
    kind: "sentence",
    hanzi: "鸡蛋还有吗？",
    english: "Do we still have eggs?",
    addressee: "nanny",
    tags: ["groceries", "food"],
    turnKind: "errand",
    usefulness: 2,
  },
];

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Synthetic imports for the Imports page: titles and turns are invented. */
const IMPORTS = [
  {
    kind: "link" as const,
    title: "Kitchen words for the weekend",
    hoursAgo: 30,
    turns: [
      ["How do I say baking powder?", "泡打粉 (pào dǎ fěn) is baking powder."],
      ["What's a pressure cooker?", "高压锅 (gāo yā guō) is a pressure cooker."],
    ],
    phrasesNew: 2,
    phrasesAgain: 0,
  },
  {
    kind: "pdf" as const,
    title: "Bedtime phrases",
    hoursAgo: 6,
    turns: [
      ["How do I tell a toddler it's time to sleep?", "你可以说：该睡觉了。"],
      ["And 'eat slowly'?", "慢慢吃，别着急。"],
      ["How do I ask about the bath?", "我们得给宝宝洗澡了。"],
    ],
    phrasesNew: 2,
    phrasesAgain: 1,
    failedJob: true,
  },
  {
    kind: "text" as const,
    title: null,
    hoursAgo: 1,
    turns: [["How do I ask the price per jin?", "…多少钱一斤？"]],
    phrasesNew: 1,
    phrasesAgain: 0,
  },
];

async function seedPhrases(db: Db, now: number): Promise<number> {
  let added = 0;
  const roundDays = new Map<number, string>();
  for (const [i, s] of SEEDS.entries()) {
    if (await findByKey(db, hanziKey(s.hanzi))) continue;
    const active = Boolean(s.activeDaysAgo || s.learningToday);
    // Stagger creation so "newest" ordering is stable.
    const created = now - (SEEDS.length - i) * MIN - (s.activeDaysAgo ?? 0) * DAY;
    const types = initialCardTypes(s.kind, s.turnKind);
    if (s.extraCard && !types.includes(s.extraCard)) types.push(s.extraCard);
    const rows = phraseRows(
      {
        status: active ? "active" : "queued",
        kind: s.kind,
        hanzi: s.hanzi,
        english: s.english,
        addressee: s.addressee,
        heardAs: s.heardAs,
        examples: (s.examples ?? []).map((e) => ({ ...e, turn_id: null })),
        tags: s.tags,
        usefulness: s.usefulness,
        turnKind: s.turnKind,
        source: "import",
      },
      types,
      created,
    );
    await db.insert(phrase).values(rows.phrase);
    await db.insert(card).values(rows.cards);
    added += 1;
    if (!active) continue;

    // Introduced back then, in a finished round that day; or a couple of minutes ago, outside a
    // round (a finished round today would make Today "Done for today").
    const first = rows.cards[0]!;
    const at0 = s.learningToday ? now - 2 * MIN : created;
    let roundId: string | null = null;
    if (s.activeDaysAgo) {
      roundId = roundDays.get(s.activeDaysAgo) ?? null;
      if (!roundId) {
        roundId = newId();
        roundDays.set(s.activeDaysAgo, roundId);
        await db
          .insert(round)
          .values({ id: roundId, startedAt: at0 - MIN, finishedAt: at0 + 30 * MIN, cards: 2 });
      }
    }
    await db
      .insert(event)
      .values(
        eventRow(
          "phrase_introduced",
          { phrase_id: rows.phrase.id, rank: null, usefulness: s.usefulness, kind: s.kind },
          at0,
        ),
      );
    // Today's: one Good, so it's on its learning step. Older ones: Good, Good, and those from
    // 6+ days ago a review two days later (Again for the oldest, so Stats' retention isn't 100%
    // and one card is relearning); then due now.
    const days = s.activeDaysAgo ?? 0;
    const grades: Grade[] = s.learningToday ? [3] : days >= 6 ? [3, 3, days >= 12 ? 1 : 3] : [3, 3];
    let cols: FsrsColumns = { ...(first as unknown as FsrsColumns) };
    let at = at0;
    for (const grade of grades) {
      const r = await reviewCard(first.id, cols, grade, at);
      await db.insert(reviewLog).values({
        id: newId(),
        cardId: first.id,
        rating: grade,
        source: "session",
        stateBefore: cols.state,
        roundId,
        reviewedAt: at,
        durationMs: 5000,
        fsrsLog: r.log,
      });
      cols = r.next;
      at += grades.length === 3 && at > at0 ? 2 * DAY : 10 * MIN;
    }
    // Older ones are made due now-ish whatever interval FSRS chose, so a round has review cards.
    const due = s.learningToday ? cols.due : now - (i % 3) * 60 * MIN;
    await db
      .update(card)
      .set({ ...cols, due })
      .where(eq(card.id, first.id));
  }
  return added;
}

async function seedCapture(db: Db, now: number): Promise<void> {
  const [existing] = await db.select({ n: count() }).from(imports);
  if ((existing?.n ?? 0) > 0) return;
  for (const [n, imp] of IMPORTS.entries()) {
    const at = now - imp.hoursAgo * 60 * MIN;
    const importId = newId();
    await db.insert(imports).values({
      id: importId,
      kind: imp.kind,
      origin: imp.kind === "text" ? "web" : "discord",
      sourceRef:
        imp.kind === "link"
          ? "https://g.co/gemini/share/synthetic0"
          : imp.kind === "pdf"
            ? "bedtime.pdf"
            : null,
      conversationTitle: imp.title,
      turnsTotal: imp.turns.length,
      turnsNew: imp.turns.length,
      status: "done",
      jobsFailed: imp.failedJob ? 1 : 0,
      phrasesNew: imp.phrasesNew,
      phrasesAgain: imp.phrasesAgain,
      uploadedAt: at,
      createdAt: at,
      finishedAt: at + 2 * MIN,
    });
    for (const [pos, [userText, replyText]] of imp.turns.entries()) {
      const turnId = newId();
      const failed = imp.failedJob && pos === imp.turns.length - 1;
      await db.insert(turn).values({
        id: turnId,
        importId,
        turnKey: `seed-${n}-${pos}`,
        userText: userText!,
        replyText: replyText!,
        position: pos,
        kind: failed ? null : "say",
        extractedAt: failed ? null : at + MIN,
        createdAt: at,
      });
      const jobId = newId();
      await db.insert(job).values({
        id: jobId,
        type: "extract_turn",
        status: failed ? "failed" : "done",
        importId,
        input: { turn_id: turnId },
        attempt: failed ? 3 : 1,
        model: "qwen3.5:9b",
        promptVersion: "extract_turn.v1",
        error: failed ? "model returned invalid JSON" : null,
        createdAt: at,
        finishedAt: at + 2 * MIN,
      });
      if (!failed)
        await db
          .insert(event)
          .values(
            eventRow(
              "extraction",
              { turn_id: turnId, job_id: jobId, items: 2, dropped_not_verbatim: pos === 0 ? 1 : 0 },
              at + MIN,
            ),
          );
    }
  }
  await db.insert(event).values(eventRow("worker_heartbeat", {}, now - 5 * MIN));
}

/** Seed `db` (already migrated) relative to `now`. Returns how many phrases were added. */
export async function seedDb(db: Db, opts: { now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const added = await seedPhrases(db, now);
  await seedCapture(db, now);
  return added;
}
