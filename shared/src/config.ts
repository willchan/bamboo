// Limits both sides of the API must agree on (CLAUDE.md: tunables live in config). The engine
// enforces them; the Mac side (bamboo-tools, worker) sizes its requests by them.
export const sharedConfig = {
  imports: {
    /** `POST /api/imports/known` accepts at most this many keys per call. */
    maxKnownKeys: 5000,
    /** `POST /api/imports` bodies above this many bytes are refused (413); the CLI chunks. */
    maxBodyBytes: 2 * 1024 * 1024,
  },
  extraction: {
    /** `ExtractTurnResult.items` holds at most this many items. */
    maxItems: 8,
    /** `english` is at most this long. */
    maxEnglishChars: 120,
  },
  /** PDF-text segmentation (DESIGN §5.2 *PDF*), on `pdftotext -layout` output. */
  segment: {
    /** A user line is indented at least this much (Will's bubbles are right-aligned). */
    userIndentMin: 20,
    /** The first line after a user block is a reply line, indented less than this. */
    replyIndentMax: 8,
    /**
     * Whole lines (after `normalizeText`) that are page furniture, not conversation. Tested
     * against the trimmed line.
     */
    boilerplate: [
      /^Sign in$/u,
      /^Gemini may display inaccurate info/u,
      /^Google Privacy Policy/u,
      /Privacy Policy\s*(?:Opens in a new window)?$/u,
      /^Your privacy (?:&|and) Gemini Apps/u,
      /^Answering .*standard$/u,
      /^Created with .*Published/u,
      /^https?:\/\/(?:gemini\.google\.com\/share|g\.co\/gemini\/share|share\.gemini\.google)\//u,
      /^Source: /u,
    ] as readonly RegExp[],
    /** The suggestion-chip block header; it and its chips are dropped. */
    exploreHeader: /^Explore related\b/u,
    /** The chip block ends at a run of this many blank lines (or a page break). */
    exploreGapBlankLines: 2,
    /**
     * Gemini's PDF font maps English ligatures to stray symbols (`Simpli!ed`, `bo#le`, `&akes`,
     * `o%en`). Will's prompts usually have no hanzi, so their turn keys are their letters: a
     * damaged prompt would key differently from the same prompt read from a share link. Repaired
     * only next to letters (DESIGN §5.2).
     */
    ligatures: { "!": "fi", "#": "tt", "&": "fl", "%": "ft" } as Readonly<Record<string, string>>,
  },
  /** bamboo-tools on the Mac (DESIGN §5.1, §5.2). */
  tools: {
    /** Per HTTP request (share page, RPC, engine API). */
    requestTimeoutMs: 30_000,
    /** Engine calls retry network errors, 5xx and 409 `conflict` this many times. */
    apiRetries: 2,
    /** Pause before a retry, times the attempt number. */
    apiRetryDelayMs: 1_000,
    /** Share links redirect once (share.gemini.google → gemini.google.com); allow a few. */
    maxRedirects: 5,
    /** Google sends more header bytes than Node's 16 KB default (M0 Notes). */
    maxHeaderBytes: 256 * 1024,
    /** `segment` prints this many prompts from each end, cut to `previewChars`. */
    previewPrompts: 5,
    previewChars: 60,
  },
  /** The Mac worker (DESIGN §1.2, §5.3, §8.3). Env vars override `defaults`. */
  worker: {
    defaults: {
      ollamaUrl: "http://localhost:11434",
      model: "qwen3.5:9b",
      pollIntervalSeconds: 15,
      /** `~` is the home of the account the worker runs as. `BAMBOO_WORKER_ENV` overrides it. */
      envFile: "~/.config/bamboo/worker.env",
    },
    /** Heartbeat at startup and this often (Today calls the worker offline after 25 min). */
    heartbeatMinutes: 10,
    /** While the model isn't pulled (or Ollama is down), re-check this often; no claims meanwhile. */
    modelRecheckSeconds: 60,
    /** Back-off after an engine error (network, 5xx): doubles from the poll interval up to this. */
    maxBackoffSeconds: 300,
    /** A `complete` that fails on the network is retried after these delays (the lease is 10 min). */
    completeRetrySeconds: [5, 20, 60],
    /** One HTTP call to the engine gives up after this long. */
    apiTimeoutSeconds: 30,
    /** One Ollama chat call gives up after this long (the first call may load the model). */
    ollamaTimeoutSeconds: 180,
    /**
     * Ollama request options (DESIGN §1.2). `num_ctx` matches PandaBase's setting for the same
     * model, so the two workers don't force a reload.
     */
    ollama: { think: false, temperature: 0, numCtx: 8192, keepAlive: "2m" },
    /**
     * The reply is cut to this many characters before it goes to the model, so prompt + reply
     * stay inside `numCtx` tokens. The engine checks verbatim against the whole turn either way.
     */
    maxReplyCharsForModel: 6000,
  },
  /**
   * The tutor evaluation (docs/ROADMAP.md › Tutor): `GET /api/agent/eval/turns` and
   * `bamboo-eval` on the Mac (agent/tools/src/eval/). Flags override `defaultModels` etc.
   */
  tutorEval: {
    defaultLimit: 20,
    maxLimit: 50,
    defaultSeed: "bamboo",
    maxSeedChars: 100,
    /** Replayed one at a time, in this order. */
    defaultModels: ["qwen3.5:9b", "qwen3.5:27b"],
    /** Keep the model loaded between questions; it's unloaded (`keep_alive: 0`) after its last. */
    keepAlive: "10m",
    /** Thinking off by default (as the worker); `--think` turns it on. Sampling: model defaults. */
    think: false,
    /** Same as the worker's, so the 9B isn't reloaded for a different context size. */
    numCtx: 8192,
    /** One answer gives up after this long (the 27B answers slowly on the 32 GB Mac). */
    answerTimeoutSeconds: 600,
    /** Loading a model (the warm-up call before timing answers) gives up after this long. */
    loadTimeoutSeconds: 600,
    /** Default output directory, under the home of the account it runs as; never the repo. */
    outRoot: "~/bamboo-eval",
    /** docs/PROMPTS.md holds the tutor system prompt between `<!-- <marker>:start/end -->`. */
    promptMarker: "tutor-eval-system-prompt",
  },
} as const;

/** The reminder appended to link-import replies (DESIGN §5.1); share links stay public. */
export const PUBLIC_LINK_NOTE =
  "🔗 This share link is public; you can delete it in Gemini → Settings → Public links.";

/** The skill's immediate reply when an import has no new turns (the engine never sends one). */
export const NOTHING_NEW = "✅ Nothing new since last time.";
