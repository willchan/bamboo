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
                       └──────▲──────────────────────▲─────────────────────▲─────────────┘
         presigned PUT        │ HTTPS (bearer)       │ HTTPS (bearer)      │
  iOS Shortcut / PWA ─▶ R2    │ CAPTURE token        │ WORKER token        │ web-push
  (imports/*.pdf)             │                      │                     ▼
                              │   ┌──── Mac mini (M6, 32GB) — outbound only ────┐   iPhone
                     iOS Shortcut │  bamboo-worker (Node 24, launchd)           │
                                  │   ├─ polls /api/jobs/claim                  │
                                  │   ├─ pdftotext (poppler) → segment turns    │
                                  │   └─ Ollama client ──▶ Ollama (shared with  │
                                  │                         PandaBase, Metal)   │
                                  └─────────────────────────────────────────────┘
```

**Ownership rule (same as PandaBase):** the State Engine (`/web` + `/db`) owns all data and
business logic: dedupe, ranking, validation of LLM output, scheduling. The worker is a stateless
transformer (PDF → turns, turn → raw extraction) that talks only to the HTTP API.

### 1.1 Components

| Component | Runs on | Responsibility |
|---|---|---|
| `/web` | Vercel | UI (PWA), API, domain logic, daily cron |
| `/db` | package | Drizzle schema, migrations, seed and phrase-import scripts (`@bamboo/db`) |
| `/shared` | package | Zod contracts shared by web and worker, text normalization (`@bamboo/shared`) |
| `/worker` | Mac mini, native Node via launchd | Claims jobs, runs `pdftotext`, segments turns, calls Ollama, posts results |
| Ollama | Mac mini, native | Local LLM. **Shared with PandaBase**; see §1.2 |
| R2 | Cloudflare | Uploaded import PDFs (private bucket, 30-day lifecycle) |

### 1.2 Mac mini resource budget

PandaBase already runs on this Mac (its DESIGN §1.2). Its host settings
`OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1` apply to Bamboo too. Therefore:

- Worker concurrency = **1**.
- Default model **`qwen3.5:9b`**, the same model PandaBase uses for vision, so the two workers
  rarely force a model swap. It is configurable via `OLLAMA_TEXT_MODEL`. Qwen is strong at
  Chinese, and the task is copy-and-classify, not writing Chinese.
- Requests: `think: false`, `temperature: 0`, `num_ctx: 8192`, `keep_alive: "2m"`, `format` set
  to the JSON schema of the result contract.
- A backlog import (~70 turns) takes roughly 20–40 min of model time. That's fine: it is a batch job.

## 2. Data model

Turso/libSQL via Drizzle. IDs are ULIDs (text). Times are integer ms since epoch
(`timestamp_ms`). JSON columns use `text({ mode: 'json' })` with a Zod type.

### 2.1 Phrases and cards

**`phrase`**: one thing worth remembering.

| column | type | notes |
|---|---|---|
| `id` | text pk | |
| `lang` | `'cmn' \| 'yue'` | Mandarin / Cantonese |
| `kind` | `'term' \| 'frame' \| 'sentence'` | frames contain `…` as the slot |
| `hanzi` | text | normalized (§4.1) |
| `hanzi_key` | text | dedupe key (§4.1); **unique with `lang`** |
| `english` | text | meaning (term) or intent (frame/sentence) |
| `addressee` | text null | `yuesao`, `toddler`, `nanny`, `inlaws`, `anyone` (free text allowed) |
| `heard_as` | text null | what Will typed when decoding ("podafen") |
| `note` | text null | short usage note |
| `tags` | json `string[]` | domains: `feeding`, `baby`, `food`, `groceries`, `household`, `toddler`, `family`, `units`, `holiday`, … |
| `romanization` | json `[char, roman \| null][]` | computed (§4.2), never from the LLM |
| `romanization_override` | json null | same shape; Will's per-syllable edits |
| `source` | `'manual' \| 'import' \| 'seed'` | |
| `source_turn_id` | text null | fk `turn` |
| `asked_count` | int default 1 | +1 each time an import shows he asked again |
| `last_asked_at` | int null | |
| `suspended` | bool default false | |
| `created_at`, `updated_at` | int | |

**`card`**: `unique(phrase_id, type)`.

| column | type | notes |
|---|---|---|
| `id` | text pk | |
| `phrase_id` | text fk | |
| `type` | `'say' \| 'listen'` | |
| FSRS state | | the ts-fsrs `Card` fields as columns: `due`, `stability`, `difficulty`, `elapsed_days`, `scheduled_days`, `learning_steps`, `reps`, `lapses`, `state`, `last_review` |
| `introduced_at` | int null | first time shown (counts toward the daily new cap) |
| `buried_until` | int null | sibling burying (§4.4) |
| `created_at` | int | |

**`review_log`**: append-only. `id`, `card_id`, `rating` (1–4), `source`
(`'session' | 'real_use' | 'asked_again'`), `reviewed_at`, `duration_ms` null, `fsrs_log` json
(the ts-fsrs `ReviewLog`).

### 2.2 Imports, turns, candidates

**`import`**: `id`, `kind` (`'pdf' | 'text'`), `r2_key` null, `status`
(`'queued' | 'segmenting' | 'extracting' | 'done' | 'failed'`), `turns_total`, `turns_new`,
`error` null, `created_at`, `finished_at` null.

**`turn`**: one user message plus Gemini's reply.

| column | notes |
|---|---|
| `id`, `import_id` | first import that contained it |
| `turn_key` | **unique**; §4.5 |
| `user_text`, `reply_text` | normalized; `reply_text` capped at 12,000 chars |
| `position` | index within its first import |
| `kind` | null until extracted; `'decode' \| 'say' \| 'errand' \| 'other'` |
| `extracted_at` | null until extracted |

**`candidate`**: an extracted item awaiting a decision.

| column | notes |
|---|---|
| `id`, `turn_id` | |
| `lang`, `kind`, `hanzi`, `hanzi_key`, `english`, `addressee`, `heard_as`, `tags` | as `phrase` |
| `ask_count` | int default 1; merged duplicates add to it |
| `score` | real; §4.6 |
| `flags` | json `string[]`, e.g. `long`, `heard_as_dropped` |
| `status` | `'pending' \| 'kept' \| 'skipped' \| 'expired' \| 'merged'` |
| `phrase_id` | set when kept, or when merged into an existing phrase |
| `expires_at`, `created_at`, `decided_at` | |

### 2.3 Platform

- **`job`**: the PandaBase job queue, simplified. Columns: `id`, `type`
  (`'segment_import' | 'extract_turn'`), `status` (`'queued' | 'leased' | 'done' | 'failed'`),
  `input` json, `result` json null, `attempt` int, `lease_expires_at` null, `model` null,
  `prompt_version` null, `error` null, `created_at`, `finished_at` null.
- **`event`**: telemetry. Columns: `id`, `type`, `data` json, `at`. See §7.
- **`push_subscription`**: `id`, `endpoint` unique, `keys` json, `created_at`. Added in M7.
- **`setting`**: key/value for user preferences: `push_local_time`, `review_lang_filter`.

## 3. API and auth

### 3.1 Auth

- **UI**: Auth.js v5 with Google. Sign-in is allowed only for emails in `ALLOWED_EMAILS`.
  Sessions are JWT with a 90-day max age, so the home-screen PWA rarely signs out.
  `DEV_AUTH_BYPASS=1` (local and e2e only, refused when `VERCEL_ENV=production`) signs in a fixed
  dev user.
- **Machines**: bearer tokens, compared in constant time.
  - `WORKER_API_TOKEN`: `/api/jobs/*` and `/api/worker/*`.
  - `CAPTURE_API_TOKEN`: `/api/imports*` only (for the iOS Shortcut).
  - `CRON_SECRET`: `/api/cron/*` (Vercel Cron sends it as a bearer).
- UI mutations use **server actions**; the routes below exist for machines and for the
  upload flow.

### 3.2 Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/imports/upload-url` | session or capture | `{content_type}` → `{key, url}`: presigned R2 PUT, 15 min, `imports/{yyyy}/{mm}/{ulid}.pdf`, ≤ 50 MB |
| `POST /api/imports` | session or capture | `{kind:'pdf', key}` or `{kind:'text', user_text?, reply_text}` → `{import_id}`. PDF → queues `segment_import`. Text → creates one turn directly (§4.5) and queues `extract_turn` if new |
| `GET /api/imports/{id}` | session or capture | status and counts |
| `POST /api/jobs/claim` | worker | `{types: [...]}` → a job or `204`. Lease = `jobs.leaseMinutes` (10); `attempt += 1`. `segment_import` includes a presigned R2 GET |
| `POST /api/jobs/complete` | worker | `{job_id, attempt, status:'done', result, model?, prompt_version?}` or `{…, status:'failed', error}`. A stale `attempt` returns `409`. The result is validated against the job type's contract and applied in the same transaction (§5) |
| `POST /api/worker/heartbeat` | worker | `{version, sha, model, ollama_ok, pdftotext_ok}` → `event` |
| `GET /api/cron/daily` | cron | expire candidates (§4.7), requeue expired leases, prune events > 180 d; M7: send the push |
| `POST /api/push/subscribe` | session | M7 |

Contracts are Zod schemas in `shared/src/contracts/`. Web and worker import the same schemas
(there is no codegen; everything is TypeScript).

## 4. Algorithms

All of these are pure functions in `web/lib/domain/` (or `shared/` where the worker also needs
them), with unit tests. Every tunable lives in `web/lib/config.ts`.

### 4.1 Text normalization (`shared/src/text.ts`)

PDF text from Gemini share pages has two kinds of damage, both seen in the real export:

- **Kangxi / CJK-radical lookalikes**: `⺟⽉⼀⼉⽤⾼` instead of `母月一儿用高`. 55 distinct ones
  appeared in a 105-page export.
- **Broken English ligatures**: `Simpli!ed`, `bo#le`, `&akes`, `o%en`. These are left alone,
  because they're English and the LLM copes.

`normalizeText(s)`:

1. NFKC. This maps the Kangxi Radicals block (U+2F00–2FD5) and most of U+2E80–2EFF.
2. Apply an explicit map for the CJK Radicals Supplement characters that NFKC leaves alone. Seen so
   far: `⻄→西 ⻋→车 ⻓→长 ⻛→风 ⻥→鱼 ⻧→麦`. Extend the table as needed; any other character
   left in U+2E80–2FDF is kept, with a `normalize_unmapped_radical` event.
3. Collapse whitespace runs inside lines and trim.

`hanziKey(s)` = `normalizeText(s)` with everything except CJK ideographs, ASCII letters and
digits removed, letters lowercased. `阿姨，您是说…吗？` → `阿姨您是说吗`. The key does **not**
convert between simplified and traditional characters.

### 4.2 Romanization (`web/lib/domain/romanize.ts`)

- **cmn**: `pinyin-pro` with tone marks, `type: 'all'` (or the equivalent per-character output
  in the installed version), and tone sandhi enabled only for 一/不. The output is aligned
  per character: `[char, syllable | null]`, with `null` for non-hanzi.
- **yue**: `to-jyutping` (`getJyutpingList`) → `[char, jyutping | null]`, using tone numbers.
- Romanization is recomputed whenever `hanzi` changes. If an override exists and the new hanzi
  differs, the override is dropped and the UI shows "romanization override cleared".
- Display (§6): ruby text above each hanzi, using the override where present.
- Gemini's own pinyin is **never stored**. Its errors are the reason this module exists.

### 4.3 Scheduling (FSRS)

`ts-fsrs` (6.x). Parameters live in `config.fsrs`:
`request_retention: 0.85`, `maximum_interval: 365`, `enable_fuzz: true`,
`enable_short_term: true`, `learning_steps: ['1m', '10m']`, `relearning_steps: ['10m']`.
Check the parameter names against the installed version.

**Day boundary**: 04:00 in `HOUSEHOLD_TZ` (default `America/Los_Angeles`).

### 4.4 Session builder (`web/lib/domain/session.ts`)

`nextCard(now, state)` returns the next card or `done`:

1. **Limits** (`config.session`): at most `newPerDay` (3) new cards introduced per day;
   at most `maxReviews` (20) cards per session. The client also stops at `maxMinutes` (5) and
   shows *Done*, with "5 more" as an option that raises the review limit by 5.
2. **Order**: learning/relearning cards whose step is due → review cards due today (most overdue
   first) → new cards. New cards are interleaved, roughly one per 5 reviews, so they don't all
   come at the end. New cards are taken in kept order (oldest kept first).
3. **Siblings**: once one card of a phrase has been shown today, the phrase's other card is
   buried until tomorrow (`buried_until`).
4. **Language filter**: the `review_lang_filter` setting (`all | cmn | yue`).
5. Grading applies the ts-fsrs `next()` result, writes `review_log`
   (`source: 'session'`) and sets `introduced_at` on first sight.

**Used it ✓** (`markUsed(phrase_id)`): pick the phrase's `say` card (or `listen` if it has no
`say` card). If it has not been reviewed today, apply **Good** with `source: 'real_use'`.
Otherwise, only log a `real_use` event. Real use never counts toward `newPerDay`.

**Asked again** (§5.3): apply **Again** with `source: 'asked_again'` to every non-new card of
the phrase, at most once per phrase per import.

### 4.5 Turn identity

`turn_key = sha256(hanziKey(user_text))`, keyed on **Will's own words only**. Re-exporting the
conversation re-flows the reply text (page breaks, duplicated lines), but his short prompts come
through stably. Two genuinely identical prompts on different days collapse into one. That is
rare and harmless.

Text imports: `turn_key = sha256(hanziKey(user_text ?? '') + '\n' + hanziKey(reply_text))`.

### 4.6 Candidate validation and ranking (`web/lib/domain/candidates.ts`)

On `extract_turn` completion, for each raw item:

1. `hanzi = normalizeText(item.hanzi)`. **Drop** the item if `hanziKey(hanzi)` has no CJK
   character, or if it does not occur in `hanziKey(user_text + reply_text)` (the verbatim check
   stops the model inventing Chinese). Count drops in telemetry.
2. Keep `heard_as` only if it occurs (case-insensitive, spaces ignored) in `user_text`;
   otherwise null it and add the `heard_as_dropped` flag.
3. If a `phrase` exists with the same `(lang, hanzi_key)`: set candidate status to `merged`,
   increment `phrase.asked_count`, set `last_asked_at`, and apply *asked again* (§4.4).
   That phrase does not appear in the inbox.
4. Else, if a `pending` candidate exists with the same `(lang, hanzi_key)`, add 1 to its `ask_count`,
   re-score it, and push its expiry forward. Don't create a new candidate.
5. Else, create a candidate with `expires_at = now + config.inbox.ttlDays` (14).

`score` (weights in `config.rank`):

```
score = kindWeight[kind]            // term 1, frame 3, sentence 1
      + turnWeight[turn.kind]       // decode 3, say 1, errand −2, other −1
      + (heard_as ? 2 : 0)
      + 3 × (ask_count − 1)
      + (tags ∩ config.rank.coreTags ≠ ∅ ? 1 : 0)     // feeding, baby, food, toddler, units, family
      − 0.2 × max(0, len(hanzi_key) − 12)             // long sentences sink; flag `long` if > 20
```

**Inbox view**: the top `config.inbox.shortlist` (10) pending candidates by score (then newest),
with a "show all" link. **Keep** creates the phrase and its cards (§4.8). **Skip** is final for
that candidate; if the same item is extracted again later, it comes back as a new candidate
with a higher `ask_count`.

### 4.7 Expiry

The daily cron marks `pending` candidates past `expires_at` as `expired`. Nothing else depends on
Will acting.

### 4.8 Card creation

When a phrase is created from a kept candidate, by hand, or from a seed:

- `term` from a `decode` turn → `listen`.
- Any other term, frame or sentence → `say`.
- The phrase editor has a toggle for the second card type.

## 5. Import pipeline

### 5.1 Capture

1. **PWA**: Import page → pick a PDF (Files) → `upload-url` → PUT to R2 → `POST /api/imports`.
   Or paste text into the two fields ("what you asked", optional; "Gemini's answer").
2. **iOS Shortcut** (M6): Share sheet → "Bamboo import" → `upload-url` with `CAPTURE_API_TOKEN`
   → PUT file → `POST /api/imports`. iOS PWAs cannot be share targets, hence the Shortcut.

### 5.2 `segment_import` (worker, deterministic, `worker/src/segment.ts`)

1. Download via the presigned GET; run `pdftotext -layout -enc UTF-8 file -`.
2. `normalizeText` each line (§4.1).
3. Drop boilerplate lines that match `config.segment.boilerplate` regexes: "Sign in",
   "Gemini may display inaccurate info…", "Google Privacy Policy…", "Your privacy & Gemini
   Apps", "Answering … standard", "Created with … Published …", the share URL line, "Source: …",
   and the **"Explore related …" block** (header plus suggestion chips up to the next blank-line
   gap).
4. Collapse consecutive duplicate lines (page breaks repeat lines).
5. **Speaker detection**: Will's messages are right-aligned bubbles. A *user block* is a run of
   lines with indent ≥ `config.segment.userIndentMin` (20) that contain Latin letters. It starts
   after a blank line, and the next non-blank line after it has indent < `replyIndentMax` (8).
   Everything up to the next user block is the reply. Indented table cells inside replies don't
   start with a blank-line gap followed by a low-indent line, which keeps most false positives out.
   Images in the conversation are lost in the PDF; their turns still have text.
6. Post `{turns: [{user_text, reply_text, position}]}`. The page title (the first line) is
   ignored.

Segmentation will be imperfect. Errors cost little, because the LLM sees each turn whole and
the verbatim check guards the output. The weekly stats (§7) show the turn count per import and
the extraction drop rate, which is how a bad parse gets noticed.

The engine, on completion: upserts turns by `turn_key`; for each **new** turn, creates an
`extract_turn` job; sets `import.turns_total/turns_new` and status `extracting` (or `done` if
nothing is new).

### 5.3 `extract_turn` (worker → Ollama)

Input: `{turn_id, user_text, reply_text}`. Prompt: `worker/prompts/extract_turn.v{N}.md` (the
highest N wins). Output contract `ExtractTurnResult`:

```ts
{
  turn_kind: 'decode' | 'say' | 'errand' | 'other',
  items: Array<{                       // ≤ 8
    lang: 'cmn' | 'yue',
    kind: 'term' | 'frame' | 'sentence',
    hanzi: string,                     // copied exactly from the turn
    english: string,                   // ≤ 120 chars
    addressee: string | null,
    heard_as: string | null,           // only for decode: Will's guess, copied from his message
    tags: string[]                     // from the fixed tag list in the prompt
  }>
}
```

Prompt guidance (v1):

- **decode**: Will is guessing a word he heard. Extract the decoded word(s) with `heard_as`.
- **say**: extract the **shortest natural** sentence Gemini offered (prefer a "short/direct"
  variant if present), the 1–4 key terms, and any **reusable frame**. Write frames with `…` for
  the slot, e.g. `阿姨，您是说…吗？`.
- **errand**: extract at most the Chinese nouns (an ingredient, a product), if any are present.
- Copy hanzi **exactly** from the text. Never write Chinese that isn't in the turn. Use `yue`
  only for clearly Cantonese items (e.g. 肥仔水).
- Keep the `english` field short.

The worker calls Ollama with `format` set to the JSON schema of the result. It validates with Zod.
On invalid output it sends one repair turn (the bad reply plus the validation error); a second
failure fails the attempt. After 3 attempts the job is `failed`. The Import page shows failed
turns with a **Retry** button, which requeues with `attempt` reset. The job records `model` and
`prompt_version` (`extract_turn.v1`).

The engine, on completion: sets `turn.kind`/`extracted_at` and runs §4.6. When the import's last
job finishes, it sets the import to `done` and logs `import_finished`.

## 6. Web UI (PWA)

Mobile-first; tested at a 390×844 viewport.

- **Today** (`/`): due count, new count available, language filter, **Start**; an inbox badge.
- **Review** (`/review`): one card at a time.
  - *Say*: the front shows the English intent and an addressee chip ("→ 阿姨"). Tap to reveal the
    hanzi with ruby romanization; audio plays automatically.
  - *Listen*: the front autoplays audio and shows a 🔊 button and an optional "you heard:
    *podafen*" hint. Tap to reveal the meaning and hanzi.
  - The back has 4 grade buttons (with their next interval shown), slow-replay, **Used it ✓**, and
    an edit link.
- **Inbox** (`/inbox`): the ranked shortlist. Each row shows hanzi + romanization, English, kind,
  "heard: …", "asked ×N", and a turn excerpt on expand. Buttons: Keep / Skip / Edit-then-keep.
- **Phrases** (`/phrases`): search and filter by language, kind or tag; add or edit; Used it ✓;
  suspend.
- **Import** (`/import`): PDF picker, paste form, list of recent imports with status, counts and
  failed turns.
- **Stats** (`/stats`, M7): PRD §6 measures.

**Audio** (`web/lib/audio.ts`): the Web Speech API. Voice choice: `lang` `zh-CN` (prefer an
"Enhanced"/"Premium" voice, e.g. Tingting) for `cmn`, `zh-HK` (e.g. Sinji) for `yue`. Rate 0.9,
and 0.6 for slow replay. Speak the hanzi, with `…` replaced by a short pause. iOS needs a user
gesture before the first utterance; the Start tap counts. If no matching voice is found, show a
one-time hint: *Settings → Accessibility → Spoken Content → Voices → Chinese*.

**PWA**: `manifest.webmanifest` (standalone, icons, theme color) and a minimal service worker.
The service worker is needed for push in M7; offline review is not in scope.

**Push (M7)**: the `web-push` library with VAPID keys. The daily cron at `config.push.utcHour`
sends one notification per subscription if anything is due or new: "5 cards · ~3 min". Vercel
Hobby cron runs at most daily, at an imprecise time within the hour. That is acceptable.

## 7. Telemetry and stats

`event` types: `import_finished {import_id, turns_total, turns_new}`,
`extraction {turn_id, model, prompt_version, latency_ms, turn_kind, items, dropped_not_verbatim,
repaired}`, `candidate_decided {action, score, rank}`, `candidate_expired`,
`asked_again {phrase_id}`, `review {card_type, lang, rating, source}`,
`session_finished {cards, ms}`, `worker_heartbeat {...}`, `normalize_unmapped_radical {char}`.

The Stats page (M7) shows, for the last 4 weeks:

- days with a session per week;
- true retention on review-state cards;
- Used-it taps per week;
- asked-again count;
- inbox keep rate;
- extraction drop rate;
- the last worker heartbeat.

A Claude session asked to "review extraction quality" reads these numbers plus samples of
dropped and skipped candidates, and proposes prompt or weight changes, the same way PandaBase's
diagnostics playbook works.

## 8. Environments and operations

### 8.1 Environment variables

| Var | Where | Notes |
|---|---|---|
| `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | web | |
| `ALLOWED_EMAILS` | web | comma-separated |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | web, db scripts | local dev: `file:db/dev.db` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | web | presigning via `aws4fetch` |
| `WORKER_API_TOKEN`, `CAPTURE_API_TOKEN`, `CRON_SECRET` | web (+ worker / Shortcut) | `openssl rand -hex 32` |
| `HOUSEHOLD_TZ` | web | default `America/Los_Angeles` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web | M7 |
| `DEV_AUTH_BYPASS` | web (dev/e2e) | refused in production |
| `BAMBOO_API_URL`, `OLLAMA_URL` (`http://localhost:11434`), `OLLAMA_TEXT_MODEL` (`qwen3.5:9b`), `POLL_INTERVAL_SECONDS` (15), `PDFTOTEXT_BIN` (`pdftotext`) | worker | `~/.config/bamboo/worker.env` |

### 8.2 Deploy

- **Vercel** Git integration: `main` → production; PRs → previews.
- **Turso**: two databases, `bamboo` (prod) and `bamboo-preview`. Vercel env vars are scoped
  per environment.
- **Migrations**: the Vercel build command is `pnpm db:migrate && pnpm --filter web build`, run
  against whichever DB that environment points at. Migrations must be **expand → contract**:
  add freely; drop or rename only in a later PR once no deployed code uses the column.
- **R2**: bucket `bamboo` (private), lifecycle rule deleting `imports/` after 30 days.

### 8.3 Mac mini (worker)

- Runs natively (no Docker; it's plain Node and needs only `pdftotext`). Prereqs:
  `brew install poppler`, Node 24, pnpm, and Ollama with `qwen3.5:9b` pulled (already there for
  PandaBase).
- Checkout at `~/src/bamboo`. A LaunchAgent `ops/launchd/com.bamboo.worker.plist` runs
  `pnpm --filter @bamboo/worker start` with `KeepAlive`, logs to `~/Library/Logs/bamboo/`.
- `make worker-install` installs the plist; `make worker-update` runs `git pull --ff-only`,
  `pnpm install --frozen-lockfile`, then `launchctl kickstart -k`; `make worker-logs`.
- Heartbeat at startup and every 10 min. Today shows "worker offline" if the last heartbeat is
  > 1 h old and imports are waiting.
- The worker claims a job type only if its prerequisites are present: the model is pulled
  (`GET /api/tags`) and `pdftotext` runs.

### 8.4 Private data on the Mac

`private/` at the repo root is gitignored. The real Gemini PDF and any generated personal seed
deck live there. They are never committed, never used as test fixtures, and never quoted in docs
or PRs. Test fixtures are synthetic (Appendix A).

## 9. Repository layout

```
bamboo/
  CLAUDE.md  README.md  Makefile  package.json  pnpm-workspace.yaml  tsconfig.base.json
  docs/       PRD.md DESIGN.md PLAN.md ROADMAP.md
  web/        Next.js app — app/, components/, lib/domain/ (pure), lib/repo/ (DB), lib/config.ts
  db/         @bamboo/db — src/schema/*, migrations/, scripts (seed, import-phrases)
  shared/     @bamboo/shared — src/contracts/* (Zod), src/text.ts
  worker/     @bamboo/worker — src/ (claim loop, segment, ollama), prompts/, tests/fixtures/
  seeds/      yue-holiday.json (committed)
  private/    gitignored — real exports, personal seed decks
  ops/launchd/
  .github/workflows/ci.yml
```

## 10. Key decisions and rationale

| # | Decision | Why |
|---|---|---|
| 1 | Keep Gemini as the in-the-moment tutor; Bamboo owns memory | Gemini is good and already a habit; replacing it is the hardest habit change and the weakest part of a local-model stack |
| 2 | Capture = import the whole conversation (PDF/text), dedupe by turn | Removes per-message effort (no screenshots, no special prompts); the backlog is valuable seed data |
| 3 | Local LLM extracts; it never writes Chinese for study | 9B models copy and classify Chinese well, but their natural Mandarin and especially Cantonese is weaker; verbatim check enforces it |
| 4 | Romanization computed (pinyin-pro / to-jyutping) with overrides | Gemini's pinyin is inconsistent even within a single reply |
| 5 | Ranked shortlist + 3 new/day + 14-day expiry | ~300 candidates per 10 days vs ~3/day capacity; choosing is the product |
| 6 | "Asked again" = merge + Again rating | Re-asking is the clearest forgetting signal available |
| 7 | "Used it ✓" = Good review | Real use is the goal and the best retrieval practice |
| 8 | Say (production) cards by default; Listen for decoded words | Practice matches use: speaking to family, understanding the yuesao |
| 9 | FSRS at 0.85 retention | Smaller review load for a 5-minute budget |
| 10 | Device TTS (Web Speech) first | Free, offline, decent zh-CN/zh-HK voices on iOS; neural TTS deferred |
| 11 | Same stack and conventions as PandaBase, minus codegen and Docker | Familiar; all-TypeScript makes OpenAPI → Pydantic unnecessary; Node worker needs no container |
| 12 | Separate repo, DB and worker from PandaBase; shared Ollama | Independent deploys and failure; one model resident on a 32GB machine |
| 13 | R2 presigned upload | Long PDFs exceed Vercel's request body limit; presigned PUT works from an iOS Shortcut |
| 14 | Turn identity = hash of Will's prompt text | Stable across re-exports, unlike reply layout |
| 15 | Single user, no `member` table | One learner; add a user column when a second learner is real (ROADMAP) |

## Appendix A — Synthetic PDF-text fixture

`worker/tests/fixtures/gemini-export.txt` (and a small generated `gemini-export.pdf` if
practical) must be **invented content** that reproduces every quirk of the real export:

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
  contains a Cantonese term.

Expected segmentation output lives next to it as JSON and is asserted in tests.

## Appendix B — Optional Gemini instruction

Not required for capture. Saving this once in Gemini (Settings → Saved info, or at the top of the
conversation) makes extraction better:

> When I ask how to say something in Chinese, put the shortest natural spoken version first, as
> I'd say it to that person. If I'm guessing at a word someone said, name the word in characters
> first. Keep key-term lists to the 3 most useful words.
