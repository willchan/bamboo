# Bamboo — Roadmap

> Living document. Ideas discussed and deliberately deferred from the MVP. Before building one,
> check the Stats page (PRD §6): build what the data says is the bottleneck.

## Tutor

- **Tutor: no longer deferred.** The local tutor evaluation (`bamboo-eval`, DESIGN §5.4) found
  Gemini Flash clearly better than every local model tried (2026-11-06 blind by Will; 2026-11-14
  with `qwen3.8:27b`, no better; DESIGN §10 #58). So, reversing the local-only rule (DESIGN §10
  #74), the tutor is now the `#bamboo` OpenClaw agent on Gemini Flash, and every question asked
  there is captured as a Bamboo turn with no share link. It's planned work: docs/PLAN.md ›
  *Hybrid H1–H7* (H5). The harness stays (`make tutor-eval`) in case a local model ever becomes
  good enough to serve as more than the fallback extractor.
- **Tutor that reuses what's due.** When answering "how do I say X", prefer phrasing that
  reuses due or recently introduced words and sentences. Easier now that the tutor is Bamboo's
  own agent, but still deferred (it would send phrase history to Gemini, which DESIGN §5.5.8
  rules out today).

## Practice

- **"Use it" cards.** Prompt: "say a sentence with 泡打粉". The answer is checked against the
  examples. Do this if term cards prove too passive.
- **Scenario drills.** Short role-plays built from active phrases ("the yuesao asks what to buy
  for soup"), done aloud.
- **Listening.** Strings of TTS clips for a commute, or recordings of the yuesao (with consent)
  attached to phrases.
- **Self-recording.** Record yourself on the Say back, then compare with the TTS.
- **Neural TTS.** Azure or Google `zh-CN` voices, cached, if the device voice grates. This is a
  cloud call, but not an LLM call.
- **Offline review.** Cache the day's round in a service worker.
- **"Used it for real".** Dropped because Will wouldn't tap it. Revisit only if a passive signal
  appears.

## Agent

- **Quiz mode in Discord.** "Quiz me": a few Say cards as messages, graded with reactions; the
  results go to Bamboo as reviews.
- **Instant `#bamboo` replies without a model.** Until H5 moves the channel's agent to Gemini
  Flash, it runs `qwen3.8:27b`, which cold-loads after 30 min idle, so a reply
  can take ~35–70 s (measured with `qwen3.5:27b`). Will accepts that for
  now; on Gemini it may stop mattering. A deterministic handler would cover links and PDFs only:
  questions need the tutor model. Option: an OpenClaw plugin (or similar deterministic handler) that recognises a share link
  or PDF in `#bamboo` and calls `bamboo-tools` directly, so no LLM is in the path and replies are
  near-instant. Deferred, not planned.
- **Reminder to clear old share links.** Gemini share links are public URLs, and Will means to
  delete them now and then. Bamboo could occasionally remind him (in the evening `#bamboo`
  message, or on Today) to delete share links that have already been imported. Deferred.

## Languages and people

- **Cantonese** (for the in-laws): add a `lang` column (default `cmn`; dedupe on
  `(lang, hanzi_key)`), Jyutping via `to-jyutping`, a `zh-HK` voice, and spoken-Cantonese
  extraction rules. Content must be checked by a native speaker; local models write Cantonese
  poorly (Gemini, the extractor since DESIGN §10 #74, is untested on it).
- **Second learner** (spouse): add `user_id` to phrase, card and review data, plus a per-user
  allowlist.

## Capture

- **Images in conversations.** PDFs drop photos (a menu, a product label). If they matter, OCR
  them with the local vision model PandaBase already uses. (A photo asked about in `#bamboo`
  after H5 is the tutor's to answer; capturing it as a turn is not planned.)
- **Frames.** Removed in 2026-11 (DESIGN §10 #77). Revisit only if Will finds he misses reusable
  patterns.
