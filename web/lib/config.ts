// Engine tunables (CLAUDE.md: no magic numbers in domain code). Domain functions take the slice
// they need as a parameter, defaulting to these values, so tests can vary them.

export interface SessionConfig {
  roundSize: number;
  newPerDay: number;
  newEvery: number;
  learnAheadMinutes: number;
  secondsPerCard: number;
}

export interface RankConfig {
  kindWeight: Record<"term" | "frame" | "sentence", number>;
  turnWeight: Record<"decode" | "say" | "errand" | "other", number>;
  heardAs: number;
  askedAgain: number;
  usefulnessPivot: number;
  usefulness: number;
  coreTags: readonly string[];
  coreTag: number;
  lengthFreeChars: number;
  lengthPenalty: number;
  weeklyDecay: number;
}

export interface NudgeConfig {
  defaultLocalTime: number;
  minRounds: number;
  lookbackDays: number;
  leadMinutes: number;
  earliestLocalTime: number;
  latestLocalTime: number;
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
    newPerDay: 3,
    /** One new card per this many cards in a round (DESIGN: "roughly one per 3"). */
    newEvery: 3,
    /** Learning cards due within this many minutes count as due now (Anki's "learn ahead"). */
    learnAheadMinutes: 20,
    /** Rough time per card, to decide whether an Again's learning step lands inside the round. */
    secondsPerCard: 15,
  } as SessionConfig,

  /** Ranking (DESIGN §4.6). */
  rank: {
    kindWeight: { term: 1, frame: 3, sentence: 1 },
    turnWeight: { decode: 3, say: 1, errand: -2, other: -1 },
    heardAs: 2,
    askedAgain: 3,
    usefulnessPivot: 3,
    usefulness: 1,
    coreTags: ["feeding", "baby", "food", "toddler", "units"],
    coreTag: 1,
    lengthFreeChars: 12,
    lengthPenalty: 0.2,
    /** `effective_score` loses this much per week since the phrase was last asked about. */
    weeklyDecay: 0.5,
  } as RankConfig,

  /** Expiry (DESIGN §4.7), run by the daily cron. */
  queue: {
    expireBelow: -2,
    minAgeDays: 30,
  },

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

  /** Device TTS (DESIGN §6 *Audio*). */
  audio: {
    lang: "zh-CN",
    rate: 0.9,
    slowRate: 0.6,
    /** Voices whose names contain these sound best on iOS. */
    preferredVoiceHints: ["Enhanced", "Premium", "Tingting", "Ting-Ting"],
  },
} as const;

export type Config = typeof config;

/** `HOUSEHOLD_TZ`, defaulting to America/Los_Angeles. */
export function householdTimeZone(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.HOUSEHOLD_TZ || config.day.defaultTimeZone;
}
