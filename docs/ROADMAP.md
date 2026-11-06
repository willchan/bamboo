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
  replays a seeded sample through `qwen3.5:9b` and `qwen3.5:27b`, `ARGS="serve --out <dir> --host
  <tailscale ip>"` puts the blind judging page on Will's iPhone, and `ARGS="score --out <dir>"`
  prints the per-model table. Outputs stay in `~/bamboo-eval/`. Results: not yet run.
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
