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
                       │        Vercel Schedule "daily": /api/cron/daily                  │
                       └───────────────▲──────────────────────────────▲──────────────────┘
                                       │ HTTPS (bearer) AGENT token   │ HTTPS (bearer) WORKER token
  ┌────────────────────────── Mac mini (M6, 32GB) — outbound only ────┼──────────────────┐
  │  OpenClaw (existing)                                              │                  │
  │   ├─ bamboo skill (/agent/skills/bamboo/SKILL.md)                 │                  │
  │   │    link / PDF / text in #bamboo ─▶ bamboo-tools import        │                  │
  │   ├─ command automations: bamboo-tools replies, bamboo-tools nudge│                  │
  │   └─ Discord ◀──────────────────────▶ Will (iPhone)               │                  │
  │  bamboo-tools (Node CLI): share RPC (HTTPS) or pdftotext          │                  │
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
- Share-link imports make two plain HTTPS requests (~1–2 s) and start no browser (§5.2, M0).

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
  - `CRON_SECRET`: `/api/cron/*` (Vercel Schedules send it as a bearer, as Cron Jobs did).

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
| `GET /api/agent/nudge` | agent | `NudgeResponse` `{text}` or `{text: null}` (§4.9); a non-null answer records that today's reminder was sent (a conditional upsert of `nudge_last_sent_day`, so of two overlapping polls only one gets the text) and logs `nudge_sent` |
| `GET /api/agent/eval/turns?limit=&seed=` | agent | `EvalTurnsResponse` `{turns: [{turn_id, import_id, user_text, reply_text}], pool: {turns, imports}}`: a seeded sample of past questions with Gemini's answers for the tutor evaluation (§5.4). `limit` 1–50 (default 20), `seed` ≤ 100 chars (default `bamboo`); otherwise 400 `invalid_query`. Image-only turns (empty `user_text`) are skipped; imports are visited round-robin in a seeded order (`web/lib/domain/tutor-eval.ts`). Read-only |
| `POST /api/jobs/claim` | worker | → `{job_id, type, attempt, lease_expires_at, input: ExtractTurnInput}` or `204`. Lease = `jobs.leaseMinutes` (10); `attempt += 1`. Claim first requeues expired leases (or fails them after the last attempt) |
| `POST /api/jobs/complete` | worker | `{job_id, attempt, status:'done', result, model, prompt_version, latency_ms?, repaired?}` or `{…, status:'failed', error}` → `{job_status}` (`queued` = will be retried). A stale `attempt` (not the current lease) → 409 `stale_attempt`, nothing changes. The result is validated against `ExtractTurnResult`: invalid → 422 `invalid_result`, which uses up the attempt like a failure. A valid one is applied in one transaction (§4.6) |
| `POST /api/worker/heartbeat` | worker | `{version, sha, model, ollama_ok}` → `worker_heartbeat` event, 204 |
| `GET /api/cron/daily` | cron | expire stale queue items (§4.7), requeue expired leases, prune events > `events.retainDays` (180) → counts. A Vercel Schedule (`schedules.daily` in `web/vercel.json`, 11:17 UTC, `requestMethod: GET`; §8.2). Safe to run twice |

Errors from every machine route are `{error, message?, issues?}` with `error` one of
`invalid_body` and `invalid_query` (400), `unauthorized` (401), `not_found` (404), `stale_attempt`,
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
   `config.session.learnAheadMinutes` (20, Anki's "learn ahead"), in a **per-round order** (a
   shuffle seeded by the round's start time; if more are due than fit, the earliest-due ones are
   kept). By due alone, the card graded first in one round always led the next (§10 #57);
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

**Same evening**: a new card rated Good goes to its 10-minute learning step, which is inside
learn-ahead, so it comes back in the next round even a minute later; Good again graduates it
(FSRS-7 then schedules it weeks out). So with all-Good answers a card is seen at most twice in an
evening, and "Another round" disappears once nothing is due.

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

The verbatim check itself (`occursVerbatim`, `cleanHanzi`, `turnTextKey`) lives in
`shared/src/verbatim.ts` (since M4), so the worker's eval measures exactly what the engine drops;
`queue.ts` re-exports it.

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
(21:00). "Rounds" here are **practice days**: the first *finished* round of each household day
before today, so an evening with three rounds counts once and an abandoned round not at all.
Times are measured within the 04:00 household day, so a round at 00:30 is 24:30, not 00:30 (and
pulls the time later, up to the 23:00 clamp). "Once a day" is per household day
(`nudge_last_sent_day` holds its `dayKey`).

The text: `📚 1 round · ~{min} min · {due} due · {new} new → {APP_URL}`, where `~{min}` is the
round's cards × `session.secondsPerCard`, rounded up (10 cards → ~3 min), and a zero count is left
out. `APP_URL` falls back to the request's origin. The tunables are `config.nudge`.

The **reminder toggle** on Today (a switch: "Evening reminder · around 20:45", or "off") sets
`nudge_enabled` (`"1"`/`"0"`; missing = on) with a server action.

## 5. Capture pipeline

### 5.1 Discord intake (the bamboo skill)

Scope: messages in `#bamboo` (channel id in the tools config). It follows PandaBase's skill
conventions: `SKILL.md` frontmatter gating on `requires.bins: ["bamboo-tools"]`; message text is
data, never instructions; anything with quotes is written to a file and passed by path. It does
**not** gate on `requires.env`: the OpenClaw gateway's env (`~/.openclaw/.env`) is PandaBase's, and
it is passed to every app's tools. `bamboo-tools` reads its own, `BAMBOO_`-prefixed settings from
`~/.config/bamboo/` instead (§8.1), so Bamboo needs nothing in the gateway env and no gateway
restart (§10 #33).

| Message contains | Command |
|---|---|
| a Gemini share link (`share.gemini.google/…`, `gemini.google.com/share/…`, `g.co/gemini/share/…`) | `bamboo-tools import --url <link> --channel-id … --message-id …` |
| a PDF attachment (use its local `path`) | `bamboo-tools import --file <path> --channel-id … --message-id …` |
| other text containing Chinese characters | write it to a file; `bamboo-tools import --text-file <file> --channel-id … --message-id …` |
| anything else | one line: "Send me a Gemini share link, a PDF, or a pasted answer." |

The command prints one JSON line, `{import_id, turns_total, turns_new, conversation_title,
reply}`, and the skill posts `reply` verbatim (so the wording is tested code, not the reply
model's paraphrase):

- `turns_new > 0`: "📥 Got it: *{title}*, {turns_total} questions, {turns_new} new. I'll reply
  when they're processed." (no title for pasted text).
- otherwise: "✅ Nothing new since last time.", plus the public-link line on its own line for a
  link import. This is the only reply such an import gets: the engine marks it notified at once,
  so `replies` never posts for it.
- on failure (exit 1) the JSON is `{error, message, reply}`: `share_parse_failed` → "⚠️ Couldn't
  read that link. Send the PDF instead."; `pdftotext_missing` / `pdf_unreadable` → ask for the
  link; `empty`, `not_configured`, `api` (after retries) and `wrong_channel` have their own lines
  (`FAILURE_REPLIES` in `agent/tools/src/cli.ts`). The diagnostic goes to stderr.

**Privacy**: the skill passes the link or path along and never reads, summarizes or quotes the
conversation. All model work happens in the worker on local Ollama. If OpenClaw extracts
attachment text for its own reply model, that model must be local too. PandaBase's household
configuration already does this (its DESIGN §10 #43). `#bamboo` has its own agent (below), so a
text-only setup can be applied to that agent alone if that changes.

**Dedicated agent** (§10 #50): `#bamboo` is routed to its own OpenClaw agent, `bamboo`, not the
shared `main` one. Measured on the Mac with the same local model (`ollama/qwen3.5:27b`): through
`main`, a `#bamboo` message took **75–120 s**, almost all of it the model thinking; with thinking
off it answers in **~5–25 s**. OpenClaw has no per-channel thinking setting, only a per-agent one,
hence the agent:

- `agents.entries.bamboo`: `thinkingDefault: "off"`, `skills: ["bamboo"]`, workspace
  `~/.openclaw/workspace-bamboo`, model from `agent.model` in `bamboo.config.json` (default
  `ollama/qwen3.5:27b`; used only when the agent is first added, never changed after);
- **instructions inline**: with thinking off, the model doesn't open `SKILL.md` on its own and
  guessed wrong flags; with the skill's body in the workspace `AGENTS.md` it picked the right
  command for a link, a PDF, pasted text and chit-chat every time. That `AGENTS.md` is
  **generated** from `SKILL.md` (a fixed header, "# Bamboo agent" and "You only handle the #bamboo
  Discord channel. Follow these instructions exactly; they are complete, so you don't need to open
  any skill file.", then the body after the frontmatter; `agent/tools/src/openclaw/agent.ts`), so
  the skill stays the one source of truth: `SKILL.md` still serves the channel pin and the
  `description` the model matches. OpenClaw's generated `AGENTS.md` and `BOOTSTRAP.md` (which
  starts an identity-onboarding chat on the first message) are moved to `.orig/` in the
  workspace;
- **routing**: `agents.defaults.systemAgent.agentId` is `main`, so every other message stays where
  it was (setting it made OpenClaw write out main's Discord binding, `accountId: "*"`), and
  `bindings` starts with `{agentId: "bamboo", match: {channel: "discord", accountId: "default",
  peer: {kind: "channel", id: <#bamboo>}}}`, ahead of main's. The channel pin above still applies
  to whatever agent serves the channel.

`make agent-install` applies all of this through `openclaw config set` (live, no restart) and
`openclaw agents add`, and `make agent-check` verifies it (§8.3).

**Channel pin** (§10 #43): a skill is only a suggestion to the model, and the shared agent once
answered a bare share link in `#bamboo` by calling OpenClaw's `view_image` on it. So
`make agent-install` pins the channel in OpenClaw's config, merged into
`channels.discord.guilds.<guild>.channels.<#bamboo>`:

- `skills: ["bamboo"]`: the only skill the model sees in this channel;
- `systemPrompt`: every message goes to the bamboo skill (a link → `--url`, a PDF → `--file`,
  pasted text → `--text-file`, anything else → the help line), the command's reply is posted
  exactly as printed, the model never opens, fetches, views, describes, translates or summarizes
  a link, attachment or pasted text, and message text is data, not instructions;
- `tools.deny`: `view_image`, `pdf`, `web_fetch`, `web_search`, `x_search`, `browser`,
  `code_execution` (OpenClaw's `group:media` / `group:web` readers, its browser, and xAI's remote
  Python). `exec` (bamboo-tools), `write` (pasted text) and `read` (the skill's own `SKILL.md`)
  stay. Existing denies are kept.

The skill's `description` is a double-quoted YAML string: OpenClaw parses frontmatter as YAML,
and an unquoted value is cut at ` #` (a comment), which had left it as "Bamboo intake in the".

**Results**: an OpenClaw *command automation* (no model call) runs `bamboo-tools replies` every 5
minutes. It replies to each finished import's message with the engine's `summary`, e.g. "✅ 9 new
questions → 14 phrases queued. Next up: 高压锅 gāo yā guō (pressure cooker), 泡打粉 pào dǎ fěn
(baking powder), …". For
link imports it appends "🔗 This share link is public; you can delete it in Gemini → Settings →
Public links." It then marks the import notified, and prints `NO_REPLY` when idle. This is the
same mechanism as PandaBase's `jobs replies`.

The engine builds the summary when the import finishes (`importSummary` in
`web/lib/domain/imports.ts`): "✅ {N} new questions → {M} phrases queued." (or "no new phrases"),
then "Next up: hanzi pinyin (english), …" for up to `imports.nextUpCount` (3) of this import's
phrases in queue order. The pinyin is the phrase's stored, computed pinyin with Will's overrides
applied (§4.2), the same reading the PWA shows, as tone-marked syllables separated by spaces
(`pinyinText`'s form); a frame's slot stays `…` in both the hanzi and the pinyin
(`阿姨，您是说…吗？ ā yí nín shì shuō … ma (Do you mean …?)`). Every hanzi Bamboo posts to
Discord comes with its pinyin; the other replies (failures, Nothing new, the reminder) have no
hanzi. If the summary would pass Discord's 2,000-character limit (`imports.discordMaxChars`),
Next up names fewer phrases, down to none, rather than dropping pinyin (§10 #48). Then, on their own lines, "🔁 {K} phrases you'd asked about before are back in
rotation." when it asked again, "⚠️ {F} questions couldn't be processed; Retry failed on the
Imports page." when jobs failed, and the public-link line for links. Retry failed reopens an
import but doesn't reply in Discord a second time once it has been notified.

**Reminder**: a second command automation runs `bamboo-tools nudge` (§4.9) and posts the text or
`NO_REPLY`. (M5's stopgap of treating a 404 as `NO_REPLY` ended in M6.)

**Automation errors** (`agent/tools/src/automation.ts`, §10 #51). OpenClaw posts a command
automation's stdout; when stdout is empty it posts **stderr** instead (both: a `stdout:`/`stderr:`
block); a bare `NO_REPLY` posts nothing; a non-zero exit records the run as an error and feeds
OpenClaw's own failure alerts (by default after 2 consecutive failures). So `replies` and `nudge`
never write stderr and handle errors themselves:

- **Transient** (a network error such as `fetch failed`, `ECONNRESET` or a timeout, or a 5xx or
  429 from the engine, after `Api`'s retries): `NO_REPLY`, exit 0, and a line in the local log.
  Once the engine has been unreachable for `tools.automation.outageAlertMinutes` (30), one
  message: "⚠️ Bamboo can't reach its server from the Mac (since 10:50). I'll keep trying." (the
  first failure's time, Mac local). Then nothing until a run succeeds, which adds "✅ Bamboo can
  reach its server again." (after its own reply, if it has one; `announceRecovery`). A blip that
  clears before the threshold posts nothing at all. A gap of more than `outageResetMinutes` (60)
  since the last failing run (the Mac was off) starts a new outage clock. The outage is shared by
  both commands, so it's announced once.
- **Anything else** (401/403 and other 4xx, a response that fails its contract schema, missing
  settings): misconfiguration, so it is reported: `⚠️ bamboo-tools <command>: <message>` on
  stdout with exit 1, the first time that command sees that exact error. While the same error
  repeats: `NO_REPLY`, exit 0 (so OpenClaw's failure alert doesn't post it a second time). A
  different error is reported again; a success clears it.

State: `~/.config/bamboo/automation-state.json` (`{outage: {since, last, alerted} | null,
reported: {command: message}}`; unreadable means empty). Log:
`~/Library/Logs/bamboo/bamboo-tools.log` (as the worker's; rolls to `.1` past `logMaxBytes`).
Neither holds conversation text. `import` is unchanged: the skill posts its `reply`, and the
diagnostic goes to stderr.

**Replies in Discord**: with one finished import, `replies` prints
`[[reply_to:<message id>]] <summary>` (OpenClaw threads it under Will's message, as PandaBase's
`jobs replies` does); with several, each summary is followed by a link to its message
(`discord.guild_id` in the tools config). Imports are marked notified before the text is printed,
as PandaBase does: a failed Discord post loses that reply, not the import.

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

**PDF** (`shared/src/segment.ts`, on `pdftotext -layout -enc UTF-8` output; `bamboo-tools` runs
`pdftotext` and, if it's missing, fails with "install poppler: brew install poppler"). Tunables
are `sharedConfig.segment`:

1. Measure each line's indent, then `normalizeText` it (§4.1) and **repair ligature damage**:
   `!`→fi, `#`→tt, `&`→fl, `%`→ft, only right after a letter or at a word start and right before
   a lowercase letter (`Simpli!ed`, `bo#le`, `&akes`, `o%en`; "Thanks! & 50%" is untouched).
   §4.1 leaves ligatures alone because the LLM copes, but Will's prompts have no hanzi (M0), so
   their turn keys are their letters: an unrepaired `bo#le` would key differently from the same
   prompt read from a link (§10 #34). The map is inferred from the four examples above; check it
   against a real export.
2. The title is the first non-blank line.
3. Drop boilerplate lines that match `segment.boilerplate` regexes: "Sign in", "Gemini may display
   inaccurate info…", "Google Privacy Policy…", "Your privacy & Gemini Apps", "Answering …
   standard", "Created with … Published …", the share-URL line, "Source: …", and the **"Explore
   related …" block** (header plus suggestion chips, up to the next run of
   `exploreGapBlankLines` (2) blank lines or a page break).
4. Collapse a line identical to the one before it when nothing, or only a page break (`\f`), lies
   between (page breaks repeat lines); the page gap goes with it, so a prompt split by the break
   stays one block.
5. **Speaker detection**: Will's messages are right-aligned bubbles. A *user block* is a run of
   lines with indent ≥ `userIndentMin` (20) that contain Latin letters (it may continue across a
   page break). It starts after a blank line, and the next non-blank line after it has indent <
   `replyIndentMax` (8); so an indented table cell inside a reply (no blank line before it) is
   not a prompt. Its lines are joined with spaces. Everything up to the next user block is the
   reply; text before the first block is dropped.
6. **Image-only prompts** (unverified; no real PDF yet): the bubble has no text, so no user block
   is found and the turn's reply joins the previous turn's reply. The previous turn's key (its
   prompt) is unchanged, so a PDF after a link still reports nothing new; a link after a PDF
   reports the image-only turn as 1 new. A PDF turn whose prompt is empty would get the
   reply-based key (§4.5) like a link's.

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

**The worker** (`worker/src/`, M4; tunables in `sharedConfig.worker`):

- **Prompt file format.** `extract_turn.v{N}.md` has three parts, each after a marker line:
  `<!-- system -->` (the system message), `<!-- user -->` (the user message, with
  `{{conversation_title}}`, `{{user_text}}` and `{{reply_text}}` filled in one pass) and
  `<!-- repair -->` (the repair turn, with `{{errors}}`: the Zod issues as `path: message` lines,
  never values). An empty `user_text` (pasted answer, image-only prompt) and a missing title get
  a short stand-in. The reply is cut to `maxReplyCharsForModel` (6,000) characters for the
  model, so prompt plus reply fit `num_ctx` 8192; the engine still checks verbatim against the
  whole turn (§10 #40).
- **Loop** (concurrency 1): heartbeat, then claim → run → `complete` → claim again at once; on
  204, wait `POLL_INTERVAL_SECONDS`. Claim errors back off, doubling up to 5 min. While the model
  isn't pulled or Ollama doesn't answer, it doesn't claim and re-checks every 60 s (logging the
  problem once). The heartbeat (startup, then every 10 min, between jobs) carries `version`, the
  checkout's short `sha`, `model` and `ollama_ok`.
- **Reporting.** Ollama failing mid-job (down, HTTP error, 180 s timeout) is reported as
  `failed` and stops claims until the model check passes again. 409 `stale_attempt` and 404 drop
  the job; 422 is logged (the engine already counted it). A `complete` that fails on the network
  or with a 5xx is retried after 5, 20 and 60 s, inside the 10-min lease; after that the lease
  runs out and the engine requeues it.
- **Logs** are one timestamped line per event (start, heartbeat, model state, one line per job:
  id, attempt, item count, repaired, seconds, the engine's answer). Never turn text, model output
  or tokens.
- **Eval** (opt-in, `BAMBOO_EVAL_OLLAMA=1`, `pnpm --filter @bamboo/worker test:ollama`): the synthetic
  turns in `worker/tests/fixtures/turns.json` through the real model; it requires every result
  to be contract-valid and an item verbatim rate ≥ `EVAL_MIN_VERBATIM` (0.8), and reports turn-kind
  agreement and example verbatim counts. The verbatim check it uses is the engine's
  (`shared/src/verbatim.ts`).

### 5.4 Tutor evaluation (`bamboo-eval`)

A one-off measurement for docs/ROADMAP.md › Tutor: is a local model a good enough Mandarin tutor
to replace asking Gemini? Not product behavior. `bamboo-eval` (`agent/tools/src/eval/`, run with
`make tutor-eval ARGS="…"`) is a separate entry point from `bamboo-tools`, so the OpenClaw skill
can't reach it; like the worker it calls only the local Ollama.

1. **Sample.** `GET /api/agent/eval/turns` with the agent token from `~/.config/bamboo/agent.env`
   (read like `bamboo-tools`; no new secret): ~20 questions and Gemini's answers, spread across
   imports, image-only turns skipped, deterministic for `--seed` and the same data.
2. **Replay.** Each question goes to each model (default `qwen3.5:9b`, `qwen3.5:27b`;
   `--models` overrides) through `POST /api/chat`, non-streaming, `think: false` (`--think`), model
   default sampling, `num_ctx` 8192. The system prompt's only copy is in docs/PROMPTS.md › *Tutor
   evaluation* (between markers); each run records its hash. The user message is the question as
   asked. Models run **one at a time**: a warm-up load (timed apart), every question, then unload
   with `keep_alive: 0`, except a model that was already loaded when the run began (PandaClaw's
   27B), which is left loaded. An unpulled model stops the run before anything loads; a failed
   load or answer is recorded and the run goes on. Per answer: latency (ms), `eval_count`,
   tokens/s (`eval_count / eval_duration`) and any error. `answers.json` is rewritten after each
   answer; re-running with the same `--out` retries only missing or failed answers.
3. **Blind page.** `judge.html` is self-contained (no network). Per question, Gemini's answer and
   each local answer appear in a seeded shuffle labeled A, B, C…; every answer gets the same
   Markdown-to-plain-text cleanup so formatting doesn't reveal the source; failed answers are left
   off. Will rates each answer 1–5 for accuracy (correct Mandarin, breakdown right) and
   naturalness, and picks a preferred answer. Ratings persist in localStorage; Export downloads
   `results-<run>.json`, Copy puts it on the clipboard. The label → source key (with timings) is
   `key.json`, never in the page. `serve` serves only the page and `POST results` under a random
   path token, on 127.0.0.1 unless `--host` (the Mac's Tailscale address) is given; "Save to Mac"
   writes `results.json`.
4. **Score.** `score` joins results with the key: per source, mean accuracy, mean naturalness,
   % preferred (of questions with a preference), median latency and tokens/s, rated and error
   counts.

**Privacy.** Everything is written to `~/bamboo-eval/<run id>/` (directory 700, files 600) in
the account that runs it; `bamboo-eval` refuses an `--out` inside the checkout, and `bamboo-eval/`
is gitignored as a backstop. Progress lines carry ids, model names and timings only. Tests use
synthetic questions and a fake Ollama.

**Running it on the Mac** (as `openclaw-agent`, from `~/Code/bamboo`, after the endpoint is
deployed and `make mac-update`):

```
make tutor-eval ARGS="run --seed <any word>"          # ~20 questions × 2 models; 20–45 min
make tutor-eval ARGS="serve --out ~/bamboo-eval/<run id> --host $(tailscale ip -4)"
#   Will opens the printed URL on his iPhone (Tailscale on), rates, taps "Save to Mac"
#   (or Export, then the file comes back by AirDrop and goes in that directory as results.json)
make tutor-eval ARGS="score --out ~/bamboo-eval/<run id>"
```

`--models qwen3.5:4b,qwen3.5:9b,qwen3.5:27b` adds the 4B; `--limit`, `--ollama-url` and
`--fixture <turns.json>` (a synthetic sample, no engine call: a dry run) are also accepted.
Runtime is dominated by the 27B: roughly 30–90 s per answer on the 32 GB Mac (9B: 10–30 s),
plus a minute or two per model load.

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
  - **Grading doesn't wait for the server.** The round's cards are already on the client, each
    with its interval preview per grade (`dueInMsByGrade`), so a grade shows the next card at once
    and decides any in-round repeat locally. Saves go through a client queue
    (`web/lib/save-queue.ts`): one at a time, in order, retried `config.review.saveRetries` (3)
    times with backoff from `saveRetryMs` (1 s). Each grade carries a client `reviewId`, stored as
    the review log's id, so a retry whose first attempt did land isn't graded twice. If a save
    still fails, the screen says "Couldn't save N answers" with **Retry**, and later saves wait
    behind it. Finishing the round (and ✕ to leave) waits until every save has landed. A repeated
    card's grade buttons wait for its own save (they need its new state). A tap within
    `config.review.revealGuardMs` (400 ms) of a grade doesn't reveal the next card, so a double
    tap can't show the next answer.
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
- **Stats** (`/stats`, the fifth tab): PRD §6 measures (§7), each with its target and ✓/✗.
- Today also shows the **reminder toggle** (§4.9).

**Audio** (`web/lib/audio.ts`): the Web Speech API. Voice choice: `lang` `zh-CN`, preferring an
"Enhanced"/"Premium" voice (e.g. Tingting). Rate 0.9, and 0.45 for slow replay
(`config.audio`). iOS Safari hands the rate to AVSpeechSynthesizer, which compresses the range:
0.6 sounded almost the same as 0.9 on an iPhone, so slow replay is half the normal rate (lower
than ~0.4 sounds smeared on desktop voices). Each play builds a fresh utterance with voice, lang
and rate set before `speak()`, and calls `cancel()` only when something is speaking or queued
(a `cancel()` right before `speak()` can drop the new utterance on WebKit). Speak the hanzi,
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
- `nudge_sent {local_time, nudge_at}` (`HH:MM`, household time)
- `worker_heartbeat {...}`

The Stats page shows, for the last 4 weeks (`config.stats`; pure measures in
`web/lib/domain/stats.ts`, queries in `web/lib/repo/stats.ts`):

- days with a finished round, per week: four rolling 7-day weeks of household days ending today,
  so "this week" is always whole (target ≥ 5);
- true retention: of `review_log` rows with `state_before` = Review and `source` = `session`
  (not learning steps, Already know, or the automatic Again from asking again), the share graded
  above Again (target ≥ 80%);
- asked-again count on active phrases (`asked_again` events with `status: 'active'`);
- the "Not useful" rate among phrases seen for the first time: `phrase_dropped` with
  `via: 'not_useful'` over those plus `phrase_introduced` (a Not useful phrase is never
  introduced), also split by kind and by usefulness (`manual` for hand-added) (target < 15%);
- the extraction drop rate: `dropped_not_verbatim` over `items` from `extraction` events
  (target < 5%);
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
| `BAMBOO_API_URL`, `BAMBOO_AGENT_API_TOKEN` (the engine's `AGENT_API_TOKEN`), `BAMBOO_CONFIG` (path to tools config: Discord ids; default `~/.config/bamboo/bamboo.config.json`) | tools | `~/.config/bamboo/agent.env` in the `openclaw-agent` account (mode 600); the process env wins over the file, which is safe only because every key is `BAMBOO_`-prefixed (§10 #42). Never in OpenClaw's gateway env, which every app's tools receive (§5.1). On a 401, `bamboo-tools` names where its token came from (`BAMBOO_AGENT_API_TOKEN in <agent.env path>`, or `environment variable BAMBOO_AGENT_API_TOKEN`), never the value (§10 #46) |
| `BAMBOO_API_URL`, `WORKER_API_TOKEN`, `OLLAMA_URL` (`http://localhost:11434`), `OLLAMA_TEXT_MODEL` (`qwen3.5:9b`), `POLL_INTERVAL_SECONDS` (15) | worker | `~/.config/bamboo/worker.env` in the `openclaw-agent` account (mode 600), from `ops/worker.env.example`; the worker reads it itself (`BAMBOO_WORKER_ENV` overrides the path). **The file wins** over the process env for every key it lists (§10 #45): its keys are generic, so an inherited `WORKER_API_TOKEN` or `OLLAMA_URL` can't override Bamboo's. A key the file leaves out still comes from the env |

### 8.2 Deploy

- **Vercel** Git integration: `main` → production; PRs → previews. The project's Root Directory
  is `web` (with files outside it included in the build).
- **Function region**: `"regions": ["pdx1"]` in `web/vercel.json` is the one setting. It
  **must match the Turso databases' region** (AWS `us-west-2`, Oregon; `pdx1` is Portland): every
  page and action makes database round trips, and from Vercel's default `iad1` each crossed the
  country (~70 ms). If the databases move, change `regions` with them
  (`web/lib/vercel-config.test.ts` pins it). The file's value overrides the dashboard's Function
  Region setting on each deploy.
- **Turso**: two databases, `bamboo` (prod) and `bamboo-preview`. Vercel env vars are scoped
  per environment; previews get their own `AUTH_SECRET` and machine tokens.
- **Migrations**: the Vercel build command (`web/vercel.json`) is
  `pnpm --dir .. db:migrate && pnpm build`, i.e. `pnpm db:migrate && pnpm --filter web build`
  from the repo root, run against whichever DB that environment points at. On Vercel,
  `db:migrate` fails the build if `TURSO_DATABASE_URL` is missing or local, or
  `TURSO_AUTH_TOKEN` is missing, so a misconfigured environment never deploys. Migrations must be **expand → contract**:
  add freely; drop or rename only in a later PR once no deployed code uses the column.
- **The daily job** is a Vercel **Schedule** (M6; Cron Jobs are legacy): `schedules.daily` in
  `web/vercel.json`, `17 11 * * *` in UTC (no `timezone`, so it stays 11:17 UTC, about 04:00 in Los
  Angeles), a `path` target `/api/cron/daily` with `requestMethod: "GET"` (Schedules POST by
  default). Vercel still sends `Authorization: Bearer <CRON_SECRET>` and `user-agent:
  vercel-cron/1.0`, so the route's check is unchanged. Runs start within a jitter window (1 min on
  Pro, 15 min on Hobby; legacy Hobby crons could run any time in the hour), aren't retried on an
  error, and may very rarely be delivered twice; the job is idempotent. Static schedules are
  active in production only (inactive on preview branches). It's under the project's
  **Schedules** page in the dashboard, with per-run history and *Run Schedule*. Schedules are in
  beta: if Vercel changes the format, the fallback is the old
  `"crons": [{"path": "/api/cron/daily", "schedule": "17 11 * * *"}]` (never both: the job would run
  twice; `web/lib/vercel-config.test.ts` checks).

### 8.3 Mac mini

- **Two macOS users** (as PandaBase set the Mac up): OpenClaw's gateway, Ollama and PandaBase's
  agent-side checkout run as a dedicated standard user, **`openclaw-agent`** (home
  `/Users/openclaw-agent`, mode 750, so other accounts can't read it). Will operates it from his
  own account over `ssh agent`. Everything Bamboo runs on the Mac belongs in that account too: the
  checkout at **`~/Code/bamboo`** (PandaBase's is `~/Code/pandabase` there), `~/.config/bamboo/`,
  `~/.local/bin/bamboo-tools`, and M4's worker LaunchAgent (`~/Library/LaunchAgents`, logs in
  `~/Library/Logs/bamboo/`). Run `make agent-install`, `make worker-install` and
  `make mac-update` as `openclaw-agent`. Development sessions in Will's own account can run
  `bamboo-tools segment` (no API calls), but never install anything for the gateway.
- Prereqs: `brew install poppler` (for `pdftotext`, at `/opt/homebrew/bin`), Node 24, pnpm, and
  Ollama with `qwen3.5:9b` pulled (already there for PandaBase). No browser: share links are read
  over HTTPS (§5.2). The `bamboo-tools` wrapper puts `/opt/homebrew/bin` on its PATH, since
  OpenClaw's command automations run `sh -lc` with whatever PATH the gateway has.
- **Worker**: everything below runs as `openclaw-agent`, from its own checkout (`~/Code/bamboo`).
  `make worker-install` (`ops/scripts/worker-install.sh`) is idempotent, and `DRY_RUN=1` prints
  what it would do. It runs `pnpm install --frozen-lockfile`; creates `~/.config/bamboo/` (700)
  and, **only if it is missing**, `~/.config/bamboo/worker.env` (600) from
  `ops/worker.env.example` (an existing file is never overwritten or printed; its mode is reset
  to 600); renders the LaunchAgent `ops/launchd/com.bamboo.worker.plist` into
  `~/Library/LaunchAgents/` (repo, home, `node` path, env-file path and log dir filled in; no
  secret in it) and loads it with `launchctl bootstrap gui/<uid>`, re-loading only when the
  rendered plist changed. While `WORKER_API_TOKEN` is empty it stops before loading and says so.
  The plist runs `node --import tsx src/main.ts` in `worker/` directly, not through pnpm, so
  launchd's SIGTERM reaches the worker (§10 #38); `KeepAlive`, `ThrottleInterval` 30 s,
  `ExitTimeOut` 300 s (room to finish a job), logs to `~/Library/Logs/bamboo/worker.log`. The
  worker sends a heartbeat at startup and every 10 min, and claims jobs only if the model is
  pulled (`GET /api/tags`). SIGTERM finishes and reports the current job, then exits; a second
  SIGTERM exits at once. A missing or incomplete `worker.env` exits 78 after 5 min (so `KeepAlive`
  doesn't spin), with the missing variable names in the log.
  `make worker-logs` prints the launchd state and the last heartbeat line, then
  `tail -F`s the log (`FOLLOW=0` prints and exits).
- **Agent**: `make agent-install` (`agent/install.sh`, as `openclaw-agent`) is idempotent and
  additive, and `DRY_RUN=1` prints what it would do. It runs `pnpm install --frozen-lockfile`;
  links `~/.local/bin/bamboo-tools` to `agent/tools/bin/bamboo-tools` (a wrapper that runs the CLI
  with tsx); creates `~/.config/bamboo/bamboo.config.json` from
  `agent/bamboo.config.example.json` (ids from `BAMBOO_DISCORD_CHANNEL_ID` and
  `BAMBOO_DISCORD_GUILD_ID`) and `~/.config/bamboo/agent.env` (`BAMBOO_API_URL` from the
  environment, `BAMBOO_AGENT_API_TOKEN` left empty for Will) if they're missing, renaming an older
  file's unprefixed `AGENT_API_TOKEN`; and adds
  `<checkout>/agent/skills` to OpenClaw's `skills.load.extraDirs` after backing up
  `openclaw.json` (`openclaw.json.bak.<timestamp>`), replacing only a stale *Bamboo* entry
  (`openclaw config set` applies it live; no restart). Once the token is filled in, a re-run adds
  or updates two command automations, announcing to `#bamboo`: `bamboo-replies`
  (`*/5 * * * *`) and `bamboo-nudge` (`*/30 17-23 * * *`, i.e. 17:00–23:30), in
  `automations.tz`. It pins `#bamboo`'s existing channel entry to the bamboo skill (§5.1:
  `skills`, `systemPrompt`, `tools.deny`), merged in with one `openclaw config set` of that
  entry after the backup, so `enabled`, `requireMention`, `requireMentionInBotThreads`, `users`
  and every other channel (`#pandabase`, `*`) stay as they are; a re-run with the pin in place
  changes nothing. It never touches `~/.openclaw/.env`, PandaBase's automations or the Discord
  allowlist: if `#bamboo` has no entry yet, it prints the
  `openclaw config set channels.discord.guilds.<guild>.channels.<channel> …` command for Will
  (copy `#pandabase`'s entry: `enabled`, `requireMention: false`, the same `users`; the printed
  entry already includes the pin).
- **The bamboo agent** (§5.1, §10 #50), also in `make agent-install`, once
  `discord.channel_id` is set (the only id it needs; nothing is hard-coded): sets
  `agents.defaults.systemAgent.agentId` to `main` only if it's unset (any other value is left
  alone, with a warning); runs `openclaw agents add bamboo --workspace
  ~/.openclaw/workspace-bamboo --model <agent.model> --non-interactive` if
  `agents.entries.bamboo` is missing; sets its `thinkingDefault` to `off` and `skills` to
  `["bamboo"]` if they differ (its model is left as it is); writes the workspace `AGENTS.md`
  generated from `SKILL.md`, moving `BOOTSTRAP.md`, and an `AGENTS.md` that isn't ours, to
  `.orig/` (never over an earlier copy); and merges the `#bamboo` binding into `bindings`: ours
  first, every other binding kept in order, minus any other binding for the same channel and the
  bamboo agent's binding to a stale channel id (`mergeBindings`). If `bindings` doesn't read as a
  list, it changes nothing and prints the binding to add, so main's can't be lost. Every step is a
  no-op when already in place, and `openclaw.json` is backed up before the first change. It ends
  with `make agent-check`.
- `make agent-check` (`agent/check.sh`, read-only, exits 1 on a problem): systemAgent is `main`;
  the bamboo agent exists with `thinkingDefault` `off` and `skills` `["bamboo"]`; `#bamboo`
  routes to it (the first binding matching the channel, `routeFor`, so ours wins whether OpenClaw
  takes the first or the most specific match); main still has a Discord binding (a warning only);
  the workspace `AGENTS.md` is byte-for-byte what `SKILL.md` generates; no `BOOTSTRAP.md`.
- `make mac-update` (as `openclaw-agent`) runs `git pull --ff-only`,
  `pnpm install --frozen-lockfile`, then `worker-install` again: it reloads the LaunchAgent if
  the plist changed, and otherwise `launchctl kickstart -k`s the worker only if the pull brought
  new commits. `worker.env` is never touched. Then it runs `make agent-install`, so a pulled
  `SKILL.md` change reaches the agent's `AGENTS.md` (a no-op otherwise).

### 8.4 Private data

Real conversations reach the Mac only through Discord, as links or as attachments that OpenClaw
stores. Will never needs to put files on the Mac's filesystem. If a developer session saves a
copy while debugging, it goes in `private/` at the repo root, which is
gitignored. Real conversations are never committed, never used as test fixtures, and never quoted
in docs, PRs or commit messages (counts only). Test fixtures are synthetic (Appendix A). The
tutor evaluation's outputs (real questions, Gemini's and the models' answers, ratings) live only in
`~/bamboo-eval/` in the account that ran it (§5.4).

### 8.5 Request timing

`web/lib/timing.ts` measures each page render (`page /…`), server action (`action …`) and API
route (`GET /api/…`): total ms, database ms (summed), database calls (one per libSQL `execute` or
`batch`) and `db_serial`, the calls started with nothing else in flight (≈ sequential round
trips, what distance to the database multiplies). The one DB client (`repo/db.ts`) is wrapped
once; an `AsyncLocalStorage` (one per process, shared by Next's bundles) ties calls to the
request. Each request logs one JSON line, visible in Vercel's logs:

```
{"msg":"timing","route":"page /","status":200,"total_ms":9,"db_ms":5.2,"db_queries":5,"db_serial":1}
```

Only these fixed fields are logged: no ids, phrase text or anything Will typed. API routes also
send `Server-Timing: total;dur=…, db;dur=…;desc="N queries"`. Pages and server actions can't
set response headers in Next.js, so they have the log line only. Redirects and `notFound()` log
their status; Next's own render bailouts aren't logged.

Reads that don't depend on each other go in one libSQL `batch` (one round trip).
`web/lib/repo/query-count.test.ts` pins the calls per request in the review flow:

| Request | Calls (sequential) |
|---|---|
| Today | 5 (1) |
| Start (`startRound`) | 2 (2) |
| Review page (`getRound`) | 1 (1) |
| Grade a new card | 3 (3) |
| Grade any other card | 2 (2) |
| Finish the round | 2 (2) |

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
              tests/fixtures/ (synthetic PDF text + expected turns)
  worker/     @bamboo/worker — src/ (claim loop, engine and ollama clients, config, eval),
              prompts/, tests/fixtures/ (synthetic turns, recorded Ollama responses)
  agent/      skills/bamboo/SKILL.md; install.sh (`make agent-install`);
              tools/ (@bamboo/tools → bin/bamboo-tools; src/ cli, share, pdf, importer, api, env;
              src/eval/ bamboo-eval, the tutor evaluation (`make tutor-eval`, §5.4);
              tests/fixtures/ synthetic share page, fake-openclaw); bamboo.config.example.json
  private/    gitignored
  ops/        launchd/com.bamboo.worker.plist; scripts/ (worker-install, worker-logs, mac-update);
              worker.env.example
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
| 33 | Bamboo's Mac-side settings live in `~/.config/bamboo/` (token in `agent.env`), read by `bamboo-tools` itself; the skill gates on its binary only | The OpenClaw gateway is shared, and its env already holds PandaBase's `AGENT_API_TOKEN` under the same name; a second value there would collide, and new gateway env needs a restart that would disrupt PandaBase |
| 34 | The PDF segmenter repairs ligature damage (`!`→fi, `#`→tt, `&`→fl, `%`→ft, next to letters) | Will's prompts have no hanzi, so their turn keys are their English letters; unrepaired, a PDF of a conversation already imported by link would look all new |
| 35 | `bamboo-tools import` prints the skill's reply text (`reply`), and the skill posts it verbatim | Keeps every user-visible line ("Nothing new" plus the public-link line, the failure asks) in tested code instead of the reply model's wording |
| 36 | Everything Bamboo installs on the Mac lives in the `openclaw-agent` account, checkout at `~/Code/bamboo` | That user owns OpenClaw, Ollama and PandaBase's checkout; its home isn't readable from Will's account, and the gateway can only run what that user can read |
| 37 | Command automations are added only once `BAMBOO_AGENT_API_TOKEN` is set | Otherwise they would run every 5 and 30 minutes and fail; re-running `make agent-install` after filling the token adds them |
| 38 | The worker's LaunchAgent runs `node --import tsx src/main.ts` directly, with `ExitTimeOut` 300 s; it reads `worker.env` itself | Through `pnpm … start`, launchd's SIGTERM would hit pnpm, not the worker, so "finish the current job" couldn't be relied on; launchd's default 20 s before SIGKILL is shorter than one model call. Reading the file in the worker keeps the token out of the plist and lets `worker-install` render it without secrets |
| 39 | The verbatim check moved from `web/lib/domain/queue.ts` to `shared/src/verbatim.ts` | The worker's eval must measure exactly what the engine drops; one implementation, re-exported by `queue.ts` |
| 40 | The worker cuts the reply to 6,000 characters for the model (`maxReplyCharsForModel`) | Prompt plus reply must fit `num_ctx` 8192, which stays at PandaBase's value so the shared model isn't reloaded; the engine checks verbatim against the whole turn either way, so nothing invented gets in |
| 41 | Ollama failing mid-job is reported as `failed` and pauses claims until the model check passes; `worker-install` doesn't load the worker until `WORKER_API_TOKEN` is set | Reporting uses one attempt either way (an unreported job's lease would expire too) and gets the job retried sooner; pausing stops a down Ollama from burning every queued job's attempts. A worker without a token would only restart in a loop |
| 42 | On the Mac, every key `bamboo-tools` reads is `BAMBOO_`-prefixed: the agent token is `BAMBOO_AGENT_API_TOKEN` (the engine and Vercel keep `AGENT_API_TOKEN`) | OpenClaw passes `~/.openclaw/.env` to every app's tools, and the process env wins over `agent.env`. With the unprefixed name, PandaBase's `AGENT_API_TOKEN` reached `bamboo-tools`, which sent it to Bamboo's engine. PandaBase prefixes its side too (`PANDABASE_AGENT_API_TOKEN`) |
| 43 | `make agent-install` pins `#bamboo` in OpenClaw's config: `skills: ["bamboo"]`, a firm `systemPrompt`, and `tools.deny` of the media/link readers (`view_image`, `pdf`, `web_fetch`, `web_search`, `x_search`, `browser`, `code_execution`), merged into the existing channel entry | A skill alone is a suggestion: the shared agent (local `qwen3.5:27b`) answered a bare share link with `view_image` on it, which both broke intake and had the OpenClaw side read conversation content. Per-channel config removes the other skills and the reading tools before the model call, so routing doesn't depend on the model's choice; access keys and other channels are Will's and stay untouched |
| 44 | The daily job moved from Cron Jobs to Vercel Schedules (static, `path` target, `GET`, UTC) | Vercel marks Cron Jobs legacy and will migrate them; a static schedule keeps the route, its `CRON_SECRET` bearer check and its 11:17 UTC time (within a 1–15 min jitter window), and adds per-run history and *Run Schedule*. A private `function` target would drop the public URL but needs `@vercel/schedules` and an experimental trigger; not worth it for one idempotent job behind a secret |
| 45 | `worker.env` wins over the process env for the keys it lists | Its keys are generic (`WORKER_API_TOKEN`, `OLLAMA_URL`, `OLLAMA_TEXT_MODEL`): a shell or job that inherited another app's value would otherwise send the wrong token or talk to the wrong Ollama, the same failure #42 fixed for `bamboo-tools` by prefixing. Renaming the worker's keys would break every existing `worker.env`; making the file authoritative doesn't |
| 46 | On a 401, `bamboo-tools` names its token's source (file and key, or env var), never the value | A 401 from a working setup almost always means the wrong token was picked up (#42); naming the source makes that a one-line diagnosis in OpenClaw's logs without ever printing a secret |
| 47 | The reminder learns from practice days (first finished round per household day), not every round | "Another round" or an abandoned round would otherwise pull the median; the reminder is about when the day's first round usually happens |
| 48 | Discord replies show pinyin next to every hanzi, from the phrase's stored pinyin plus overrides; a long summary trims Next up, never the pinyin | New phrases use characters Will can't read yet, so hanzi with English alone isn't readable. Reusing the stored, computed reading (never an LLM's) keeps Discord and the PWA identical, overrides included. Fewer named phrases loses little (the queue is in the PWA); hanzi without pinyin would defeat the point |
| 49 | The tutor evaluation reads its sample through a read-only agent-token route (`GET /api/agent/eval/turns`), sampled on the engine; its harness is `bamboo-eval`, separate from `bamboo-tools`; its prompt's one copy is in docs/PROMPTS.md, not `worker/prompts/` | The engine owns the data and the sampling rule, and the Mac already holds the agent token, so no new secret or DB access. Returning only the sampled turns keeps the export minimal. A separate entry point keeps model calls out of the CLI OpenClaw invokes. The prompt isn't a worker job prompt (no `prompt_version` on jobs); a run records its hash instead |
| 50 | `#bamboo` is served by a dedicated OpenClaw agent, `bamboo` (thinking off, the skill's body inline in its workspace `AGENTS.md`, bound to the channel ahead of main's Discord binding); `make agent-install` applies it and `make agent-check` verifies it | The shared `main` agent took 75–120 s per message, nearly all thinking; the same model with thinking off answers in ~5–25 s, and OpenClaw sets thinking per agent, not per channel. With thinking off the model doesn't open `SKILL.md` and guessed flags; inline, it chose right every time. Generating `AGENTS.md` from `SKILL.md` keeps one source of truth. Routing is applied, not just printed: the merge only prepends one binding and keeps every other, refuses an unreadable `bindings`, leaves a non-`main` systemAgent alone, and is backed up and idempotent; the Discord ids come from `bamboo.config.json` |
| 51 | `replies` and `nudge` swallow transient engine errors (network, timeout, 5xx, 429): one alert only after 30 min of outage, one line on recovery; other errors are reported once per distinct error; they never write stderr | One network blip posted `bamboo-tools replies: GET /api/agent/notifications: fetch failed` to `#bamboo`, because OpenClaw announces stderr when stdout is empty. Polls every 5 minutes make a blip routine and self-healing, so Will should hear only about a real outage. Auth and contract errors don't heal by themselves, so they're still posted, but once rather than every 5 minutes. Exiting 0 while quiet keeps OpenClaw's own failure alerts out of the channel too |
| 52 | Functions run in `pdx1` (`regions` in `web/vercel.json`), next to Turso in `us-west-2` | Vercel's default `iad1` put every DB round trip across the country; a page with a few sequential reads took seconds on Will's phone. One documented setting, pinned by a test, that must follow the database |
| 53 | Request timing is our own: a wrapped libSQL client, an `AsyncLocalStorage` per request, one JSON log line, `Server-Timing` on API routes | No dependency or tracing backend for a one-user app. Wrapping the client counts what Drizzle actually sends. Next.js offers no response headers for pages or actions, so the log line is the common denominator. Fixed fields only, so logs never carry Will's data |
| 54 | Independent reads go in one libSQL `batch`; a grade reads the card, its siblings and the retry check in one batch | Round trips, not query cost, dominate latency to a remote DB. A batch is one request with no new API; in the review flow (Today / Start with the review page / grade a new card / grade another / finish) calls went from 9/9/4/3/6 to 5/3/3/2/2 and sequential trips from 2/6/4/3/3 to 1/3/3/2/2 |
| 55 | Grading shows the next card at once and saves in the background (ordered queue, retries, idempotent `reviewId`) | The round's cards and each grade's interval preview are already on the client, so nothing about the next card depends on the save. Ordered saves keep a card's repeated grades in sequence; the client id makes a retry safe when only the response was lost; a stuck save is shown with Retry and blocks finishing, so Today never counts a round with lost answers |
| 56 | Slow replay is 0.45 (was 0.6); `cancel()` only when busy | iOS compresses Web Speech rates (WebKit → AVSpeechSynthesizer), so 0.6 vs 0.9 was barely audible. Half the normal rate stays clear on desktop voices too. Must be checked by ear on an iPhone |
| 57 | Learning cards in a round come in a per-round seeded order; review cards stay most overdue first, new cards stay in queue order | With all-Good answers, a new card rated Good is due again in 10 minutes (the second learning step, inside learn-ahead), so it's in the next round; ordered by due, the card graded first always led that round, which Will noticed as "the same card first every round". The shuffle is seeded by the round's start, so `buildRound` stays pure and testable. It changes no scheduling: whether a card answered right should come back the same evening at all (the 10-minute step) is a separate question for Will |

## Appendix A — Synthetic fixtures

**PDF text** (`shared/tests/fixtures/gemini-export.txt`, the `pdftotext -layout` output, with
its exact expected turns in `gemini-export.expected.json`; tests start from text, so CI doesn't
need poppler. A test in `agent/tools` also runs the real `pdftotext` on a tiny generated PDF when
poppler is installed, and is skipped otherwise). Invented content reproducing every quirk of the real
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
