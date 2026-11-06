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
} as const;
