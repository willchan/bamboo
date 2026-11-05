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
  │   ├─ bamboo skill  (/agent/skills/bamboo/SKILL.md)                │                  │
  │   │    PDF/text in #bamboo ─▶ bamboo-tools import                 │                  │
  │   ├─ command automations: bamboo-tools replies (5 min),           │                  │
  │   │                       bamboo-tools nudge (daily)              │                  │
  │   └─ Discord ◀──────────────────────▶ Will (iPhone Discord)       │                  │
  │  bamboo-tools (Node CLI): pdftotext → normalize → segment → POST new turns           │
  │  bamboo-worker (Node, launchd): claims extract_turn jobs ─▶ Ollama (shared with      │
  │                                                              PandaBase, Metal)       │
  └──────────────────────────────────────────────────────────────────────────────────────┘
```

**Ownership rule (same as PandaBase):** the State Engine (`/web` + `/db`) owns all data and
business logic: dedupe, ranking, validation of LLM output, scheduling. The tools CLI and the
worker are stateless clients of the HTTP API. They parse files and call models; they never touch
the DB.

### 1.1 Components

| Component | Runs on | Responsibility |
|---|---|---|
| `/web` | Vercel | PWA UI, API, domain logic, daily cron |
| `/db` | package | Drizzle schema, migrations, seed/phrase-import scripts (`@bamboo/db`) |
| `/shared` | package | Zod contracts, text normalization, PDF-text segmentation, turn keys (`@bamboo/shared`) |
| `/agent/skills/bamboo` | Mac, OpenClaw | Discord behavior: intake of PDFs and text in `#bamboo`; replies and the nudge come from command automations |
| `/agent/tools` | Mac, invoked by OpenClaw | `bamboo-tools`, a deterministic Node CLI: import, replies, nudge |
| `/worker` | Mac, native Node via launchd | Claims `extract_turn` jobs, calls Ollama, posts results |
| Ollama | Mac, native | Local LLM. **Shared with PandaBase**; see §1.2 |

### 1.2 Mac mini resource budget

PandaBase already runs on this Mac (its DESIGN §1.2). Its host settings
`OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1` apply to Bamboo too. Therefore:

- Worker concurrency = **1**.
- Default model **`qwen3.5:9b`**, the same model PandaBase uses for vision, so the two workers
  rarely force a model swap. It is configurable via `OLLAMA_TEXT_MODEL`. Qwen is strong at
  Chinese, and the task is copy-and-classify, not writing Chinese.
- Requests: `think: false`, `temperature: 0`, `num_ctx: 8192`, `keep_alive: "2m"`, `format` set
  to the JSON schema of the result contract.
- The first (backlog) import of ~70 turns takes roughly 20–40 min of model time; later imports
  take minutes.

## 2. Data model

Turso/libSQL via Drizzle. IDs are ULIDs (text). Times are integer ms since epoch
(`timestamp_ms`). JSON columns use `text({ mode: 'json' })` with a Zod type.

### 2.1 Phrases and cards

**`phrase`**: one thing worth remembering.

| column | type | notes |
|---|---|---|
| `id` | text pk | |
| `kind` | `'term' \| 'frame' \| 'sentence'` | frames contain `…` as the slot |
| `hanzi` | text | normalized (§4.1) |
| `hanzi_key` | text **unique** | dedupe key (§4.1) |
| `english` | text | meaning (term) or intent (frame/sentence) |
| `addressee` | text null | `yuesao`, `toddler`, `nanny`, `anyone` (free text allowed) |
| `heard_as` | text null | what Will typed when decoding ("podafen") |
| `note` | text null | short usage note |
| `tags` | json `string[]` | domains: `feeding`, `baby`, `food`, `groceries`, `household`, `toddler`, `units`, … |
| `pinyin` | json `[char, syllable \| null][]` | computed (§4.2), never from the LLM |
| `pinyin_override` | json null | same shape; Will's per-syllable edits |
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

**`import`**:

| column | notes |
|---|---|
| `id` | |
| `kind` | `'pdf' \| 'text'` |
| `origin` | `'discord' \| 'web'` |
| `file_name` | null for text |
| `discord_channel_id`, `discord_message_id` | null for web; the reply target |
| `turns_total`, `turns_new` | counted by the CLI, verified by the engine |
| `status` | `'extracting' \| 'done'` (`done` once every job is `done` or `failed`) |
| `jobs_failed` | int |
| `notified_at` | null until the Discord reply is posted |
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

**`candidate`**: an extracted item awaiting a decision.

| column | notes |
|---|---|
| `id`, `turn_id` | |
| `kind`, `hanzi`, `hanzi_key`, `english`, `addressee`, `heard_as`, `tags` | as `phrase` |
| `ask_count` | int default 1; merged duplicates add to it |
| `score` | real; §4.6 |
| `flags` | json `string[]`, e.g. `long`, `heard_as_dropped` |
| `status` | `'pending' \| 'kept' \| 'skipped' \| 'expired' \| 'merged'` |
| `phrase_id` | set when kept, or when merged into an existing phrase |
| `expires_at`, `created_at`, `decided_at` | |

### 2.3 Platform

- **`job`**: the PandaBase job queue, simplified to one type. Columns: `id`, `type`
  (`'extract_turn'`), `status` (`'queued' | 'leased' | 'done' | 'failed'`), `input` json,
  `result` json null, `attempt` int, `lease_expires_at` null, `model` null, `prompt_version` null,
  `error` null, `created_at`, `finished_at` null.
- **`event`**: telemetry. Columns: `id`, `type`, `data` json, `at`. See §7.
- **`setting`**: key/value: `nudge_enabled` and similar preferences.

## 3. API and auth

### 3.1 Auth

- **UI**: Auth.js v5 with Google. Sign-in is allowed only for emails in `ALLOWED_EMAILS`.
  Sessions are JWT with a 90-day max age, so the home-screen PWA rarely signs out.
  `DEV_AUTH_BYPASS=1` (local and e2e only, refused when `VERCEL_ENV=production`) signs in a fixed
  dev user.
- **Machines**: bearer tokens, compared in constant time.
  - `AGENT_API_TOKEN`: `/api/imports*` and `/api/agent/*` (`bamboo-tools`).
  - `WORKER_API_TOKEN`: `/api/jobs/*` and `/api/worker/*`.
  - `CRON_SECRET`: `/api/cron/*` (Vercel Cron sends it as a bearer).
- UI mutations use **server actions**; the routes below are for machines.

### 3.2 Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/imports/known` | agent | `{turn_keys: string[]}` (≤ 5,000) → `{unknown: string[]}` so the CLI uploads only new turns |
| `POST /api/imports` | agent | `{kind, origin, file_name?, discord_channel_id?, discord_message_id?, turns_total, turns: [{user_text, reply_text, position}]}` (≤ 2 MB; the CLI chunks with `import_id` on later calls) → `{import_id, turns_new}`. The engine recomputes each `turn_key`, upserts, and queues one `extract_turn` per new turn. Header `Idempotency-Key: discord:<message id>` |
| `GET /api/agent/notifications` | agent | finished imports with a Discord message and no `notified_at`, each with a one-line `summary` |
| `POST /api/imports/{id}/notified` | agent | sets `notified_at` |
| `GET /api/agent/nudge` | agent | `{text}` or `{text: null}` when nothing is due or new (§4.9) |
| `POST /api/jobs/claim` | worker | → a job or `204`. Lease = `jobs.leaseMinutes` (10); `attempt += 1` |
| `POST /api/jobs/complete` | worker | `{job_id, attempt, status:'done', result, model, prompt_version}` or `{…, status:'failed', error}`. A stale `attempt` returns `409`. The result is validated against `ExtractTurnResult` and applied in the same transaction (§4.6) |
| `POST /api/worker/heartbeat` | worker | `{version, sha, model, ollama_ok}` → `event` |
| `GET /api/cron/daily` | cron | expire candidates (§4.7), requeue expired leases, prune events > 180 d |

The PWA's paste box uses a server action that calls the same import service as
`POST /api/imports` (`origin: 'web'`, `kind: 'text'`).

Contracts are Zod schemas in `shared/src/contracts/`. Web, worker and tools import the same
schemas (there is no codegen; everything is TypeScript).

## 4. Algorithms

All of these are pure functions in `web/lib/domain/` (or `shared/` where the Mac side also needs
them), with unit tests. Every tunable lives in `web/lib/config.ts` (the Mac-side tunables live in
`shared/src/config.ts`).

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
   left in U+2E80–2FDF is kept and reported in the import's telemetry.
3. Collapse whitespace runs inside lines and trim.

`hanziKey(s)` = `normalizeText(s)` with everything except CJK ideographs, ASCII letters and
digits removed, letters lowercased. `阿姨，您是说…吗？` → `阿姨您是说吗`.

### 4.2 Pinyin (`web/lib/domain/pinyin.ts`)

- `pinyin-pro` with tone marks, output aligned per character: `[char, syllable | null]`, with
  `null` for non-hanzi. Tone sandhi is shown only for 一/不.
- Pinyin is recomputed whenever `hanzi` changes. If an override exists and the new hanzi differs,
  the override is dropped and the UI says so.
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
4. Grading applies the ts-fsrs `next()` result, writes `review_log` (`source: 'session'`) and
   sets `introduced_at` on first sight.

**Used it ✓** (`markUsed(phrase_id)`): pick the phrase's `say` card (or `listen` if it has no
`say` card). If it has not been reviewed today, apply **Good** with `source: 'real_use'`.
Otherwise, only log a `real_use` event. Real use never counts toward `newPerDay`.

**Asked again** (§4.6): apply **Again** with `source: 'asked_again'` to every non-new card of
the phrase, at most once per phrase per import.

### 4.5 Turn identity (`shared/src/turns.ts`)

`turn_key = sha256(hanziKey(user_text))`, keyed on **Will's own words only**. Re-exporting the
conversation re-flows the reply text (page breaks, duplicated lines), but his short prompts come
through stably. Two genuinely identical prompts on different days collapse into one. That is
rare and harmless. Text imports: `turn_key = sha256(hanziKey(user_text ?? '') + '\n' +
hanziKey(reply_text))`.

The CLI computes keys to ask `/api/imports/known`; the engine recomputes them and is the
authority.

### 4.6 Candidate validation and ranking (`web/lib/domain/candidates.ts`)

On `extract_turn` completion, for each raw item:

1. `hanzi = normalizeText(item.hanzi)`. **Drop** the item if `hanziKey(hanzi)` has no CJK
   character, or if it does not occur in `hanziKey(user_text + reply_text)` (the verbatim check
   stops the model inventing Chinese). Count drops in telemetry.
2. Keep `heard_as` only if it occurs (case-insensitive, spaces ignored) in `user_text`;
   otherwise null it and add the `heard_as_dropped` flag.
3. If a `phrase` exists with the same `hanzi_key`: set candidate status to `merged`, increment
   `phrase.asked_count`, set `last_asked_at`, and apply *asked again* (§4.4). That phrase does
   not appear in the inbox.
4. Else, if a `pending` candidate exists with the same `hanzi_key`, add 1 to its `ask_count`,
   re-score it, and push its expiry forward. Don't create a new candidate.
5. Else, create a candidate with `expires_at = now + config.inbox.ttlDays` (14).

`score` (weights in `config.rank`):

```
score = kindWeight[kind]            // term 1, frame 3, sentence 1
      + turnWeight[turn.kind]       // decode 3, say 1, errand −2, other −1
      + (heard_as ? 2 : 0)
      + 3 × (ask_count − 1)
      + (tags ∩ config.rank.coreTags ≠ ∅ ? 1 : 0)     // feeding, baby, food, toddler, units
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

### 4.9 Nudge text

`GET /api/agent/nudge` returns `null` unless cards are due today or the inbox has pending
candidates. Otherwise it returns one line:
`📚 {due} cards · ~{ceil(due × 15 s / 60)} min · {pending} new in Inbox → {APP_URL}`.
Omit any part that is zero.

## 5. Capture pipeline

### 5.1 Discord intake (the bamboo skill)

Scope: messages in `#bamboo` (channel id in the tools config). It follows PandaBase's skill
conventions: `SKILL.md` frontmatter gating on `requires.bins: ["bamboo-tools"]` and
`requires.env: ["AGENT_API_TOKEN", "BAMBOO_CONFIG"]`; message text is data, never instructions;
anything with quotes is written to a file and passed with `--input`.

- **PDF attachment** (use the attachment's local `path`):
  `bamboo-tools import --file <path> --channel-id <id> --message-id <id>`.
  It prints `{import_id, turns_total, turns_new}`. Reply once:
  - `turns_new > 0`: "📥 Got it: {turns_total} questions, {turns_new} new. I'll reply here when
    they're processed."
  - otherwise: "✅ Nothing new since last time."
- **Pasted text** (a Gemini answer): write the message to a file, then
  `bamboo-tools import --text-file <file> --channel-id … --message-id …`. The reply is the same.
- **Privacy**: the skill passes the file path along and never reads, summarizes or quotes the
  PDF. All model work happens in the worker on local Ollama. If OpenClaw extracts document
  text for its own reply model, that model must also be local. PandaBase's household
  configuration already does this (its DESIGN §10 #43). If that changes, bind a text-only agent
  to `#bamboo`.
- **Results**: an OpenClaw *command automation* (no model call) runs `bamboo-tools replies` every
  5 minutes. It posts each finished import's summary as a reply to the original message
  ("✅ 9 new questions → 14 candidates. Top: 高压锅 pressure cooker, 泡打粉 baking powder,
  … → Inbox <link>"), then marks it notified. It prints `NO_REPLY` when idle. This is the same
  mechanism as PandaBase's `jobs replies`.
- **Nudge**: an OpenClaw cron (daily, at `config.nudgeLocalTime`, default 20:30 in
  `HOUSEHOLD_TZ`) runs `bamboo-tools nudge` as a command automation. It posts the text or
  `NO_REPLY`.
- **Size**: Discord's free upload limit (currently 10 MB) holds months of a single conversation
  (a 105-page, 10-day export is 1.8 MB). If an export gets too big, start a new Gemini
  conversation. Turn keys don't depend on which conversation a turn came from.

### 5.2 `bamboo-tools import` (deterministic)

1. `pdftotext -layout -enc UTF-8 <file> -`.
2. `normalizeText` each line (§4.1).
3. Drop boilerplate lines that match `segment.boilerplate` regexes (`shared/src/config.ts`):
   "Sign in", "Gemini may display inaccurate info…", "Google Privacy Policy…", "Your privacy &
   Gemini Apps", "Answering … standard", "Created with … Published …", the share-URL line,
   "Source: …", and the **"Explore related …" block** (header plus suggestion chips up to the
   next blank-line gap).
4. Collapse consecutive duplicate lines (page breaks repeat lines).
5. **Speaker detection** (`shared/src/segment.ts`): Will's messages are right-aligned bubbles. A
   *user block* is a run of lines with indent ≥ `userIndentMin` (20) that contain Latin letters.
   It starts after a blank line, and the next non-blank line after it has indent <
   `replyIndentMax` (8). Everything up to the next user block is the reply. Indented table cells
   inside replies don't start with a blank-line gap followed by a low-indent line, which keeps
   most false positives out. Images are lost in the PDF; their turns still have text.
6. Compute turn keys → `POST /api/imports/known` → `POST /api/imports` with only the unknown
   turns, chunked to ≤ 2 MB.

`bamboo-tools segment --file <pdf>` is a dry run: it prints the turn count and the first and
last 5 user prompts, and makes no API calls. Use it to check a parse on the Mac.

Segmentation will be imperfect. Errors cost little, because the LLM sees each turn whole and
the verbatim check guards the output. The import summary's turn count is the visible sanity
check.

### 5.3 `extract_turn` (worker → Ollama)

Input: `{turn_id, user_text, reply_text}`. Prompt: `worker/prompts/extract_turn.v{N}.md` (the
highest N wins). Output contract `ExtractTurnResult`:

```ts
{
  turn_kind: 'decode' | 'say' | 'errand' | 'other',
  items: Array<{                       // ≤ 8
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
- Copy hanzi **exactly** from the text. Never write Chinese that isn't in the turn. Skip items
  that are Cantonese-only (e.g. 肥仔水).
- Keep the `english` field short.

The worker calls Ollama with `format` set to the JSON schema of the result. It validates with Zod.
On invalid output it sends one repair turn (the bad reply plus the validation error); a second
failure fails the attempt. After 3 attempts the job is `failed` and counted in
`import.jobs_failed`. The Imports page has a **Retry failed** button, which requeues with
`attempt` reset. The job records `model` and `prompt_version` (`extract_turn.v1`).

The engine, on completion: sets `turn.kind`/`extracted_at` and runs §4.6. When the import's last
job finishes, it sets the import to `done` and logs `import_finished`.

## 6. Web UI (PWA)

Mobile-first; tested at a 390×844 viewport.

- **Today** (`/`): due count, new count available, **Start**; an inbox badge.
- **Review** (`/review`): one card at a time.
  - *Say*: the front shows the English intent and an addressee chip ("→ 阿姨"). Tap to reveal the
    hanzi with ruby pinyin; audio plays automatically.
  - *Listen*: the front autoplays audio and shows a 🔊 button and an optional "you heard:
    *podafen*" hint. Tap to reveal the meaning and hanzi.
  - The back has 4 grade buttons (with their next interval shown), slow-replay, **Used it ✓**, and
    an edit link.
- **Inbox** (`/inbox`): the ranked shortlist. Each row shows hanzi + pinyin, English, kind,
  "heard: …", "asked ×N", and a turn excerpt on expand. Buttons: Keep / Skip / Edit-then-keep.
- **Phrases** (`/phrases`): search and filter by kind or tag; add or edit; Used it ✓; suspend.
- **Imports** (`/imports`): recent imports with status, counts and failed jobs (Retry); a paste
  box for a single Gemini answer.
- **Stats** (`/stats`): PRD §6 measures.

**Audio** (`web/lib/audio.ts`): the Web Speech API. Voice choice: `lang` `zh-CN`, preferring an
"Enhanced"/"Premium" voice (e.g. Tingting). Rate 0.9, and 0.6 for slow replay. Speak the hanzi,
with `…` replaced by a short pause. iOS needs a user gesture before the first utterance; the
Start tap counts. If no `zh-CN` voice is found, show a one-time hint:
*Settings → Accessibility → Spoken Content → Voices → Chinese*.

**PWA**: `manifest.webmanifest` (standalone, icons, theme color). There's no service worker in
the MVP: no offline review and no web push (the nudge comes through Discord).

## 7. Telemetry and stats

`event` types: `import_finished {import_id, turns_total, turns_new, jobs_failed}`,
`extraction {turn_id, model, prompt_version, latency_ms, turn_kind, items, dropped_not_verbatim,
repaired}`, `candidate_decided {action, score, rank}`, `candidate_expired`,
`asked_again {phrase_id}`, `review {card_type, rating, source}`, `session_finished {cards, ms}`,
`worker_heartbeat {...}`.

The Stats page shows, for the last 4 weeks:

- days with a session per week;
- true retention on review-state cards;
- Used-it taps per week;
- asked-again count;
- inbox keep rate;
- extraction drop rate;
- the last worker heartbeat.

A Claude Code session asked to "review extraction quality" reads these numbers plus samples of
dropped and skipped candidates (from the prod DB, on the Mac), and proposes prompt or weight
changes. This is the same practice as PandaBase's diagnostics playbook.

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
| `DEV_AUTH_BYPASS` | web (dev/e2e) | refused in production |
| `BAMBOO_API_URL`, `AGENT_API_TOKEN`, `BAMBOO_CONFIG` (path to tools config: channel id) | tools | |
| `BAMBOO_API_URL`, `WORKER_API_TOKEN`, `OLLAMA_URL` (`http://localhost:11434`), `OLLAMA_TEXT_MODEL` (`qwen3.5:9b`), `POLL_INTERVAL_SECONDS` (15) | worker | `~/.config/bamboo/worker.env` |

### 8.2 Deploy

- **Vercel** Git integration: `main` → production; PRs → previews.
- **Turso**: two databases, `bamboo` (prod) and `bamboo-preview`. Vercel env vars are scoped
  per environment.
- **Migrations**: the Vercel build command is `pnpm db:migrate && pnpm --filter web build`, run
  against whichever DB that environment points at. Migrations must be **expand → contract**:
  add freely; drop or rename only in a later PR once no deployed code uses the column.

### 8.3 Mac mini

- Prereqs: `brew install poppler` (for `pdftotext`), Node 24, pnpm, and Ollama with `qwen3.5:9b`
  pulled (already there for PandaBase). Checkout at `~/src/bamboo`.
- **Worker**: a LaunchAgent `ops/launchd/com.bamboo.worker.plist` runs
  `pnpm --filter @bamboo/worker start` with `KeepAlive`, logs to `~/Library/Logs/bamboo/`.
  It sends a heartbeat at startup and every 10 min, and claims jobs only if the model is pulled
  (`GET /api/tags`). Today shows "worker offline" if the last heartbeat is > 1 h old and jobs are
  waiting.
- **Agent**: `make agent-install` links `bamboo-tools` onto PATH, writes the tools config from
  `agent/bamboo.config.example.json`, and adds `agent/skills` to OpenClaw's
  `skills.load.extraDirs`, backing up `openclaw.json` first, as PandaBase does. The two command
  automations (replies every 5 min; nudge daily) are added the same way PandaBase's are.
  Create a `#bamboo` Discord channel and allow the agent in it.
- `make worker-update` runs `git pull --ff-only`, `pnpm install --frozen-lockfile`, then
  `launchctl kickstart -k`; `make worker-logs` tails the logs.

### 8.4 Private data

Real Gemini exports reach the Mac only as Discord attachments, which OpenClaw stores. If a
developer copies one for debugging, it goes in `private/` at the repo root, which is gitignored.
Exports are never committed, never used as test fixtures, and never quoted in docs, PRs or
commit messages (counts only). Test fixtures are synthetic (Appendix A).

## 9. Repository layout

```
bamboo/
  CLAUDE.md  README.md  Makefile  package.json  pnpm-workspace.yaml  tsconfig.base.json
  docs/       PRD.md DESIGN.md PLAN.md ROADMAP.md
  web/        Next.js app — app/, components/, lib/domain/ (pure), lib/repo/ (DB), lib/config.ts
  db/         @bamboo/db — src/schema/*, migrations/, scripts (seed, import-phrases)
  shared/     @bamboo/shared — src/contracts/*, text.ts, segment.ts, turns.ts, config.ts;
              tests/fixtures/ (synthetic export)
  worker/     @bamboo/worker — src/ (claim loop, ollama client), prompts/
  agent/      skills/bamboo/SKILL.md; tools/ (@bamboo/tools → bamboo-tools CLI);
              bamboo.config.example.json
  private/    gitignored
  ops/launchd/
  .github/workflows/ci.yml
```

## 10. Key decisions and rationale

| # | Decision | Why |
|---|---|---|
| 1 | Keep Gemini as the in-the-moment tutor; Bamboo owns memory | Gemini is good and already a habit; replacing it is the hardest habit change and the weakest part of a local-model stack |
| 2 | Capture = send the whole conversation PDF (or a pasted answer) to OpenClaw in `#bamboo` | One share from the phone, no screenshots; reuses PandaBase's Discord intake pattern and replies in-thread |
| 3 | Parse PDFs on the Mac in `bamboo-tools`; upload only new turns as text | `pdftotext` is local; no file storage (R2) or presigned uploads needed; payloads stay small |
| 4 | Local LLM extracts; it never writes Chinese for study | 9B models copy and classify Chinese well; verbatim check enforces it |
| 5 | Pinyin computed (pinyin-pro) with overrides | Gemini's pinyin is inconsistent even within a single reply |
| 6 | Ranked shortlist + 3 new/day + 14-day expiry | ~300 candidates per 10 days vs ~3/day capacity; choosing is the product |
| 7 | "Asked again" = merge + Again rating | Re-asking is the clearest forgetting signal available |
| 8 | "Used it ✓" = Good review | Real use is the goal and the best retrieval practice |
| 9 | Say (production) cards by default; Listen for decoded words | Practice matches use: speaking to family, understanding the yuesao |
| 10 | FSRS at 0.85 retention | Smaller review load for a 5-minute budget |
| 11 | Device TTS (Web Speech) | Free, offline, decent zh-CN voices on iOS |
| 12 | Nudge via Discord, not web push | OpenClaw cron already exists; avoids service worker, VAPID and iOS PWA push quirks |
| 13 | Same stack and conventions as PandaBase, minus codegen and Docker | Familiar; all-TypeScript makes OpenAPI → Pydantic unnecessary; Node needs no container |
| 14 | Separate repo, DB, worker and skill from PandaBase; shared Ollama and OpenClaw | Independent deploys and failure; one model resident on a 32GB machine |
| 15 | Turn identity = hash of Will's prompt text | Stable across re-exports and across conversations |
| 16 | Mandarin only; no `lang` column yet | Cantonese is undecided; adding it later is one expand migration (`lang` default `cmn`) plus Jyutping and a zh-HK voice |
| 17 | Single user, no `member` table | One learner; add a user column if a second learner is real |

## Appendix A — Synthetic PDF-text fixture

`shared/tests/fixtures/gemini-export.txt` (the `pdftotext -layout` output; tests start from text,
so CI doesn't need poppler) must be **invented content** that reproduces every quirk of the real
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

Expected segmentation output lives next to it as JSON and is asserted in tests.

## Appendix B — Optional Gemini instruction

Not required for capture. Saving this once in Gemini (Settings → Saved info, or at the top of the
conversation) makes extraction better:

> When I ask how to say something in Chinese, put the shortest natural spoken version first, as
> I'd say it to that person. If I'm guessing at a word someone said, name the word in characters
> first. Keep key-term lists to the 3 most useful words.
