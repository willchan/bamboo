# Bamboo — Roadmap

> Living document. Ideas discussed and deliberately deferred from the MVP. Before building one,
> check the Stats page (PRD §6): build what the data says is the bottleneck.

## Tutor

- **Local tutor evaluation.** Replay ~20 of Will's real past questions (from the `turn` table)
  through local models, e.g. the current 9B and a ~30B-class model that fits the 32GB Mac
  alongside PandaBase. Compare their answers with Gemini's on decoding accuracy, naturalness and
  latency. Will judges blind. If a local model is good enough, a Bamboo "Ask" page (with
  automatic capture) becomes viable without breaking the local-only rule. **The harness exists**
  (`bamboo-eval`, DESIGN §5.4): on the Mac as `openclaw-agent`, `make tutor-eval ARGS="run"`
  replays a seeded sample through `qwen3.5:9b` and `qwen3.8:27b` (the defaults),
  `ARGS="serve --out <dir> --host <tailscale ip>"` puts the blind judging page on Will's iPhone,
  and `ARGS="score --out <dir>"` prints the per-model table. Outputs stay in `~/bamboo-eval/`.
  **Result (2026-11-06, `qwen3.5:9b` and `qwen3.5:27b`):** Will judged both local models blind
  against Gemini Flash. One was much worse; the other was closer, but Gemini Flash was still clearly better. Decision: keep asking
  Gemini (and sharing conversations by public link); no local tutor or "Ask" page yet (DESIGN §10
  #58). Re-run the evaluation when a clearly stronger local model fits the Mac; `qwen3.8:27b`, now
  OpenClaw's reply model, is the next candidate.
- **Tutor that reuses what's due.** When answering "how do I say X", prefer phrasing that
  reuses due or recently introduced frames and words.

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
- **Instant `#bamboo` replies without a model.** Today the channel's OpenClaw agent runs
  `qwen3.8:27b`, which cold-loads after idle (and after a worker job swaps in the 9B), so a reply
  can take ~35–70 s (measured with `qwen3.5:27b`). Will accepts that for
  now. Option: an OpenClaw plugin (or similar deterministic handler) that recognises a share link
  or PDF in `#bamboo` and calls `bamboo-tools` directly, so no LLM is in the path and replies are
  near-instant. Deferred, not planned.
- **Reminder to clear old share links.** Gemini share links are public URLs, and Will means to
  delete them now and then. Bamboo could occasionally remind him (in the evening `#bamboo`
  message, or on Today) to delete share links that have already been imported. Deferred.

## Languages and people

- **Cantonese** (for the in-laws): add a `lang` column (default `cmn`; dedupe on
  `(lang, hanzi_key)`), Jyutping via `to-jyutping`, a `zh-HK` voice, and spoken-Cantonese
  extraction rules. Content must be checked by a native speaker; local models write Cantonese
  poorly.
- **Second learner** (spouse): add `user_id` to phrase, card and review data, plus a per-user
  allowlist.

## Capture

- **Images in conversations.** PDFs drop photos (a menu, a product label). If they matter, OCR
  them with the local vision model PandaBase already uses.
