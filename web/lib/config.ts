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

  /** Expiry (DESIGN §4.7; the cron arrives in M3). */
  queue: {
    expireBelow: -2,
    minAgeDays: 30,
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
