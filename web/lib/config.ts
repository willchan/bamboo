// Engine tunables (CLAUDE.md: no magic numbers in domain code). Domain functions take the slice
// they need as a parameter, defaulting to these values, so tests can vary them.

export interface SessionConfig {
  roundSize: number;
  newPerDay: number;
  extraNewBatch: number;
  newEvery: number;
  learnAheadMinutes: number;
  secondsPerCard: number;
}

export interface RankConfig {
  /** Frames have no weight: they're retired (DESIGN §10 #77). */
  kindWeight: Record<"term" | "sentence", number>;
  turnWeight: Record<"decode" | "say" | "errand" | "other", number>;
  heardAs: number;
  askedAgain: number;
  usefulnessPivot: number;
  usefulness: number;
  frequency: number;
  frequencyPivot: number;
  frequencyRange: number;
  householdTags: readonly string[];
  lengthFreeChars: number;
  lengthPenalty: number;
  weeklyDecay: number;
}

export interface FrequencyConfig {
  unknownZipf: number;
}

export interface ExtractionConfig {
  errandMaxItems: number;
  sayMaxTerms: number;
  promoteExampleSentence: boolean;
}

export interface NudgeConfig {
  defaultLocalTime: number;
  minRounds: number;
  lookbackDays: number;
  leadMinutes: number;
  earliestLocalTime: number;
  latestLocalTime: number;
}

/**
 * `BAMBOO_TEST_NEW_PER_DAY`: a smaller daily new-card limit for the e2e servers, whose tests and
 * seed are built around a cap they can use up in a few cards. Ignored in production builds.
 */
function testNewPerDay(): number | null {
  if (typeof process === "undefined" || process.env.NODE_ENV === "production") return null;
  const n = Number(process.env.BAMBOO_TEST_NEW_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const config = {
  /** ts-fsrs 6 `DefaultScheduler` options (DESIGN §4.3). FSRS-7, the library default model. */
  fsrs: {
    version: "FSRS-7",
    desiredRetention: 0.85,
    maximumInterval: 365,
    enableFuzz: true,
    enableShortTerm: true,
    learningSteps: ["1m", "10m"],
    relearningSteps: ["10m"],
    /** FSRS-7 may otherwise skip the learning steps above; keep them as designed. */
    allowModelOverride: false,
  },

  /** Household day and rounds (DESIGN §4.3–4.4). */
  day: {
    /** The day starts at 04:00 local: bedtime practice after midnight counts for the evening. */
    startHour: 4,
    defaultTimeZone: "America/Los_Angeles",
  },

  session: {
    roundSize: 10,
    /**
     * New cards a day: 30 since H2 (DESIGN §10 #79), Will's choice from the H2a FSRS estimate
     * (about a 3-week burst through the backlog, then intake-driven). Was 5 (§10 #64), 3 before.
     */
    newPerDay: testNewPerDay() ?? 30,
    /**
     * "Learn N more" (opt-in, once today's new cards are used up): a round may introduce this many
     * new cards beyond `newPerDay`. Each new card adds future reviews, so it's never automatic.
     */
    extraNewBatch: 3,
    /** One new card per this many cards in a round (DESIGN: "roughly one per 3"). */
    newEvery: 3,
    /** Learning cards due within this many minutes count as due now (Anki's "learn ahead"). */
    learnAheadMinutes: 20,
    /** Rough time per card, to decide whether an Again's learning step lands inside the round. */
    secondsPerCard: 15,
  } as SessionConfig,

  /**
   * Ranking (DESIGN §4.6). Rebalanced in the 2026-11 ranking review (DESIGN §10 #64); sentences
   * weigh like frames and aren't penalized for length until they're long (§10 #66).
   */
  rank: {
    kindWeight: { term: 1, sentence: 2 },
    turnWeight: { decode: 2, say: 1, errand: -3, other: -1 },
    heardAs: 1,
    askedAgain: 3,
    usefulnessPivot: 3,
    usefulness: 1.5,
    /** Points per Zipf unit above `frequencyPivot` (the phrase's rarest word, §4.6). */
    frequency: 1.5,
    /** Zipf 3.5 sits between ordinary (奶瓶, 3) and common (冰箱, 4). */
    frequencyPivot: 3.5,
    /** The Zipf difference is clamped to ±this before weighting. */
    frequencyRange: 2,
    /**
     * Baby and feeding words are rarer in subtitles and chat than in Will's home (拍嗝, 辅食), so
     * phrases with these tags don't lose points for rarity (they still gain for being common).
     */
    householdTags: ["feeding", "baby", "toddler"],
    /** Length is free up to `phrase.longChars` (20): only phrases flagged `long` lose points. */
    lengthFreeChars: 20,
    lengthPenalty: 0.2,
    /** `effective_score` loses this much per week since the phrase was last asked about. */
    weeklyDecay: 0.25,
  } as RankConfig,

  /** The frequency signal (DESIGN §4.6, `web/lib/domain/frequency.ts`). */
  frequency: {
    /** A word missing from the bundled list (Zipf < 2) counts as this rare. */
    unknownZipf: 1.5,
  } as FrequencyConfig,

  /**
   * Caps the engine applies to each extract_turn result (DESIGN §4.6 step 1), whatever the
   * prompt says: the model's order decides which items stay. Loosened in H4 (DESIGN §5.5.2,
   * §10 #76) from 1 and 2, which were set for the local model: decks Gemini made from the same
   * conversations showed Bamboo missing real words (PLAN H4 Notes).
   */
  extraction: {
    errandMaxItems: 3,
    sayMaxTerms: 5,
    /**
     * A say turn the model returned without a sentence gets one: the shortest example (with
     * English) of its kept terms, already verbatim-checked (§4.6, §10 #67).
     */
    promoteExampleSentence: true,
  } as ExtractionConfig,

  /** The extract_turn job queue (DESIGN §3.2, §5.3). */
  jobs: {
    leaseMinutes: 10,
    /** A job that fails this many attempts is `failed` (Retry failed on Imports requeues it). */
    maxAttempts: 3,
  },

  /** Imports (DESIGN §2.2, §5.1). */
  imports: {
    /** `turn.reply_text` is cut to this many characters (after the turn key is computed). */
    replyMaxChars: 12_000,
    /** "Next up: …" in an import's summary names this many of its queued phrases. */
    nextUpCount: 3,
    /**
     * Discord's message limit. A summary that would pass it names fewer Next-up phrases (each
     * with its pinyin) rather than dropping pinyin.
     */
    discordMaxChars: 2000,
    /** The Imports page lists this many recent imports. */
    recentCount: 20,
  },

  /** The evening reminder in `#bamboo` (DESIGN §4.9). Times are local minutes after midnight. */
  nudge: {
    /** Until there's enough history: 21:00. */
    defaultLocalTime: 21 * 60,
    /** The adaptive time needs at least this many practice days in the lookback window. */
    minRounds: 5,
    lookbackDays: 14,
    /** Remind this long before the median start time. */
    leadMinutes: 15,
    earliestLocalTime: 18 * 60,
    latestLocalTime: 23 * 60,
  } as NudgeConfig,

  /** The Stats page (DESIGN §7). */
  stats: {
    weeks: 4,
    /** PRD §6 targets, shown next to each measure. */
    habitDaysPerWeek: 5,
    retentionTarget: 0.8,
    notUsefulMax: 0.15,
    extractionDropMax: 0.05,
  },

  /** Telemetry retention (DESIGN §3.2 cron). */
  events: {
    retainDays: 180,
  },

  /** The Mac worker heartbeats every 10 min; Today calls it offline after this much silence. */
  worker: {
    offlineAfterMinutes: 25,
  },

  phrase: {
    maxExamples: 3,
    /** Flag `long` above this many key characters. */
    longChars: 20,
  },

  /** The review screen (DESIGN §6 *Review*). */
  review: {
    /** A grade that fails to save is retried this many times (backoff doubling from saveRetryMs). */
    saveRetries: 3,
    saveRetryMs: 1000,
    /**
     * The next card shows as soon as a grade is tapped; taps on it within this long don't reveal
     * it (a double tap on Good would otherwise show the next answer).
     */
    revealGuardMs: 400,
  },

  /** Stale pages and client error reports (DESIGN §6 *Saving*, §8.5). */
  client: {
    /** Reload at most once per this long for a newer deploy, so a mismatch can't loop. */
    reloadGuardMs: 60_000,
    /** `/api/client-log` lines per server instance per minute; the rest are dropped. */
    logPerMinute: 30,
  },

  /** Device TTS (DESIGN §6 *Audio*). */
  audio: {
    lang: "zh-CN",
    rate: 0.9,
    /**
     * Slow replay. iOS (WebKit → AVSpeechSynthesizer) compresses the rate range, so 0.6 sounded
     * almost like 0.9 there, and 0.45 was better but still not slow enough (DESIGN §6 *Audio*).
     */
    slowRate: 0.3,
    /** Voices whose names contain these sound best on iOS. */
    preferredVoiceHints: ["Enhanced", "Premium", "Tingting", "Ting-Ting"],
  },
} as const;

export type Config = typeof config;

/** `HOUSEHOLD_TZ`, defaulting to America/Los_Angeles. */
export function householdTimeZone(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.HOUSEHOLD_TZ || config.day.defaultTimeZone;
}
