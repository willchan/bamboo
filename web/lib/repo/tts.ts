// Neural TTS clips (DESIGN §6.1): what a card part says (the card's own displayed pinyin), the
// stored clip for it, warming a round's clips after it starts, and the daily prune.
import { card, event, phrase, round, ttsClip, type Db, type Phrase } from "@bamboo/db";
import { eq, inArray, lt, sql } from "drizzle-orm";
import { config } from "../config";
import { displayPinyin, examplePinyin, type PinyinPairs } from "../domain/pinyin";
import { distinctExamples, isLearnableExample } from "../domain/queue";
import { clipKey, clipUrl, parsePart, speechSsml, ssmlChars, type SpeechPart } from "../domain/tts";
import { azureSpeech, synthesize, type AzureSpeech } from "../tts-azure";
import { eventRow } from "./db";

const DAY = 86_400_000;

export interface SpeechExample {
  hanzi: string;
  english: string | null;
  pinyin: PinyinPairs;
}

/**
 * A phrase's displayed pinyin and its shown examples. The card back and the audio both come from
 * this, so the audio says what the card shows (§6.1 *What's pinned*).
 */
export function phraseSpeech(p: Pick<Phrase, "hanzi" | "pinyin" | "pinyinOverride" | "examples">) {
  const pinyin = displayPinyin(p.pinyin, p.pinyinOverride);
  // Older phrases may hold a romanized example, or several rewording one another, from before
  // the extraction checks (§4.6 step 3, §10 #103).
  const examples: SpeechExample[] = distinctExamples(
    p.examples.filter((e) => isLearnableExample(e.hanzi)),
    p.hanzi,
  ).map((e) => ({
    hanzi: e.hanzi,
    english: e.english,
    // Its stored, merged reading when it has one (§10 #107), with the phrase's settled reading on top.
    pinyin: examplePinyin(e, p.hanzi, pinyin),
  }));
  return { pinyin, examples };
}

export type PhraseSpeech = ReturnType<typeof phraseSpeech>;

function pairsFor(speech: PhraseSpeech, part: SpeechPart): PinyinPairs | null {
  if (part.kind === "phrase") return speech.pinyin;
  return speech.examples[part.index]?.pinyin ?? null;
}

function clipOf(pairs: PinyinPairs) {
  const voice = config.audio.neural.voice;
  const ssml = speechSsml(pairs, { voice });
  return { ssml, key: clipKey(voice, ssml) };
}

export interface ClipUrls {
  phrase: string | null;
  examples: (string | null)[];
}

/** The round payload's clip URLs; all null while neural TTS is off (the PWA uses Web Speech). */
export function clipUrls(phraseId: string, speech: PhraseSpeech, enabled: boolean): ClipUrls {
  if (!enabled) return { phrase: null, examples: speech.examples.map(() => null) };
  return {
    phrase: clipUrl(phraseId, { kind: "phrase" }, clipOf(speech.pinyin).key),
    examples: speech.examples.map((e, index) =>
      clipUrl(phraseId, { kind: "example", index }, clipOf(e.pinyin).key),
    ),
  };
}

export const neuralEnabled = (env = process.env): boolean => azureSpeech(env) !== null;

export interface TtsDeps {
  service?: AzureSpeech | null;
  fetchImpl?: typeof fetch;
}

export type ClipResult =
  | { status: "ok"; audio: Buffer; key: string }
  | { status: "off" }
  | { status: "not_found" }
  | { status: "failed"; upstream: number };

/**
 * The clip for `GET /api/tts/{phraseId}/{part}`: the stored one for the part's current SSML, else
 * synthesized (one request, no retry), stored and returned. A failure is the caller's cue to
 * answer with an error, so the PWA speaks with Web Speech.
 */
export async function getClip(
  db: Db,
  phraseId: string,
  partName: string,
  now: number,
  deps: TtsDeps = {},
): Promise<ClipResult> {
  const service = deps.service === undefined ? azureSpeech() : deps.service;
  if (!service) return { status: "off" };
  const part = parsePart(partName);
  if (!part) return { status: "not_found" };
  const [p] = await db.select().from(phrase).where(eq(phrase.id, phraseId));
  if (!p) return { status: "not_found" };
  const pairs = pairsFor(phraseSpeech(p), part);
  if (!pairs) return { status: "not_found" };
  const { ssml, key } = clipOf(pairs);

  const [stored] = await db
    .select({ audio: ttsClip.audio })
    .from(ttsClip)
    .where(eq(ttsClip.key, key));
  if (stored) {
    await db.update(ttsClip).set({ lastPlayedAt: now }).where(eq(ttsClip.key, key));
    return { status: "ok", audio: Buffer.from(stored.audio), key };
  }

  const r = await synthesize(service, ssml, deps.fetchImpl);
  await store(db, key, ssml, r, now, false, now);
  return r.ok ? { status: "ok", audio: r.audio, key } : { status: "failed", upstream: r.status };
}

/** Save a made clip and its `tts_synth` event (counts only, §7). */
async function store(
  db: Db,
  key: string,
  ssml: string,
  r: Awaited<ReturnType<typeof synthesize>>,
  now: number,
  warm: boolean,
  playedAt: number | null,
) {
  const chars = ssmlChars(ssml);
  const ev = db
    .insert(event)
    .values(
      eventRow(
        "tts_synth",
        { chars, ms: r.ms, ok: r.ok, warm, ...(r.ok ? {} : { status: r.status }) },
        now,
      ),
    );
  if (!r.ok) {
    await ev;
    return;
  }
  await db.batch([
    db
      .insert(ttsClip)
      .values({ key, audio: r.audio, chars, createdAt: now, lastPlayedAt: playedAt })
      .onConflictDoNothing(),
    ev,
  ]);
}

export interface WarmDeps extends TtsDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock for pacing and the budget (tests pass a fake). */
  clock?: () => number;
}

export interface WarmResult {
  made: number;
  failed: number;
  /** Not tried: the budget ran out. They're made when first played. */
  left: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Make a round's missing clips ahead of play (run in `after()` once the round is stored): every
 * card's phrase first, in round order, then examples. Paced one request per
 * `config.audio.neural.paceMs`; a 429 waits `throttleWaitMs` and tries again (F0's limit, T1).
 * Stops after `warmBudgetMs`. Never throws.
 */
export async function warmRound(
  db: Db,
  roundId: string,
  now: number,
  deps: WarmDeps = {},
): Promise<WarmResult> {
  const out: WarmResult = { made: 0, failed: 0, left: 0 };
  const service = deps.service === undefined ? azureSpeech() : deps.service;
  if (!service) return out;
  const n = config.audio.neural;
  const sleep = deps.sleep ?? realSleep;
  const wall = deps.clock ?? Date.now;
  try {
    const [r] = await db
      .select({ cardIds: round.cardIds })
      .from(round)
      .where(eq(round.id, roundId));
    if (!r || r.cardIds.length === 0) return out;
    const rows = await db
      .select({ cardId: card.id, phrase })
      .from(card)
      .innerJoin(phrase, eq(card.phraseId, phrase.id))
      .where(inArray(card.id, r.cardIds));
    const byCard = new Map(rows.map((x) => [x.cardId, x.phrase]));
    const seen = new Set<string>();
    const phrases: Phrase[] = [];
    for (const id of r.cardIds) {
      const p = byCard.get(id);
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        phrases.push(p);
      }
    }
    const speeches = phrases.map(phraseSpeech);
    const wanted = new Map<string, string>(); // key → ssml, phrases first
    for (const s of speeches) {
      const c = clipOf(s.pinyin);
      wanted.set(c.key, c.ssml);
    }
    for (const s of speeches) {
      for (const e of s.examples) {
        const c = clipOf(e.pinyin);
        if (!wanted.has(c.key)) wanted.set(c.key, c.ssml);
      }
    }
    const have = new Set(
      (
        await db
          .select({ key: ttsClip.key })
          .from(ttsClip)
          .where(inArray(ttsClip.key, [...wanted.keys()]))
      ).map((x) => x.key),
    );
    const todo = [...wanted].filter(([key]) => !have.has(key));
    const deadline = wall() + n.warmBudgetMs;
    let last = -Infinity;
    for (let i = 0; i < todo.length; i++) {
      const [key, ssml] = todo[i]!;
      let res: Awaited<ReturnType<typeof synthesize>> | null = null;
      for (let attempt = 0; attempt <= n.throttleRetries; attempt++) {
        const wait = Math.max(0, last + n.paceMs - wall());
        if (wall() + wait >= deadline) break;
        if (wait > 0) await sleep(wait);
        last = wall();
        res = await synthesize(service, ssml, deps.fetchImpl);
        if (res.ok || res.status !== 429 || attempt === n.throttleRetries) break;
        if (wall() + n.throttleWaitMs >= deadline) break;
        await sleep(n.throttleWaitMs);
      }
      if (!res) {
        out.left = todo.length - i;
        break;
      }
      await store(db, key, ssml, res, now, true, null);
      if (res.ok) out.made++;
      else out.failed++;
    }
  } catch {
    // Best effort: a clip that wasn't warmed is made when first played.
  }
  return out;
}

/** The daily cron: delete clips not played (or, never played, not made) for `retainDays`. */
export async function pruneClips(db: Db, now: number): Promise<number> {
  const cutoff = now - config.audio.neural.retainDays * DAY;
  const r = await db
    .delete(ttsClip)
    .where(lt(sql`coalesce(${ttsClip.lastPlayedAt}, ${ttsClip.createdAt})`, cutoff));
  return r.rowsAffected;
}
