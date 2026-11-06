// `pnpm db:seed`: synthetic phrases for local dev (CLAUDE.md › Privacy: invented content only).
// Idempotent: phrases already present (by hanzi key) are skipped. Refuses anything but a local
// database, so it can never touch Turso.
import {
  card,
  createDb,
  databaseUrlFromEnv,
  migrateDb,
  phrase,
  reviewLog,
  type CardType,
  type PhraseKind,
  type TurnKind,
} from "@bamboo/db";
import { hanziKey } from "@bamboo/shared";
import { eq } from "drizzle-orm";
import { reviewCard, type FsrsColumns, type Grade } from "../lib/domain/fsrs";
import { initialCardTypes } from "../lib/domain/phrase";
import { newId } from "../lib/repo/db";
import { findByKey, phraseRows } from "../lib/repo/phrases";

interface Seed {
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
  extraCard?: CardType;
}

const SEEDS: Seed[] = [
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

const DAY = 24 * 60 * 60 * 1000;

const url = databaseUrlFromEnv();
if (!url.startsWith("file:") && url !== ":memory:") {
  console.error(
    "db:seed only seeds a local database (file:…); TURSO_DATABASE_URL points elsewhere.",
  );
  process.exit(1);
}

const db = createDb({ url });
await migrateDb(db);
const now = Date.now();
let added = 0;

for (const [i, s] of SEEDS.entries()) {
  if (await findByKey(db, hanziKey(s.hanzi))) continue;
  // Stagger creation so "newest" ordering is stable.
  const created = now - (SEEDS.length - i) * 60_000 - (s.activeDaysAgo ?? 0) * DAY;
  const types = initialCardTypes(s.kind, s.turnKind);
  if (s.extraCard && !types.includes(s.extraCard)) types.push(s.extraCard);
  const rows = phraseRows(
    {
      status: s.activeDaysAgo ? "active" : "queued",
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

  if (s.activeDaysAgo) {
    // Review the first card twice (Good, Good) back then, so it's a review card now.
    const first = rows.cards[0]!;
    let cols: FsrsColumns = { ...(first as unknown as FsrsColumns) };
    let at = created;
    for (const grade of [3, 3] as Grade[]) {
      const r = await reviewCard(first.id, cols, grade, at);
      await db.insert(reviewLog).values({
        id: newId(),
        cardId: first.id,
        rating: grade,
        source: "session",
        stateBefore: cols.state,
        reviewedAt: at,
        durationMs: 5000,
        fsrsLog: r.log,
      });
      cols = r.next;
      at += 10 * 60_000;
    }
    // Make it due now-ish whatever interval FSRS chose, so a dev round has review cards in it.
    await db
      .update(card)
      .set({ ...cols, due: now - (i % 3) * 60 * 60_000 })
      .where(eq(card.id, first.id));
  }
  added += 1;
}

console.log(
  `seeded ${added} synthetic phrases (${SEEDS.length - added} already there) into ${url}`,
);
db.$client.close();
