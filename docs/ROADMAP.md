# Bamboo — Roadmap

> Living document. Ideas discussed and deliberately deferred from the MVP. Before building one,
> check the Stats page (PRD §6): build what the data says is the bottleneck.

## Capture

- **Share-link import.** Fetch `share.gemini.google/...` pages server-side instead of a PDF. This
  is untested: the pages are probably rendered by JavaScript (needing a headless browser on the
  Mac), each link is a frozen snapshot, and the layout can change without notice. It would
  replace the PDF step only if it proves reliable.
- **Images in turns.** The PDF drops photos (a menu, a product label). If they matter, the
  worker could OCR them with the local VLM.

## Practice

- **Ask box.** A Bamboo page that answers "how do I say X to Y" with a capable LLM and saves
  automatically, so capture costs nothing. This needs either a cloud LLM (reopening the
  local-only decision) or a much stronger local model. It also only works if it's as fast as the
  Gemini app in the moment.
- **Scenario drills.** Short role-plays built from kept phrases ("the yuesao asks what to buy for
  soup"), done aloud.
- **Listening practice.** Short TTS clips of kept phrases strung together for a commute, or
  recordings of the yuesao and in-laws (with consent) attached to phrases.
- **Self-recording.** Record yourself on the Say back, then compare with the TTS.
- **Neural TTS.** Azure or Google voices for `zh-CN`/`zh-HK`, cached in R2, if the device voices
  grate. This is a cloud call, but not an LLM call.
- **Offline review.** Cache the day's cards in the service worker.

## Agent

- **OpenClaw skill pack.** A "quiz me" mode in Discord, and a nudge that mentions due phrases.
  The agent is a client of Bamboo's API (PandaBase's pattern: skill + tools CLI + scoped
  token).
- **Tutor that reuses what's due.** When helping Will say something new, prefer phrasing that
  reuses due or recently kept frames and words.

## People

- **Second learner** (spouse, Cantonese side): add a `user_id` to phrase, card and review data,
  plus a per-user allowlist.
- **Native-speaker check.** A way for his wife to review the `review_needed` items quickly.
