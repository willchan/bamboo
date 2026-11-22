// The synthetic seed (CLAUDE.md › Privacy: invented content only), shared by `pnpm db:seed`, the
// `dev:seeded` server, `pnpm --filter web shot` and the seeded e2e project. Relative to `now`, it
// leaves phrases in every state — new (queued), retired frames (dropped), learning (five introduced today, which uses up
// today's `newPerDay` new cards, so Today offers "Learn 3 more"), and review cards due now — plus finished
// rounds on past days (Stats), imports with turns, extraction events and one failed job (Imports;
// the newest import was read with a newer prompt, so it offers a re-run), and a recent worker
// heartbeat, and two learning phrases a re-run no longer picks (H6). Idempotent: phrases already present (by hanzi key) are skipped,
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
import { hanziKey, type PhraseBreakdown } from "@bamboo/shared";
import { count, eq } from "drizzle-orm";
import { checkBreakdown } from "../lib/domain/breakdown";
import { reviewCard, type FsrsColumns, type Grade } from "../lib/domain/fsrs";
import { initialCardTypes } from "../lib/domain/phrase";
import { mergedPinyin, settleExample } from "../lib/domain/pinyin";
import { eventRow, newId } from "../lib/repo/db";
import { findByKey, phraseRows } from "../lib/repo/phrases";

export interface Seed {
  kind: PhraseKind;
  hanzi: string;
  english: string;
  note?: string;
  heardAs?: string;
  /**
   * `merge`: Gemini's reading of the example and the referee's answers (extract_turn.v8, §10 #107),
   * stored merged; without it the example has no stored pinyin, like one from before v8.
   */
  examples?: {
    hanzi: string;
    english: string;
    merge?: { gemini: string[]; referee: Record<number, string> };
  }[];
  /** A synthetic card-back breakdown (DESIGN §5.5.4); must match the hanzi (`checkBreakdown`). */
  breakdown?: PhraseBreakdown;
  tags: string[];
  turnKind: TurnKind;
  usefulness: number;
  /** Days ago it was introduced and reviewed (Good, Good); seeded as due now. */
  activeDaysAgo?: number;
  /** Introduced today (one Again, now on its learning step): uses up today's new cards. */
  learningToday?: boolean;
  extraCard?: CardType;
  /** A frame retired by H2b's migration (DESIGN §10 #77): `dropped`, never scheduled. */
  retired?: boolean;
  /** H6: a re-run no longer picks it (`unpicked_at`), for Phrases › No longer picked. */
  unpicked?: boolean;
  /** Gemini's reading and the referee's answers (§5.5.3b), merged into the stored pinyin. */
  merge?: { gemini: string[]; referee: Record<number, string> };
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
      { hanzi: "辅食要做得软一点。", english: "Make the solids a bit softer." },
      // A rewording of the first, as older copied examples often were: the card shows one (§10 #103).
      {
        hanzi: "宝宝今天的辅食都吃完了没有？",
        english: "Has the baby eaten all of today's solids?",
      },
    ],
    breakdown: {
      parts: [
        { hanzi: "辅", gloss: "supplementary, assist" },
        { hanzi: "食", gloss: "food, eat" },
      ],
      meaning: "food added alongside milk: a baby's first solids",
    },
    tags: ["feeding", "baby"],
    turnKind: "say",
    usefulness: 5,
    activeDaysAgo: 12,
  },
  {
    kind: "term",
    hanzi: "倒过来",
    english: "turn upside down",
    // The dictionary reads 倒 dǎo; the referee settles on dào, and the example follows (§10 #106).
    merge: { gemini: ["dào", "guò", "lái"], referee: { 0: "dào" } },
    examples: [
      { hanzi: "别把杯子倒过来。", english: "Don't turn the cup upside down." },
      // §10 #107: the example's own merge settles 得 on děi (the dictionary reads dé).
      {
        hanzi: "我得把它倒过来。",
        english: "I have to turn it upside down.",
        merge: {
          gemini: ["wǒ", "děi", "bǎ", "tā", "dào", "guò", "lái"],
          referee: { 1: "děi", 4: "dào" },
        },
      },
    ],
    // A breakdown, so the card back shows every example, not only the first (§6).
    breakdown: {
      parts: [
        { hanzi: "倒", gloss: "upside down" },
        { hanzi: "过", gloss: "over" },
        { hanzi: "来", gloss: "come" },
      ],
      meaning: "Flip something over so its top faces down.",
    },
    tags: ["household"],
    turnKind: "say",
    usefulness: 4,
    activeDaysAgo: 9,
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
    hanzi: "奶瓶",
    english: "baby bottle",
    examples: [{ hanzi: "奶瓶洗好了吗？", english: "Is the bottle washed?" }],
    tags: ["feeding", "baby"],
    turnKind: "say",
    usefulness: 4,
    learningToday: true,
  },
  {
    kind: "sentence",
    hanzi: "宝宝喝完奶了。",
    english: "The baby finished the milk.",
    breakdown: {
      parts: [
        { hanzi: "宝宝", gloss: "baby" },
        { hanzi: "喝完", gloss: "drink + finish" },
        { hanzi: "奶", gloss: "milk" },
        { hanzi: "了", gloss: "(done, a change)" },
      ],
      note: "Verb + 'finish' says the drinking is done; the final particle marks the new situation.",
    },
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
    tags: ["household"],
    turnKind: "say",
    usefulness: 5,
    retired: true,
  },
  {
    kind: "sentence",
    hanzi: "能不能帮我拿一下？",
    english: "Could you hand it to me?",
    tags: ["household"],
    turnKind: "say",
    usefulness: 4,
    learningToday: true,
  },
  {
    kind: "frame",
    hanzi: "…多少钱一斤？",
    english: "How much is … per jin?",
    tags: ["groceries", "units"],
    turnKind: "errand",
    usefulness: 3,
    retired: true,
  },
  {
    kind: "sentence",
    hanzi: "西红柿多少钱一斤？",
    english: "How much are tomatoes per jin?",
    tags: ["groceries", "units"],
    turnKind: "errand",
    usefulness: 3,
  },
  {
    kind: "sentence",
    hanzi: "宝宝睡得很好。",
    english: "The baby slept well.",
    tags: ["baby"],
    turnKind: "say",
    usefulness: 4,
    activeDaysAgo: 8,
    unpicked: true,
  },
  {
    kind: "sentence",
    hanzi: "我们得给宝宝洗澡了。",
    english: "We need to give the baby a bath now.",
    tags: ["baby"],
    turnKind: "say",
    usefulness: 4,
  },
  {
    kind: "sentence",
    hanzi: "慢慢吃，别着急。",
    english: "Eat slowly, no rush.",
    tags: ["toddler", "feeding"],
    turnKind: "say",
    usefulness: 5,
    activeDaysAgo: 4,
    unpicked: true,
  },
  {
    kind: "sentence",
    hanzi: "该睡觉了。",
    english: "It's time to sleep.",
    tags: ["toddler"],
    turnKind: "say",
    usefulness: 5,
  },
  {
    kind: "sentence",
    hanzi: "谢谢您，辛苦了！",
    english: "Thank you, you've worked so hard!",
    note: "Polite, to an adult",
    tags: ["household"],
    turnKind: "other",
    usefulness: 3,
  },
  {
    kind: "sentence",
    hanzi: "鸡蛋还有吗？",
    english: "Do we still have eggs?",
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
    // H5: a question asked in #bamboo and the tutor's answer.
    kind: "tutor" as const,
    title: null,
    hoursAgo: 3,
    turns: [
      [
        "How do I tell the nanny the baby is gassy?",
        "你可以说：阿姨，宝宝好像胀气了。 (Ā yí, bǎo bao hǎo xiàng zhàng qì le.)",
      ],
    ],
    phrasesNew: 1,
    phrasesAgain: 0,
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

function mergedFields(hanzi: string, m: NonNullable<Seed["merge"]>) {
  const referee = new Map(Object.entries(m.referee).map(([i, r]) => [Number(i), r]));
  const { pinyin, pinyinSources } = mergedPinyin(hanzi, m.gemini, referee, { final: true });
  return { pinyin, pinyinSources };
}

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
        status: s.retired ? "dropped" : active ? "active" : "queued",
        kind: s.kind,
        hanzi: s.hanzi,
        english: s.english,
        note: s.note,
        heardAs: s.heardAs,
        examples: (s.examples ?? []).map(({ merge, ...e }) => {
          const ex = { ...e, turn_id: null };
          if (!merge) return ex;
          const referee = new Map(Object.entries(merge.referee).map(([i, r]) => [Number(i), r]));
          return settleExample(ex, merge.gemini, referee, { final: true });
        }),
        breakdown: s.breakdown ? checkBreakdown(s.kind, s.hanzi, s.breakdown).breakdown : null,
        ...(s.merge ? mergedFields(s.hanzi, s.merge) : {}),
        tags: s.tags,
        usefulness: s.usefulness,
        turnKind: s.turnKind,
        source: "import",
      },
      types,
      created,
    );
    await db.insert(phrase).values({
      ...rows.phrase,
      ...(s.retired ? { droppedAt: created } : {}),
      ...(s.unpicked ? { unpickedAt: now - DAY } : {}),
    });
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
    // Today's: one Again, so it's on its learning step (Good graduates since DESIGN §10 #102). Older ones: Good, Good, and those from
    // 6+ days ago a review two days later (Again for the oldest, so Stats' retention isn't 100%
    // and one card is relearning); then due now.
    const days = s.activeDaysAgo ?? 0;
    const grades: Grade[] = s.learningToday ? [1] : days >= 6 ? [3, 3, days >= 12 ? 1 : 3] : [3, 3];
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
  // The newest import was read with a newer prompt, so Imports offers to re-run the older ones.
  const newest = Math.min(...IMPORTS.map((i) => i.hoursAgo));
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
            : imp.kind === "tutor"
              ? "tutor.v1"
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
        promptVersion: imp.hoursAgo === newest ? "extract_turn.v3" : "extract_turn.v1",
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
