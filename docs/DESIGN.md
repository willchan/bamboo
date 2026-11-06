# Bamboo — Design

> Living document. Describes **how** Bamboo works. Any PR that changes architecture, schema, API
> contracts, algorithms or prompts updates this file, including §10 *Key decisions* when a
> decision changes. Product intent lives in [PRD.md](PRD.md).

## 1. Architecture

```
                       ┌──────────────────────────── Vercel ─────────────────────────────┐
  Will (iPhone PWA) ──▶│  /web  Next.js (App Router): UI, server actions, API routes      │
   Google sign-in      │        Auth.js v5 (Google, allowlist of one)                     │
                       │        domain logic: web/lib/domain (pure, tested)               │
                       │        Drizzle ORM ───────────────────────▶ Turso (libSQL)       │
                       │        Vercel Cron: /api/cron/daily                              │
                       └───────────────▲──────────────────────────────▲──────────────────┘
                                       │ HTTPS (bearer) AGENT token   │ HTTPS (bearer) WORKER token
  ┌────────────────────────── Mac mini (M6, 32GB) — outbound only ────┼──────────────────┐
  │  OpenClaw (existing)                                              │                  │
  │   ├─ bamboo skill (/agent/skills/bamboo/SKILL.md)                 │                  │
  │   │    link / PDF / text in #bamboo ─▶ bamboo-tools import        │                  │
  │   ├─ command automations: bamboo-tools replies, bamboo-tools nudge│                  │
  │   └─ Discord ◀──────────────────────▶ Will (iPhone)               │                  │
  │  bamboo-tools (Node CLI): share page (Playwright) or pdftotext    │                  │
  │                           → normalize → turns → POST new turns    │                  │
  │  bamboo-worker (Node, launchd): extract_turn jobs ─▶ Ollama (shared with PandaBase)  │
  └──────────────────────────────────────────────────────────────────────────────────────┘
```

**Ownership rule (same as PandaBase):** the State Engine (`/web` + `/db`) owns all data and
business logic: dedupe, ranking, validation of LLM output, scheduling, the reminder decision.
`bamboo-tools` and the worker are stateless clients of the HTTP API. They read pages and files and
call the model; they never touch the DB.

**One language:** everything is TypeScript. The Mac side and the engine must compute identical
normalization and turn keys (§4.1, §4.5) and share API contracts, so both import them from
`@bamboo/shared` rather than keeping two implementations in step.

### 1.1 Components

| Component | Runs on | Responsibility |
|---|---|---|
| `/web` | Vercel | PWA UI, API, domain logic, daily cron |
| `/db` | package | Drizzle schema, migrations, dev seed (`@bamboo/db`) |
| `/shared` | package | Zod contracts, text normalization, turn keys, PDF-text segmentation (`@bamboo/shared`) |
| `/agent/skills/bamboo` | Mac, OpenClaw | Discord intake in `#bamboo`; replies and the reminder come from command automations |
| `/agent/tools` | Mac, invoked by OpenClaw | `bamboo-tools`, a deterministic Node CLI: `import`, `segment` (dry run), `replies`, `nudge` |
| `/worker` | Mac, native Node via launchd | Claims `extract_turn` jobs, calls Ollama, posts results |
| Ollama | Mac, native | Local LLM. **Shared with PandaBase**; see §1.2 |

### 1.2 Mac mini resource budget

PandaBase already runs on this Mac (its DESIGN §1.2). Its host settings
`OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1` apply to Bamboo too. Therefore:

- Worker concurrency = **1**.
- Default model **`qwen3.5:9b`**, the same model PandaBase uses for vision, so the two workers
  rarely force a model swap. It is configurable via `OLLAMA_TEXT_MODEL`. Qwen is strong at
  Chinese, and the task is copy, classify and rate, not writing Chinese.
- Requests: `think: false`, `temperature: 0`, `num_ctx: 8192`, `keep_alive: "2m"`, `format` set
  to the JSON schema of the result contract.
- The first (backlog) import of ~70 turns takes roughly 20–40 min of model time; later imports
  take minutes.
- Share-link imports start a headless Chromium (Playwright's own, not PandaBase's logged-in
  profiles) for a few seconds, then close it.

## 2. Data model

Turso/libSQL via Drizzle. IDs are ULIDs (text). Times are integer ms since epoch
(`timestamp_ms`). JSON columns use `text({ mode: 'json' })` with a Zod type.

### 2.1 Phrases and cards

**`phrase`**: one thing worth remembering. Extracted items *are* phrases; there is no separate
candidate table. A phrase waits in the queue (`queued`) until it's introduced.

| column | type | notes |
|---|---|---|
| `id` | text pk | |
| `status` | `'queued' \| 'active' \| 'dropped' \| 'expired'` | §4.6 |
| `kind` | `'term' \| 'frame' \| 'sentence'` | frames contain `…` as the slot |
| `hanzi` | text | normalized (§4.1) |
| `hanzi_key` | text **unique** | dedupe key (§4.1) |
| `english` | text | meaning (term) or intent (frame/sentence) |
| `addressee` | text null | `yuesao`, `toddler`, `nanny`, `anyone` (free text allowed) |
| `heard_as` | text null | what Will typed when decoding ("podafen") |
| `examples` | json `{hanzi, english \| null, turn_id \| null}[]` | ≤ `config.phrase.maxExamples` (3); terms only; verbatim from Gemini (§4.6) |
| `note` | text null | short usage note |
| `tags` | json `string[]` | domains: `feeding`, `baby`, `food`, `groceries`, `household`, `toddler`, `units`, … |
| `pinyin` | json `[char, syllable \| null][]` | computed (§4.2), never from the LLM |
| `pinyin_override` | json null | same shape; Will's per-syllable edits |
| `usefulness` | int null | 1–5 from the model (§5.4); null for manual |
| `turn_kind` | text null | kind of the source turn (for ranking) |
| `base_score` | real | §4.6; recomputed on change |
| `pinned` | bool | hand-added or "move to top" → front of the queue |
| `pinned_at` | int null | when `pinned` was set; orders pins newest first |
| `source` | `'manual' \| 'import'` | |
| `source_turn_id` | text null | the `turn` that first produced it. No FK constraint: SQLite can add one only by rebuilding the table, which isn't expand-only (§10 #27) |
| `asked_count` | int default 1 | +1 each time an import shows he asked again (at most once per import) |
| `last_asked_import_id` | text null | the import that created it or last bumped `asked_count`; enforces "once per import" (§4.6) |
| `last_asked_at` | int | creation time initially |
| `flags` | json `string[]` | e.g. `long`, `heard_as_dropped`, `example_dropped` |
| `introduced_at`, `dropped_at` | int null | |
| `created_at`, `updated_at` | int | |

**`card`**: `unique(phrase_id, type)`. Cards are created with the phrase (FSRS state New).

| column | type | notes |
|---|---|---|
| `id` | text pk | |
| `phrase_id` | text fk | |
| `type` | `'say' \| 'listen'` | §4.8 |
| FSRS state | | the ts-fsrs 6 scheduler card (FSRS-7, §4.3) as columns: `due`, `stability`, `stability_fast`, `difficulty`, `scheduled_days` (real: FSRS-7 days are fractional), `learning_steps` (the scheduler's `learningStep`), `reps`, `lapses`, `state` (0 New, 1 Learning, 2 Review, 3 Relearning), `schedule_status`, `last_review`. ts-fsrs 6 dropped `elapsed_days` |
| `buried_until` | int null | sibling burying (§4.4) |
| `suspended_at` | int null | set when Will turns the card type off in the editor; suspended cards are never scheduled, and turning the type back on resumes the same card with its history |
| `created_at` | int | |

**`review_log`**: append-only. `id`, `card_id`, `rating` (1–4), `source`
(`'session' | 'already_know' | 'asked_again'`), `state_before` (the card's FSRS state before
this review: "new cards introduced today" counts `state_before = 0`), `round_id` null (fk
`round`; a reload resumes the round without the cards already graded in it), `reviewed_at`,
`duration_ms` null, `fsrs_log` json (the ts-fsrs review log, dates as ms).

**`round`**: `id`, `started_at`, `finished_at` null, `cards` int (reviews done in it),
`card_ids` json (the round as built). Used for the daily goal, stats and the reminder time
(§4.9).

### 2.2 Imports and turns

**`import`**:

| column | notes |
|---|---|
| `id` | |
| `kind` | `'link' \| 'pdf' \| 'text'` |
| `origin` | `'discord' \| 'web'` |
| `source_ref` | share URL or file name; null for text |
| `conversation_title` | from the page or PDF title; null for text |
| `discord_channel_id`, `discord_message_id` | null for web; the reply target |
| `idempotency_key` | **unique** null; the `Idempotency-Key` header of the call that created it |
| `turns_total`, `turns_new` | |
| `status` | `'extracting' \| 'done'` (`done` once the last chunk is in and every job is `done` or `failed`) |
| `jobs_failed` | int |
| `phrases_new` | int; phrases queued from its turns (new, or revived to `queued`) |
| `phrases_again` | int; existing phrases its turns asked about again |
| `uploaded_at` | null while chunks are still arriving (`more: true`) |
| `summary` | null until done; the ready-to-post Discord reply (§5.1) |
| `notified_at` | null until the Discord reply is posted; set at once for an import with nothing new (the skill already replied "Nothing new") |
| `created_at`, `finished_at` | |

**`turn`**: one user message plus Gemini's reply.

| column | notes |
|---|---|
| `id`, `import_id` | first import that contained it |
| `turn_key` | **unique**; §4.5 |
| `user_text`, `reply_text` | normalized; `reply_text` capped at 12,000 chars |
| `position` | index within its first import |
| `kind` | null until extracted; `'decode' \| 'say' \| 'errand' \| 'other'` |
| `extracted_at` | null until extracted |
| `created_at` | |

### 2.3 Platform

- **`job`**: the PandaBase job queue, simplified to one type. Columns: `id`, `type`
  (`'extract_turn'`), `status` (`'queued' | 'leased' | 'done' | 'failed'`), `import_id` (fk
  `import`, denormalized from the turn, to count an import's open jobs), `input` json, `result`
  json null, `attempt` int, `lease_expires_at` null, `model` null, `prompt_version` null, `error`
  null, `created_at`, `finished_at` null. Jobs are claimed oldest first (ids are monotonic ULIDs,
  so one import's turns are processed in order).
- **`event`**: telemetry. Columns: `id`, `type`, `data` json, `at`. See §7.
- **`setting`**: key/value: `nudge_enabled`, `nudge_last_sent_day`.

## 3. API and auth

### 3.1 Auth

- **UI**: Auth.js v5 with Google. Sign-in is allowed only for emails in `ALLOWED_EMAILS`.
  Sessions are JWT with a 90-day max age, so the home-screen PWA rarely signs out.
  Google must report the address as verified. `DEV_AUTH_BYPASS=1` (local and e2e only) signs in
  a fixed dev user (`dev@example.com`) with no sign-in step; it is refused on **every** Vercel
  deployment (`VERCEL` or `VERCEL_ENV` set), previews included. A proxy (`web/proxy.ts`)
  redirects signed-out page requests to `/sign-in`, and each page also calls `requireUser()`.
  Previews have no Google redirect URI (their host changes per build), so they can't complete
  Google sign-in.
- **Machines**: bearer tokens, compared in constant time.
  - `AGENT_API_TOKEN`: `/api/imports*` and `/api/agent/*` (`bamboo-tools`).
  - `WORKER_API_TOKEN`: `/api/jobs/*` and `/api/worker/*`.
  - `CRON_SECRET`: `/api/cron/*` (Vercel Cron sends it as a bearer).

  A token opens only its own routes: the agent token gets 401 on `/api/jobs/*`, the worker token
  gets 401 on `/api/imports*`, and so on. A route whose token isn't configured on the server
  answers 503 `not_configured`, never "open". `web/lib/api/http.ts` (`checkBearer`) does this;
  `pnpm smoke <url>` checks every machine route refuses no token and a wrong one.
- UI mutations use **server actions**; the routes below are for machines.

### 3.2 Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/imports/known` | agent | `{turn_keys: string[]}` (≤ 5,000) → `{unknown: string[]}` so the CLI uploads only new turns |
| `POST /api/imports` | agent | `{kind, origin, source_ref?, conversation_title?, discord_channel_id?, discord_message_id?, turns_total, turns: [{user_text, reply_text, position}], more?}` (≤ 2 MB, else 413; the CLI chunks, passing `import_id` on later calls and `more: true` on every call but the last) → `{import_id, turns_new, turns_added}`. `turns_new` is the import's running total, `turns_added` this call's. The engine recomputes each `turn_key`, inserts new turns, and queues one `extract_turn` per new turn, in one transaction. Header `Idempotency-Key: discord:<message id>` on every call: a repeated first call returns the same import. A chunk with new turns for an import whose last chunk already arrived → 409 `import_closed`; an unknown `import_id` → 404 |
| `GET /api/agent/notifications` | agent | `{notifications: [{import_id, kind, discord_channel_id, discord_message_id, summary}]}`: finished imports with a Discord message and no `notified_at` |
| `POST /api/imports/{id}/notified` | agent | sets `notified_at` → 204 (idempotent; 404 if unknown) |
| `GET /api/agent/nudge` | agent | `{text}` or `{text: null}` (§4.9); a non-null answer records that today's reminder was sent |
| `POST /api/jobs/claim` | worker | → `{job_id, type, attempt, lease_expires_at, input: ExtractTurnInput}` or `204`. Lease = `jobs.leaseMinutes` (10); `attempt += 1`. Claim first requeues expired leases (or fails them after the last attempt) |
| `POST /api/jobs/complete` | worker | `{job_id, attempt, status:'done', result, model, prompt_version, latency_ms?, repaired?}` or `{…, status:'failed', error}` → `{job_status}` (`queued` = will be retried). A stale `attempt` (not the current lease) → 409 `stale_attempt`, nothing changes. The result is validated against `ExtractTurnResult`: invalid → 422 `invalid_result`, which uses up the attempt like a failure. A valid one is applied in one transaction (§4.6) |
| `POST /api/worker/heartbeat` | worker | `{version, sha, model, ollama_ok}` → `worker_heartbeat` event, 204 |
| `GET /api/cron/daily` | cron | expire stale queue items (§4.7), requeue expired leases, prune events > `events.retainDays` (180) → counts. Scheduled in `web/vercel.json` at 11:17 UTC |

Errors from every machine route are `{error, message?, issues?}` with `error` one of
`invalid_body` (400), `unauthorized` (401), `not_found` (404), `stale_attempt`,
`import_closed`, `conflict` (409; a concurrent import inserted the same turn, retry),
`too_large` (413), `invalid_result` (422), `not_configured` (503). The codes are
`API_ERROR_CODES` in `shared/src/contracts/errors.ts`.

The PWA's paste box uses a server action that calls the same import service
(`origin: 'web'`, `kind: 'text'`, one turn with an empty prompt).

Contracts are Zod schemas in `shared/src/contracts/`, imported by web, worker and tools.

## 4. Algorithms

All of these are pure functions in `web/lib/domain/` (or `shared/` where the Mac side also needs
them), with unit tests. Engine tunables live in `web/lib/config.ts`, and Mac-side tunables in
`shared/src/config.ts`.

### 4.1 Text normalization (`shared/src/text.ts`)

PDF text from Gemini has two kinds of damage, both seen in a real export:

- **Kangxi / CJK-radical lookalikes**: `⺟⽉⼀⼉⽤⾼` instead of `母月一儿用高`. 55 distinct ones
  appeared in a 105-page export.
- **Broken English ligatures**: `Simpli!ed`, `bo#le`, `&akes`, `o%en`. These are left alone,
  because they're English and the LLM copes.

`normalizeText(s)`:

1. NFKC. This maps the Kangxi Radicals block (U+2F00–2FD5), most of U+2E80–2EFF, and
   full-width letters and digits. It is **not** applied to the full-width Chinese punctuation
   `，！？：；（）～` and to `…`, which NFKC would fold to ASCII (`…` → `...`): stored hanzi is
   displayed, and the frame slot must stay `…`.
2. Apply an explicit map for the CJK Radicals Supplement characters that NFKC leaves alone. Seen so
   far: `⻄→西 ⻋→车 ⻓→长 ⻛→风 ⻥→鱼 ⻧→麦`. Extend the table as needed; any other character
   left in U+2E80–2FDF is kept and reported in the import's telemetry.
3. Collapse whitespace runs inside lines and trim.

Share-page text probably needs only step 3. It runs through the same function anyway.

`hanziKey(s)` = `normalizeText(s)` with everything except CJK ideographs, ASCII letters and
digits removed, letters lowercased. `阿姨，您是说…吗？` → `阿姨您是说吗`.

### 4.2 Pinyin (`web/lib/domain/pinyin.ts`)

- `pinyin-pro` with tone marks, output aligned per character: `[char, syllable | null]`, with
  `null` for non-hanzi. Tone sandhi is shown only for 一/不.
- pinyin-pro 3.29 reads some everyday polyphones wrongly out of context (跑得很快 → dé, 我得走
  → dé, 长高 → cháng). A small table of **context rules** in `pinyin.ts` corrects the common
  cases from the neighbouring characters: structural 得 before a degree/manner word → `de`; modal
  得 after a subject or adverb (我/你/们/还/就…) before a verb → `děi`; 长 before 大/高/胖/牙/得…
  → `zhǎng`. Words that keep `dé` (得到, 获得, 值得, 不得不) are excluded. Will's overrides fix the
  rest. Extend the table when a misreading turns up.
- Computed for the phrase (stored) **and** each example (computed at read time, not stored).
  Recomputed whenever hanzi changes. If an override exists and the new hanzi differs, the
  override is dropped and the UI says so. Overrides store only the changed syllables (`null`
  elsewhere); the editor accepts tone marks or numbers (`dei3` → `děi`, `de5` → `de`).
- Display (§6): ruby text above each hanzi, using the override where present.
- Gemini's own pinyin is **never stored**. Its errors are the reason this module exists.

### 4.3 Scheduling (FSRS)

`ts-fsrs` 6.0, whose new async `DefaultScheduler` defaults to the **FSRS-7** model (fractional
days, a second `stability_fast` memory field). Bamboo starts with no review history, so it uses
FSRS-7 rather than pinning FSRS-6. `web/lib/domain/fsrs.ts` wraps it (convert columns ↔ scheduler
card, grade, preview the four intervals). Parameters live in `config.fsrs`, with ts-fsrs 6's
camelCase names: `version: 'FSRS-7'`, `desiredRetention: 0.85`, `maximumInterval: 365`,
`enableFuzz: true`, `enableShortTerm: true`, `learningSteps: ['1m', '10m']`,
`relearningSteps: ['10m']`, and `allowModelOverride: false`: with it on, FSRS-7 may skip the
learning steps (a Good after Again jumped to ~2 h), which breaks Again-within-a-round. Fuzz is
seeded by card id + reps, so it is deterministic per card.

**Day boundary**: 04:00 in `HOUSEHOLD_TZ` (default `America/Los_Angeles`), DST-safe
(`web/lib/domain/day.ts`). Bedtime practice after midnight still counts for the previous day.
"Due today" means due before the next 04:00.

### 4.4 Rounds (`web/lib/domain/session.ts`)

A **round** is up to `config.session.roundSize` (10) cards. `buildRound(now, state)` returns its
cards, in this order:

1. learning/relearning cards whose step is due, counting steps due within
   `config.session.learnAheadMinutes` (20, Anki's "learn ahead");
2. review cards due today, most overdue first;
3. **new cards**, interleaved one per `config.session.newEvery` (3) cards (d d N d d N …; extras
   go at the end). New cards are limited by `config.session.newPerDay` (3) minus those already
   introduced today. Due cards take priority: new cards only fill the slots the due cards leave.
   They come first from `active` phrases whose second card is still New, then from the queue
   (§4.6): the top phrase's first card (Listen before Say), one phrase at a time.

A round never holds two cards of one phrase. The round's card ids are stored on `round`, so a
reload resumes it without the cards already graded.

**Siblings**: once one card of a phrase has been shown today, the other is buried until tomorrow
(`buried_until` = the next 04:00); cards mid-learning keep their steps.
**Again** within a round re-inserts the card after its learning step if that falls inside the
round, judged as `config.session.secondsPerCard` (15 s) per remaining card: a 1-minute step comes
back after 4 more cards if at least 4 remain; otherwise it waits for the next round or day. The
same rule applies to any grade whose next step is that short.

**After a round**: the daily goal is met by one finished round, or by having nothing to do, and
the screen says "✓ Done for today". If something is still waiting (due cards, or new cards under
the cap), it also offers "Another round (N due)".

**First sight of a new card** shows, besides the grades:

- **Not useful** → phrase `dropped`, its cards are removed from scheduling, and a `phrase_dropped`
  event is logged (with score, usefulness and kind for tuning). It doesn't count toward
  `newPerDay`.
- **Already know** → grade **Easy** with `source: 'already_know'`.

A phrase becomes `active` (`introduced_at`) when its first card is graded (Not useful drops it
instead), logging `phrase_introduced` with its queue rank at that moment.

**Asked again** (§4.6) on an `active` phrase: apply **Again** with `source: 'asked_again'` to every
card that has been reviewed, at most once per phrase per import.

### 4.5 Turn identity (`shared/src/turns.ts`)

`turn_key = sha256(hanziKey(user_text))`, keyed on **Will's own words only**. Re-exporting or
re-sharing a conversation can re-flow Gemini's reply text, but his prompts come through stably.
That makes "what's new since last time" work across re-shares, across PDF and link imports of
the same conversation, and across separate conversations. Two genuinely identical prompts
collapse into one. That is rare and harmless.

Text imports: `turn_key = sha256(hanziKey(user_text ?? '') + '\n' + hanziKey(reply_text))`.

**Empty prompts.** When `hanziKey(user_text)` is empty (an image-only prompt in a share link or
PDF), the turn is keyed like a text import, on the reply. Otherwise every image-only turn would
share one key and all but the first would be dropped as known. M0 found one such turn in 86 in
Will's real conversation. The rule lives in `turnKey()`, so the CLI and the engine agree.

`turnKey({user_text, reply_text}, kind)` in `shared/src/turns.ts` (`kind` is the import's
`'link' | 'pdf' | 'text'`) returns the hex sha256. A prompt of only punctuation counts as empty.
The engine computes the key from the full normalized text, then caps `reply_text` for storage.

The CLI computes keys to ask `/api/imports/known`; the engine recomputes them and is the
authority.

### 4.6 Validation, dedupe and the queue (`web/lib/domain/queue.ts`)

On `extract_turn` completion, for each raw item:

1. `hanzi = normalizeText(item.hanzi)`. **Drop** the item if `hanziKey(hanzi)` has no CJK
   character, or if it does not occur in `hanziKey(user_text + reply_text)`. This verbatim check
   stops the model inventing Chinese. Count drops in telemetry. For a **frame**, the slot `…`
   (or `...`) matches anything: each part between slots must occur, in order, so
   `阿姨，您是说…吗？` passes on a turn that only says `阿姨，您是说要加水吗？` (§10 #26). Items
   repeating an earlier item's key in the same result are dropped too.
2. Keep `heard_as` only if it occurs (case-insensitive, spaces ignored) in `user_text`;
   otherwise null it and flag `heard_as_dropped`.
3. Keep `example` (terms only) only if it occurs verbatim in the turn **and** contains the term's
   `hanzi_key`; otherwise drop the example and flag `example_dropped`.
4. If a phrase with the same `hanzi_key` exists:
   - the first time **this import** asks about it (`last_asked_import_id` differs):
     `asked_count += 1`, `last_asked_at = now`, `last_asked_import_id = import`, and log
     `asked_again`. Later turns of the same import only merge their example (§10 #28);
   - append the new example (dedupe by key; keep the oldest 3), and fill `heard_as` if it was
     empty; re-score;
   - `active` → apply *asked again* (§4.4);
   - `queued` → re-scored as above;
   - `dropped` or `expired` → back to `queued` and re-score. Asking again means it matters.
     Log a `phrase_revived` event. A phrase that had been introduced (`introduced_at` set) goes
     back to `active` instead, with *asked again* applied: a queued phrase only ever offers New
     cards, so its reviewed cards would never come back (§10 #29).
5. Else, create a `queued` phrase with its cards (§4.8), `last_asked_import_id = import`.

All of this is `validateExtraction` and `planMerge` (pure, in `queue.ts`), applied by
`completeJob` in `web/lib/repo/capture.ts` in the same batch as the job and turn updates.

**Score.** `base_score` is stored. The queue order uses `effective_score`, computed at read time.
Weights are in `config.rank`.

```
base_score = kindWeight[kind]              // term 1, frame 3, sentence 1
           + turnWeight[turn_kind]         // decode 3, say 1, errand −2, other −1
           + (heard_as ? 2 : 0)
           + 3 × (asked_count − 1)
           + 1 × (usefulness − 3)          // model's rating, 1–5; 0 if null
           + (tags ∩ coreTags ≠ ∅ ? 1 : 0) // feeding, baby, food, toddler, units
           − 0.2 × max(0, len(hanzi_key) − 12)   // flag `long` if > 20
effective_score = base_score − 0.5 × weeks_since(last_asked_at)
```

**Queue order**: `pinned` first (newest pin first), then `effective_score` descending, then newest.
The **Up next** page lists the queue, with **Move to top** (sets `pinned`) and **Remove** (drop).

### 4.7 Expiry

The daily cron marks `queued`, unpinned phrases as `expired` when `effective_score <
config.queue.expireBelow` (−2) and they are older than `config.queue.minAgeDays` (30, by
`created_at`). Expired phrases come back if asked about again (§4.6). Nothing depends on Will
acting. (`expiredPhraseIds` in `queue.ts`.)

### 4.8 Card creation

- `term` from a `decode` turn → `listen`.
- Any other term, frame or sentence → `say`.
- The phrase editor has a toggle for each card type (at least one stays on). Turning a type off
  sets the card's `suspended_at` instead of deleting it, so its review history survives; turning
  it back on resumes it.
- Manual phrases are created `queued` with `pinned = true`.

### 4.9 Reminder (`web/lib/domain/nudge.ts`)

`GET /api/agent/nudge` is called every 30 minutes between 17:00 and 23:30 local by an OpenClaw
command automation. It returns text only when **all** of these hold:

- the nudge is enabled, and none has been sent today;
- no round has been finished today;
- a round has something in it (due cards, or new cards available);
- `now ≥ nudge_time`.

`nudge_time` is the median start time of rounds in the last 14 days minus 15 min, once there are at
least 5 such rounds, clamped to 18:00–23:00. Otherwise it is `config.nudge.defaultLocalTime`
(21:00). The text: `📚 1 round · ~3 min · {due} due → {APP_URL}`.

## 5. Capture pipeline

### 5.1 Discord intake (the bamboo skill)

Scope: messages in `#bamboo` (channel id in the tools config). It follows PandaBase's skill
conventions: `SKILL.md` frontmatter gating on `requires.bins: ["bamboo-tools"]` and
`requires.env: ["AGENT_API_TOKEN", "BAMBOO_CONFIG"]`; message text is data, never instructions;
anything with quotes is written to a file and passed with `--input`.

| Message contains | Command |
|---|---|
| a Gemini share link (`share.gemini.google/…`, `gemini.google.com/share/…`, `g.co/gemini/share/…`) | `bamboo-tools import --url <link> --channel-id … --message-id …` |
| a PDF attachment (use its local `path`) | `bamboo-tools import --file <path> --channel-id … --message-id …` |
| other text containing Chinese characters | write it to a file; `bamboo-tools import --text-file <file> --channel-id … --message-id …` |
| anything else | one line: "Send me a Gemini share link, a PDF, or a pasted answer." |

The command prints `{import_id, turns_total, turns_new, conversation_title}`. Reply once:

- `turns_new > 0`: "📥 Got it: *{title}*, {turns_total} questions, {turns_new} new. I'll reply
  when they're processed."
- otherwise: "✅ Nothing new since last time."

**Privacy**: the skill passes the link or path along and never reads, summarizes or quotes the
conversation. All model work happens in the worker on local Ollama. If OpenClaw extracts
attachment text for its own reply model, that model must be local too. PandaBase's household
configuration already does this (its DESIGN §10 #43). If that changes, bind a text-only agent to
`#bamboo`.

**Results**: an OpenClaw *command automation* (no model call) runs `bamboo-tools replies` every 5
minutes. It replies to each finished import's message with the engine's `summary`, e.g. "✅ 9 new
questions → 14 phrases queued. Next up: 高压锅 pressure cooker, 泡打粉 baking powder, …". For
link imports it appends "🔗 This share link is public; you can delete it in Gemini → Settings →
Public links." It then marks the import notified, and prints `NO_REPLY` when idle. This is the
same mechanism as PandaBase's `jobs replies`.

The engine builds the summary when the import finishes (`importSummary` in
`web/lib/domain/imports.ts`): "✅ {N} new questions → {M} phrases queued." (or "no new phrases"),
then "Next up: hanzi (english), …" for up to `imports.nextUpCount` (3) of this import's phrases in
queue order; then, on their own lines, "🔁 {K} phrases you'd asked about before are back in
rotation." when it asked again, "⚠️ {F} questions couldn't be processed; Retry failed on the
Imports page." when jobs failed, and the public-link line for links. Retry failed reopens an
import but doesn't reply in Discord a second time once it has been notified.

**Reminder**: a second command automation runs `bamboo-tools nudge` (§4.9) and posts the text or
`NO_REPLY`.

**Limits**: Discord's free upload limit (currently 10 MB) holds months of one conversation as a PDF
(a 105-page, 10-day export is 1.8 MB). Links have no such limit.

### 5.2 Reading a conversation (`bamboo-tools`)

**Share link** (`agent/tools/src/share.ts`). **Verdict (M0, 2026-11): link works**, read with
two plain HTTPS requests and no browser. The spike is `spikes/share-link/read.mjs`; on a real
86-turn conversation both methods below returned the same title, the same 86 turns, and identical
prompt text (86/86).

*What doesn't work:* the share page's HTML holds no conversation. It is an Angular shell (zero
hanzi; `og:title` is the generic "Gemini - direct access to Google AI"). The conversation arrives
afterwards from an internal RPC.

*Redirects.* `share.gemini.google/<code>` → **301** → `gemini.google.com/share/<id>` (query
`social_preview`, `skid`) → **200**. One hop; `g.co/gemini/share/<id>` → **302** to the same
host. Follow redirects (up to 5) and take the share id from the final `/share/<id>` path.

*Method (primary): RPC over HTTPS.*

1. `GET` the link, following redirects. From the final page take the share id (path), and from
   its inline `WIZ_global_data`: `cfb2h` (build label, sent as `bl`) and `FdrFJe` (session id,
   sent as `f.sid`). Both are optional: without `f.sid` the call still works, with a smaller
   payload.
2. `POST https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ujx1Bf&source-path=/share/<id>&bl=…&f.sid=…&hl=en-US&_reqid=<random>&rt=c`
   with headers `content-type: application/x-www-form-urlencoded;charset=UTF-8`,
   `x-same-domain: 1`, and the body `f.req=[[["ujx1Bf","[null,\"<id>\",[4]]",null,"generic"]]]`.
   No cookies, no XSRF token, no sign-in.
3. The response is `)]}'`, then length-prefixed JSON chunks. Take the line that starts with
   `[["wrb.fr"`; its element `[0][2]` is a **JSON string** holding the payload (`null` when the
   share doesn't exist).
4. Payload paths (positional arrays): `[0][1]` = turns, **oldest first**; `[0][2][1]` = title.
   For each turn: `[2][0][0]` = Will's prompt as he typed it (`\n` kept); `[3][0][0][1][0]` =
   the reply; `[4]` = `[unix seconds, nanos]`. Each turn had exactly one reply candidate.
5. **Replies are Gemini's markdown with JSX-like components**, not plain text. Flatten them:
   - `<TextBox text="…" subtext="…"/>` → the text line, then the subtext line. This is where the
     key Chinese phrase lives; `subtext` is Gemini's pinyin, which §4.2 never stores.
   - `<Section title="…">…</Section>` → the title as a line, then the body.
   - `<TemplateWidget templateName="checklist" …>` wraps a fenced JSON block → its
     `items[].label` as `- ` lines. If the JSON has another shape, keep the block.
   - Drop `<ElicitationsGroup>…</ElicitationsGroup>` (suggestion chips, the PDF's "Explore
     related" block), `<Elicitation/>`, `<FollowUp/>`, `<Image/>` (its caption is a web-page
     title from image search), `<Video/>` and `<Carousel>` tags.
   - Any other `<Capitalized …>` tag is dropped and counted as `unknown_component` in telemetry,
     so a format change shows up.
   - The markdown itself (`**`, `###`, tables, lists) is kept: hanzi are unaffected, which is
     all the verbatim check (§4.6) needs, and the structure helps the local model.

   Components seen in one 86-turn conversation: TextBox 93, Section 82, ElicitationsGroup 59
   (with 118 Elicitation), Image 4, FollowUp 3, TemplateWidget 2, Carousel 1, Video 1.
6. Node's `fetch` fails on these responses (`UND_ERR_HEADERS_OVERFLOW`: Google sends more than
   Node's default 16 KB of headers). Use `node:https` with `maxHeaderSize` (the spike uses
   256 KB), or run Node with `--max-http-header-size`.

*Timing:* ~1.1–1.6 s for 86 turns (a ~0.8 MB RPC response), on the Mac.

*Method (fallback, kept in the spike only): headless Chromium.* Playwright, `goto` with
`domcontentloaded`, then wait for `share-viewer share-turn-viewer` and until the turn count stops
changing (polled every 500 ms); ~5 s. Read:
- title: `share-viewer h1`;
- one `share-turn-viewer` per turn;
- prompt: `user-query .query-text .query-text-line`, one `<p>` per line. `.query-text` also holds
  a visually hidden "You said" `h5`, so don't read it whole.
- reply: `response-container message-content` `innerText`, after hiding
  `.hide-from-message-actions` and buttons (chips, image cards with source labels, copy/play
  buttons, table footers, the checklist `mini-app`).

It agreed with the RPC on the hanzi of 84 of 86 replies. The other 2 are checklist widgets, which
render as a sandboxed iframe (`mini-app`) with no text in the DOM: the RPC is more complete.
It costs a ~100 MB Chromium on the Mac, so M5 doesn't ship it. If the RPC breaks, the PDF is the
fallback (§5.3 of the PRD), and this method is the first thing to try when repairing the link
path.

*Known fragility.* Everything here is undocumented and can change without notice: the RPC id
`ujx1Bf`, its argument `[null,id,[4]]`, the positional payload paths, the component names, and
(for the fallback) the Angular element names. To make breakage loud: fail on a missing path
rather than returning empty text; count unknown components; keep the synthetic fixtures in
`agent/tools/tests/fixtures/` (`share-rpc.txt`, `share-page.html`, `share-page.expected.json`;
`node spikes/share-link/check-fixtures.mjs` checks both readers against them).

*Turns with no prompt text.* A prompt that is only an image has an empty prompt string (1 of 86
turns). Every such turn would share the same `turn_key` (§4.5), so it needs a different key; see
M0's Notes in PLAN.md.

*Snapshot or live? **Frozen snapshot**, and a re-share makes a **new link** (tested in M0).*
After Will added turns to the conversation, the original link still returned exactly what it had
before: the same 86 turns, with identical prompts, timestamps and replies. Re-sharing produced a
link with a different share id that returned 88 turns. Its first 86 were identical to the old
link's (prompts, timestamps and replies), followed by the 2 new turns; the title was unchanged.
So each re-share is a separate public link that carries the whole conversation so far. The
turn-key dedupe in §4.5 turns that into "88 questions, 2 new". Old links stay public until Will
deletes them, which is why the reply after a link import reminds him (§5.1).

A failure (layout changed, or the link was deleted) replies "⚠️ Couldn't read that link. Send the
PDF instead." and logs `share_parse_failed`. A deleted or unknown link shows up as an HTTP 404 on
`share.gemini.google`, or as a `null` payload from the RPC.

**PDF** (`shared/src/segment.ts`, on `pdftotext -layout -enc UTF-8` output):

1. `normalizeText` each line (§4.1).
2. The title is the first line.
3. Drop boilerplate lines that match `segment.boilerplate` regexes: "Sign in", "Gemini may display
   inaccurate info…", "Google Privacy Policy…", "Your privacy & Gemini Apps", "Answering …
   standard", "Created with … Published …", the share-URL line, "Source: …", and the **"Explore
   related …" block** (header plus suggestion chips up to the next blank-line gap).
4. Collapse consecutive duplicate lines (page breaks repeat lines).
5. **Speaker detection**: Will's messages are right-aligned bubbles. A *user block* is a run of
   lines with indent ≥ `userIndentMin` (20) that contain Latin letters. It starts after a blank
   line, and the next non-blank line after it has indent < `replyIndentMax` (8). Everything up to
   the next user block is the reply. Images are lost in the PDF; their turns still have text.

**Then, for any source**: compute turn keys → `POST /api/imports/known` → `POST /api/imports` with
only the unknown turns, chunked to ≤ 2 MB.

`bamboo-tools segment --url <link> | --file <pdf>` is a dry run. It prints the title, the turn
count, and the first and last 5 user prompts, and makes no API calls.

### 5.3 `extract_turn` (worker → Ollama)

Input: `{turn_id, conversation_title, user_text, reply_text}`. Prompt:
`worker/prompts/extract_turn.v{N}.md` (the highest N wins). Output contract `ExtractTurnResult`:

```ts
{
  turn_kind: 'decode' | 'say' | 'errand' | 'other',
  items: Array<{                       // ≤ 8
    kind: 'term' | 'frame' | 'sentence',
    hanzi: string,                     // copied exactly from the turn
    english: string,                   // ≤ 120 chars
    addressee: string | null,          // use the conversation title as a hint
    heard_as: string | null,           // only for decode: Will's guess, copied from his message
    example: { hanzi: string, english: string | null } | null,  // terms only: a sentence from
                                       // the reply that uses the term, copied exactly
    usefulness: 1 | 2 | 3 | 4 | 5,     // how likely Will is to say or hear this again at home
    tags: string[]                     // from the fixed tag list in the prompt
  }>
}
```

Prompt guidance (v1):

- **decode**: Will is guessing a word he heard. Extract the decoded word(s) with `heard_as`.
- **say**: extract the **shortest natural** sentence Gemini offered (prefer a "short/direct"
  variant if present), the 1–4 key terms (each with an example sentence), and any **reusable
  frame**. Write frames with `…` for the slot, e.g. `阿姨，您是说…吗？`.
- **errand**: extract at most the Chinese nouns (an ingredient, a product), if any are present.
- **usefulness**: 5 = daily household language (feeding, food, the kids); 1 = a one-off
  (a brand, a single errand).
- Copy hanzi **exactly** from the text. Never write Chinese that isn't in the turn. Skip items
  that are Cantonese-only (e.g. 肥仔水).
- Keep `english` short.

The worker calls Ollama with `format` set to the JSON schema of the result. It validates with Zod.
On invalid output it sends one repair turn (the bad reply plus the validation error); a second
failure fails the attempt. After 3 attempts the job is `failed` and counted in
`import.jobs_failed`. The Imports page has a **Retry failed** button, which requeues with
`attempt` reset. The job records `model` and `prompt_version` (`extract_turn.v1`).

The engine, on completion: sets `turn.kind`/`extracted_at` and runs §4.6. When the import's last
job finishes, it sets the import to `done`, builds its summary, and logs `import_finished`.

Attempts are counted by the engine: every claim is a new attempt; a reported failure, a result
that fails `ExtractTurnResult` (422), or a lease that runs out uses it up. Below
`jobs.maxAttempts` (3) the job goes back to `queued`; at 3 it is `failed`. The worker's own
repair turn happens inside one attempt. The worker should send `latency_ms` and `repaired` with
each result for the `extraction` event.

## 6. Web UI (PWA)

Mobile-first; tested at a 390×844 viewport. Dark mode follows the system, since this is used at
night.

Today, Up next, Phrases and Imports share a bottom tab bar (`app/(main)/`); Review is
full-screen.

- **Today** (`/`): "1 round · N due · M new", **Start**, or "✓ Done for today" (plus "Another
  round (N due)" when more is waiting, §4.4); "⏳ N questions waiting for the Mac worker (last
  seen …)" when jobs are queued or leased and no heartbeat came in the last
  `worker.offlineAfterMinutes` (25; the worker beats every 10).
- **Review** (`/review/[id]`): one card at a time. **Start** is a server action that builds the
  round, stores it and opens `/review/<round id>`; reloading resumes it. Grading, Not useful and
  finishing are server actions; Again's re-insertion (§4.4) happens in the client.
  - *Say*: the front shows the English intent and an addressee chip ("→ 阿姨"). Tap to reveal the
    hanzi with ruby pinyin; audio plays; for terms, the example sentence (with pinyin) and its
    English appear below.
  - *Listen*: the front autoplays audio and shows a 🔊 button and an optional "you heard:
    *podafen*" hint. Tap to reveal the meaning, hanzi and example.
  - The back has 4 grade buttons (with their next interval shown) and slow-replay. A new card's
    first back also shows **Not useful** and **Already know**.
- **Up next** (`/queue`): the ranked queue; each row shows hanzi, English, "heard: …",
  "asked ×N"; **Move to top** / **Remove**.
- **Phrases** (`/phrases`, `/phrases/new`, `/phrases/[id]`): search (hanzi, pinyin, English,
  heard-as) and filter by kind, tag or status; add, edit (examples for terms, pinyin overrides,
  card types); drop, and restore a dropped phrase. After adding, the editor opens so Will can
  check the computed pinyin (per-character override inputs appear once the hanzi is saved).
- **Imports** (`/imports`): recent imports with status and counts, failed jobs (Retry), and a
  paste box for a single Gemini answer (it must contain Chinese; the result line says whether
  it was new or already imported).
- **Stats** (`/stats`): PRD §6 measures (§7).

**Audio** (`web/lib/audio.ts`): the Web Speech API. Voice choice: `lang` `zh-CN`, preferring an
"Enhanced"/"Premium" voice (e.g. Tingting). Rate 0.9, and 0.6 for slow replay. Speak the hanzi,
with `…` replaced by a short pause; examples have their own play button. iOS needs a user gesture
before the first utterance; the Start tap counts (it speaks a silent utterance to unlock speech,
and the round opens by client-side navigation, so the unlock carries over). Cantonese (`zh-HK`)
voices are never picked; `zh-TW` is a fallback. If no `zh-CN` voice is found, show a one-time
hint: *Settings → Accessibility → Spoken Content → Voices → Chinese*.

**PWA**: `manifest.webmanifest` (standalone, icons, theme color). There's no service worker in
the MVP: no offline review and no web push (the reminder comes through Discord).

## 7. Telemetry and stats

`event` types:

- `import_finished {import_id, kind, turns_total, turns_new, jobs_failed, phrases_new, phrases_again}`
- `share_parse_failed {host}`
- `extraction {turn_id, job_id, model, prompt_version, latency_ms, turn_kind, items, kept, dropped_not_verbatim, dropped_duplicate, examples_dropped, heard_as_dropped, repaired}`
  (the raw result stays in `job.result`, so dropped items can be sampled)
- `phrase_introduced {phrase_id, rank, effective_score, usefulness, kind}`
- `phrase_dropped {phrase_id, effective_score, usefulness, kind, turn_kind}`
- `already_know {phrase_id}`
- `asked_again {phrase_id, status, import_id}` (status before the merge)
- `phrase_revived {phrase_id}`
- `review {card_type, rating, source}`
- `round_finished {cards, ms}`
- `nudge_sent {local_time}`
- `worker_heartbeat {...}`

The Stats page shows, for the last 4 weeks:

- days with a finished round per week;
- true retention on review-state cards;
- asked-again count on active phrases;
- the "Not useful" rate among introduced phrases (also split by kind and by usefulness);
- the extraction drop rate;
- queue size;
- the last worker heartbeat.

A Claude Code session asked to "review extraction and ranking" reads these numbers plus samples
of dropped phrases and dropped extraction items (from the prod DB, on the Mac), and proposes prompt
or weight changes. This is the same practice as PandaBase's diagnostics playbook.

## 8. Environments and operations

### 8.1 Environment variables

| Var | Where | Notes |
|---|---|---|
| `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | web | |
| `ALLOWED_EMAILS` | web | comma-separated |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | web, db scripts | local dev: `file:db/dev.db` |
| `AGENT_API_TOKEN`, `WORKER_API_TOKEN`, `CRON_SECRET` | web (+ tools / worker) | `openssl rand -hex 32` |
| `HOUSEHOLD_TZ` | web | default `America/Los_Angeles` |
| `APP_URL` | web | for links in Discord messages |
| `DEV_AUTH_BYPASS` | web (dev/e2e) | refused on every Vercel deployment |
| `BAMBOO_API_URL`, `AGENT_API_TOKEN`, `BAMBOO_CONFIG` (path to tools config: channel id) | tools | |
| `BAMBOO_API_URL`, `WORKER_API_TOKEN`, `OLLAMA_URL` (`http://localhost:11434`), `OLLAMA_TEXT_MODEL` (`qwen3.5:9b`), `POLL_INTERVAL_SECONDS` (15) | worker | `~/.config/bamboo/worker.env` |

### 8.2 Deploy

- **Vercel** Git integration: `main` → production; PRs → previews. The project's Root Directory
  is `web` (with files outside it included in the build).
- **Turso**: two databases, `bamboo` (prod) and `bamboo-preview`. Vercel env vars are scoped
  per environment; previews get their own `AUTH_SECRET` and machine tokens.
- **Migrations**: the Vercel build command (`web/vercel.json`) is
  `pnpm --dir .. db:migrate && pnpm build`, i.e. `pnpm db:migrate && pnpm --filter web build`
  from the repo root, run against whichever DB that environment points at. On Vercel,
  `db:migrate` fails the build if `TURSO_DATABASE_URL` is missing or local, or
  `TURSO_AUTH_TOKEN` is missing, so a misconfigured environment never deploys. Migrations must be **expand → contract**:
  add freely; drop or rename only in a later PR once no deployed code uses the column.

### 8.3 Mac mini

- Prereqs: `brew install poppler` (for `pdftotext`), Node 24, pnpm, Playwright's Chromium
  (`pnpm --filter @bamboo/tools exec playwright install chromium`), and Ollama with `qwen3.5:9b`
  pulled (already there for PandaBase). Checkout at `~/src/bamboo`.
- **Worker**: a LaunchAgent `ops/launchd/com.bamboo.worker.plist` runs
  `pnpm --filter @bamboo/worker start` with `KeepAlive`, logs to `~/Library/Logs/bamboo/`.
  It sends a heartbeat at startup and every 10 min, and claims jobs only if the model is pulled
  (`GET /api/tags`). SIGTERM finishes the current job, then exits.
- **Agent**: `make agent-install` links `bamboo-tools` onto PATH, writes the tools config from
  `agent/bamboo.config.example.json`, and adds `agent/skills` to OpenClaw's
  `skills.load.extraDirs`, backing up `openclaw.json` first, as PandaBase does. It also adds the
  two command automations (replies every 5 min; nudge every 30 min from 17:00 to 23:30). Create a
  `#bamboo` Discord channel and allow the agent in it.
- `make mac-update` runs `git pull --ff-only`, `pnpm install --frozen-lockfile`, then
  `launchctl kickstart -k`; `make worker-logs` tails the logs.

### 8.4 Private data

Real conversations reach the Mac only through Discord, as links or as attachments that OpenClaw
stores. Will never needs to put files on the Mac's filesystem. If a developer session saves a
copy while debugging, it goes in `private/` at the repo root, which is
gitignored. Real conversations are never committed, never used as test fixtures, and never quoted
in docs, PRs or commit messages (counts only). Test fixtures are synthetic (Appendix A).

## 9. Repository layout

```
bamboo/
  CLAUDE.md  README.md  Makefile  package.json  pnpm-workspace.yaml  tsconfig.base.json
  docs/       PRD.md DESIGN.md PLAN.md ROADMAP.md
  web/        Next.js app — app/, components/, lib/domain/ (pure), lib/repo/ (DB), lib/config.ts,
              lib/api/ (machine-route auth and bodies), scripts/seed.ts (`pnpm db:seed`),
              scripts/smoke.ts (`pnpm smoke`), e2e/ (Playwright)
  db/         @bamboo/db — src/schema/*, migrations/, migrate script
  shared/     @bamboo/shared — src/contracts/*, text.ts, turns.ts, segment.ts, config.ts;
              tests/fixtures/ (synthetic PDF text)
  worker/     @bamboo/worker — src/ (claim loop, ollama client), prompts/
  agent/      skills/bamboo/SKILL.md; tools/ (@bamboo/tools → bamboo-tools; share.ts;
              tests/fixtures/ synthetic share page); bamboo.config.example.json
  private/    gitignored
  ops/launchd/
  .github/workflows/ci.yml
```

## 10. Key decisions and rationale

| # | Decision | Why |
|---|---|---|
| 1 | Keep Gemini as the in-the-moment tutor; Bamboo owns memory | A 9B local model is clearly worse than Gemini Flash at decoding guesses in context and at natural Mandarin, and lacks voice/photo input; revisit with a measured comparison (ROADMAP) |
| 2 | Review in a PWA, not Discord | Audio, big grade buttons and short rounds work better in a page than as chat turns |
| 3 | Capture = share link (primary), PDF (always supported), pasted answer, all via OpenClaw in `#bamboo` | Share link is ~3 taps from the Gemini app; a share page's layout can change without notice, so the PDF path is required, not optional; reuses PandaBase's Discord intake pattern and replies in-thread |
| 4 | Read pages and PDFs on the Mac; upload only new turns as text | The Mac can reach Gemini and has `pdftotext`; no file storage or presigned uploads; small payloads |
| 5 | Turn identity = hash of Will's prompt text | Stable across re-shares, formats and multiple conversations |
| 6 | Local LLM extracts and rates; it never writes Chinese for study | 9B models copy and classify Chinese well; the verbatim check enforces it, examples included |
| 7 | Terms carry example sentences copied from Gemini | Will needs usage, not just the word; copying keeps Chinese generation out of the local model |
| 8 | Automatic selection: ranked queue → ≤ 3 new/day; Not useful / Already know on first sight | Will prefers not to sort; corrections during review are cheap and train the ranking |
| 9 | Pinyin computed (pinyin-pro) with overrides | Gemini's pinyin is inconsistent even within a single reply |
| 10 | "Asked again" = Again on active phrases, revives dropped/expired ones | Re-asking is the clearest forgetting (and usefulness) signal available |
| 11 | Daily unit = one round of ~10 cards; FSRS at 0.85 | Tiny required unit plus optional extra, as habit-forming apps do; smaller review load |
| 12 | No "Used it" button | Will wouldn't tap it |
| 13 | Device TTS (Web Speech) | Free, offline, decent zh-CN voices on iOS |
| 14 | Reminder via Discord, timed adaptively in the evening | OpenClaw cron already exists; avoids web push; matches when Will practises |
| 15 | All TypeScript, same stack as PandaBase, no codegen or Docker | Shared normalization, turn keys and contracts from one source; the Mac side is thin |
| 16 | Separate repo, DB, worker and skill from PandaBase; shared Ollama and OpenClaw | Independent deploys and failure; one model resident on a 32GB machine |
| 17 | Mandarin only; no `lang` column yet | Cantonese is undecided; adding it later is one expand migration plus Jyutping and a zh-HK voice |
| 18 | Single user, no `member` table | One learner; add a user column if a second learner is real |
| 19 | `DEV_AUTH_BYPASS` is refused on every Vercel deployment, not just production; previews have no Google sign-in | Previews run unreviewed PR code on a guessable URL, so a stray env var must never open one; a per-preview redirect URI isn't possible with Google, and M1–M6 need no signed-in preview |
| 20 | Read share links through Gemini's share RPC over plain HTTPS, not headless Chromium (M0) | The page HTML has no conversation; the RPC returns it whole (prompts verbatim, checklist data the DOM hides) in ~1 s with no browser on the Mac; both are undocumented, and the PDF path covers breakage |
| 21 | Image-only prompts are keyed on the reply (§4.5) | Found in M0: an empty prompt would collide with every other empty prompt; the reply is the only stable text the turn has |
| 22 | FSRS-7 through ts-fsrs 6's `DefaultScheduler`, with `allowModelOverride: false` | No history to migrate, so start on the library's current model; the explicit 1m/10m learning steps keep Again-within-a-round predictable. The model is in `config.fsrs.version`, and `review_log.fsrs_log` keeps what a later replay needs |
| 23 | pinyin-pro plus a small table of context rules (得, 长) | pinyin-pro alone misreads the most common household polyphones; a rule table is cheap, tested, and Will's overrides remain the final word |
| 24 | Turning a card type off suspends the card | Deleting it would drop its review history; suspending keeps `review_log` append-only and makes the toggle reversible |
| 25 | A finished round meets the daily goal even if more is due; "Another round" stays optional | The daily unit is one round (PRD §3.4); showing "✓ Done" with an optional extra matches the habit model |
| 26 | A frame's slot (`…`) matches anything in the verbatim check (§4.6) | Gemini writes the full sentence ("阿姨，您是说要加水吗？") more often than the frame itself; a plain substring check would drop every reusable frame, the item kind the ranking values most. Each fixed part must still be copied, in order |
| 27 | `phrase.source_turn_id` stays a plain column, without a foreign key | SQLite adds a constraint only by rebuilding the table (copy, drop, rename), which isn't an expand-only migration on a live Turso DB; the engine is the only writer and sets it from a real turn |
| 28 | "Asked again" counts at most once per import (`phrase.last_asked_import_id`) | One conversation that mentions a word in five turns is one act of forgetting, not five; also keeps the Again review to once per phrase per import (§4.4) |
| 29 | Reviving a dropped phrase that had been introduced puts it back in `active` (with Again), not `queued` | A queued phrase only offers New cards (§4.4), so an introduced phrase's reviewed cards would never come back from the queue; matches the editor's Restore |
| 30 | The engine counts attempts: an invalid result (422) or an expired lease uses one up like a reported failure; claim sweeps expired leases | A worker that keeps sending bad output, or dies mid-job, can't loop a job forever; requeueing on claim (not only in the daily cron) retries a crashed worker's job within one lease |
| 31 | Chunked uploads end with `more: false`; the import is `done` only after that; a repeated `Idempotency-Key` returns the same import | Otherwise the first chunk's jobs could finish (and be reported in Discord) before the second chunk arrives; idempotency makes a CLI retry after a timeout safe |
| 32 | `pnpm smoke <url>` after each deploy: public requests only, never a real token | Catches a broken sign-in config, a lost PWA manifest or a machine route that forgot its token check, without needing secrets on the machine that runs it |

## Appendix A — Synthetic fixtures

**PDF text** (`shared/tests/fixtures/gemini-export.txt`, the `pdftotext -layout` output; tests
start from text, so CI doesn't need poppler). Invented content reproducing every quirk of the real
export:

- a title line, a share-URL line, and a "Created with … Published …" line;
- user prompts right-aligned at ~25–30 columns of indent, some over 2–4 lines, one repeated
  across a page break;
- overlay junk lines in the middle of a prompt ("Sign in", "Gemini may display inaccurate info…",
  privacy-policy lines);
- replies at indent 0–5 with headings, "In Chinese, you can say:" blocks, hanzi lines followed by
  pinyin lines, "Key terms" bullets, a 3-column quick-reference table with indented cells, and an
  "Explore related …" block with two-column suggestion chips;
- Kangxi lookalikes (`⺟ ⽉ ⼀ ⼉ ⽤ ⾼ ⻄ ⻋`) inside hanzi;
- ligature-damaged English (`Simpli!ed`, `bo#le`);
- consecutive duplicated lines;
- at least one each of: a decode turn ("she said something like *gaoyaguo*"), a say turn, an
  errand turn (a shopping question with no Chinese worth keeping), and a turn whose reply
  contains a Cantonese-only term.

**Share page** (`agent/tools/tests/fixtures/share-page.html`): a trimmed, **content-replaced**
copy of a real share page's structure, made in M0. Keep the real markup and structure, but replace
every piece of conversation text with invented text. Expected turns live next to each fixture as
JSON and are asserted in tests.

**Share RPC** (`agent/tools/tests/fixtures/share-rpc.txt`, M0): the batchexecute response that
§5.2's primary method parses, in the real envelope and positional layout, generated with invented
text by `spikes/share-link/make-fixtures.mjs`. It matches `share-page.html` turn for turn (4 turns:
TextBox, Section, table, image, suggestion chips, a two-line prompt, a checklist widget, an
image-only prompt, a follow-up suggestion). Both share `share-page.expected.json`.

## Appendix B — Optional Gemini instruction

Not required. Saving this once in Gemini (Settings → Saved info) makes extraction better:

> When I ask how to say something in Chinese, put the shortest natural spoken version first, as
> I'd say it to that person, and use key words in a short example sentence. If I'm guessing at a
> word someone said, name the word in characters first. Keep key-term lists to the 3 most useful
> words.
