# Bamboo — Build Plan

> Living document. Each milestone is executed by **one fresh Claude Code session** producing
> **one PR**. Sessions read only what their milestone lists. When a milestone deviates from this
> plan or from DESIGN.md, record it in the milestone's **Notes** and update DESIGN.md in the same
> PR.

## Session protocol

1. Read `CLAUDE.md`, this file's *Session protocol*, and **your milestone only**, then the
   DESIGN/PRD sections it lists.
2. Branch from the latest `main`: `claude/m<N>-<slug>`.
3. Build to the acceptance criteria. Run every acceptance command locally; all must pass.
4. Update the status table below (→ `in review`) and your milestone's **Notes**: versions chosen,
   deviations, and anything later milestones need to know.
5. Open a PR titled `M<N>: <title>`. The body lists the acceptance commands and their results,
   plus any manual steps Will must do (accounts, env vars, phone checks).
6. Drive the PR to green and mergeable: on every check, look at mergeability before CI (a PR that
   conflicts with `main` gets no CI).
7. Don't edit files owned by another milestone except where your milestone says so. If you must,
   call it out in the PR.
8. Never commit, quote or paste Will's real conversations (CLAUDE.md *Privacy*). Report counts only.

## Orchestrator protocol

Will can run the plan through one long-lived **orchestrator** session on the Mac, which dispatches
a fresh **milestone session** for each milestone (for example, a subagent in its own git
worktree). The orchestrator:

1. **Plans the next step.** It reads `CLAUDE.md`, this file in full, and the Notes of merged
   milestones. A milestone is *ready* when everything it depends on is merged. It tells Will what it
   intends to dispatch next, and why.
2. **Gathers Will's inputs first.** Milestone sessions can't ask Will anything, so the orchestrator
   collects what they need before dispatching. M0 needs a share link. M1 needs the accounts listed
   in its manual steps, which can also be done after the PR.
3. **Dispatches** each ready milestone with this prompt:
   *"You are the milestone session for M<N> of Bamboo. Follow docs/PLAN.md › Session protocol
   for M<N> exactly. Inputs from Will: <…>. When done, report: the PR URL, the acceptance results,
   the deviations you recorded in Notes, and every manual step Will must take."* Independent ready
   milestones (M0 ∥ M1; M4 ∥ M5) may run in parallel, each in its own worktree.
4. **Reviews** each result:
   - reads the PR diff and Notes;
   - checks it against the milestone's acceptance and CLAUDE.md rules (privacy above all);
   - sends the milestone session back to fix anything missing.
5. **Propagates changes.** If a milestone deviated, or found something that changes later
   milestones (for example, M0 finds share links unreadable), the orchestrator updates the
   downstream milestones' sections, DESIGN.md and PRD.md in a small `claude/plan-update-<topic>`
   PR. It lists those changes to Will in plain words. It never quietly drops scope; dropping or
   adding a feature is Will's call.
6. **Hands over to Will** for anything outside the repo: account setup, env vars, phone checks,
   and **merging**. The orchestrator asks before merging any PR, unless Will has said that green PRs
   in this plan may be merged without asking.
7. **Keeps the status table current,** then loops back to step 1 until M6 is merged. At the end it
   summarizes what was built, what changed from the plan, and the open ROADMAP candidates.

If the orchestrator's context gets long, it can be restarted: everything it needs is in this file
(the status table and Notes) and the PRs.

## Dependency graph

```
M0 (share-link spike, on the Mac) ───────────────────────────┐
M1 ─▶ M2 ─▶ M3 ─┬─▶ M4 (worker)          ─┬─▶ M6 (reminder & stats)
                └─▶ M5 (Discord intake) ◀─┘ (M5 uses M0's findings)
```

M0 and M1 can run in parallel. M4 and M5 can run in parallel once M3 is merged; both are
clients of M3's API. **M2 is usable** with hand-added phrases; **M5 is when Bamboo becomes
genuinely useful** (share a conversation, get a deck).

## Status

| Milestone | Status | PR |
|---|---|---|
| M0 Share-link spike | merged | [#3](https://github.com/willchan/bamboo/pull/3) |
| M1 Skeleton, auth, deploy | merged | [#2](https://github.com/willchan/bamboo/pull/2) |
| M2 Phrases, rounds & review | merged | [#5](https://github.com/willchan/bamboo/pull/5) |
| M3 Capture: engine | merged | [#6](https://github.com/willchan/bamboo/pull/6) |
| M4 Worker | in review | [#9](https://github.com/willchan/bamboo/pull/9) |
| M5 Discord intake | merged | [#8](https://github.com/willchan/bamboo/pull/8) |
| M6 Reminder & stats | todo | |

---

## M0 — Share-link spike *(on the Mac)*

**Goal:** decide whether a Gemini share link can be read reliably from the Mac, and how.

**Read:** PRD §5.3; DESIGN §4.1, §4.5, §5.2, §8.4, Appendix A.

**Owns:** `spikes/share-link/` (a standalone throwaway script with its own `package.json`; not part
of the workspace); the *Share link* part of DESIGN §5.2; `agent/tools/tests/fixtures/share-page.html`
and its expected-turns JSON (synthetic content; Appendix A).

**Do:**
1. Ask Will for a share link (he sends it in the session; don't commit it).
2. Try in order: a plain `fetch` (is the conversation in the HTML or an embedded JSON blob?), then
   headless Chromium via Playwright (wait for render, read the DOM).
3. For whatever works, find a robust way to get: the title; the ordered user and model turns; the
   text with line breaks; and whether the page reflects later messages or is a frozen snapshot
   (ask Will to add a message and re-share).
4. Write the findings into DESIGN §5.2: method, selectors or data path, wait strategy, known
   fragility, timing. Make the synthetic fixture from the real structure, with all text replaced.

**Acceptance:** `node spikes/share-link/read.mjs <link>` on the Mac prints the title, turn count,
and the first 3 user prompts truncated to 40 chars. The PR contains only counts and synthetic
content. DESIGN §5.2 states one of: **link works** (method), or **link not supported** (why). If
the link doesn't work, drop link import from PRD §5.3 and from M5. PDF import is built in M5
either way: it is a required path, not a contingency.

**Out of scope:** integrating into `bamboo-tools` (M5).

**Notes:**
- **Verdict: link works.** The method is in DESIGN §5.2 (and §10 #20): two plain HTTPS requests
  (resolve the link, then Gemini's `ujx1Bf` batchexecute RPC), no browser. On Will's real link
  (counts only): 86 turns, 1 of them an image-only prompt with no text; ~1.2 s by RPC and ~5 s by
  headless Chromium. Both methods agreed on the title, the turn count and every prompt (86/86
  exact), and on the reply hanzi of 84/86 turns. The other 2 are checklist widgets, which the DOM
  renders as an empty iframe; the RPC has their text.
- **Plain fetch of the page doesn't work**: the HTML is an Angular shell with no conversation.
  The RPC call itself is a plain `POST`, though, so "plain fetch" works in two steps.
- **The link host**: `share.gemini.google/<code>` 301 → `gemini.google.com/share/<id>` 200 (one
  hop). `g.co/gemini/share/…` 302s to the same host.
- **Snapshot or live: frozen snapshot; a re-share is a new link** (tested after M1 merged, with
  Will's second link). Counts only:
  - After Will added turns and re-shared, link A still returned 86 turns, with prompts,
    timestamps and replies identical to the first run.
  - Link B has a **different** share id and returns **88** turns: A's 86 unchanged (prompts,
    timestamps and replies; same title), then 2 new turns, neither of them image-only.
  - **What this means for M5:** every re-share is a new public link carrying the whole
    conversation so far, and old links never change. Turn-key dedupe (DESIGN §4.5) is therefore
    what makes a re-share cost only the new turns: importing B after A gives "88 questions, 2
    new". Re-reading an old link is always "Nothing new since last time". No idempotency on the
    link URL is needed beyond the turn keys. Because links pile up, the "this link is public,
    delete it in Gemini → Settings → Public links" line in the reply (DESIGN §5.1) matters; keep
    it. The redirect shape for link B was the same as A's.
- **For M5** (`agent/tools/src/share.ts`): port `readViaRpc`, `parseBatchexecute` and
  `flattenRich` from `spikes/share-link/read.mjs`. Don't ship Playwright: if the RPC breaks,
  reply "send the PDF" (`share_parse_failed`), and use the spike's `--dom` reader to repair it.
  Use `node:https` with a big `maxHeaderSize`: Node's `fetch` fails on Google's response headers
  (`UND_ERR_HEADERS_OVERFLOW`). Test against `agent/tools/tests/fixtures/share-rpc.txt` and
  `share-page.expected.json`.
- **For M3/M5: image-only prompts.** Their prompt text is empty, so with DESIGN §4.5 every such
  turn gets the same `turn_key` and all but the first would be dropped as "known". Suggested fix
  (not made here, as §4.5 isn't M0's): when `hanziKey(user_text)` is empty, key the turn like a
  text import, on the reply. The PDF path presumably has the same case; check it in M5.
  *Resolved in the `claude/plan-update-m0-findings` PR:* DESIGN §4.5 now keys empty prompts
  on the reply, and M3 and M5 test it.
- **Will's prompts here had no hanzi at all**, so `hanziKey` keys his turns on their English
  letters and digits. That's fine for dedupe, and it's why the RPC's verbatim prompt text
  matters more than the reply formatting.
- **Deviations:**
  - An extra fixture, `agent/tools/tests/fixtures/share-rpc.txt` (the RPC response), next to the
    planned `share-page.html`. Both share one expected-turns file, `share-page.expected.json`.
    `spikes/share-link/make-fixtures.mjs` generates the RPC fixture from invented text, and
    `check-fixtures.mjs` checks that both readers produce the expected turns.
  - Snapshot-vs-live was first left unconfirmed (no second link yet) and tested in a follow-up
    push to the same PR.
  - DESIGN §10 gained row #20 and Appendix A a *Share RPC* entry (both outside M0's *Owns*,
    called out in the PR).
  - `agent/tools/tests/fixtures/` is created here, before M1 creates the `agent/tools` package.
    Only the fixture files are added; there's no `package.json`.
  - `.prettierignore` lists `agent/tools/tests/fixtures/share-*`: the fixture HTML mirrors real
    markup and the expected JSON is an exact parse, so neither is reformatted.
  - The spike uses npm (`package-lock.json`), not pnpm, so it can never be pulled into the pnpm
    workspace. Chromium is installed inside the spike's `node_modules`
    (`PLAYWRIGHT_BROWSERS_PATH=0`), only for `--dom`, `--compare` and `check-fixtures.mjs`.
- **Versions:** Node 24.22, Playwright 1.65.0 (Chrome Headless Shell 158). Gemini web build
  `boq_gemini-web-uiserver_20261103.01_p0` at the time of the test.
- Debug copies of the real page and RPC response stayed in the gitignored `private/`.

---

## M1 — Skeleton, auth, deploy

**Goal:** a deployed, signed-in, empty app with green CI that every later milestone builds on.

**Read:** DESIGN §1, §3.1, §8, §9, §10. PandaBase's PLAN M1 *Notes* are a good reference for
version pinning and tooling choices (`github.com/willchan/pandabase`, `docs/PLAN.md`).

**Owns:**
- root files: `package.json` (pnpm workspace, `packageManager` pinned, Node 24 `engines`),
  `pnpm-workspace.yaml`, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`), ESLint and
  Prettier config, `.gitignore` (keep `private/`), `.nvmrc`, `Makefile` (stubs), `.env.example`
  (every variable in DESIGN §8.1), and a `README.md` update;
- `/web`: Next.js latest stable, App Router, Tailwind, Auth.js v5 Google with `ALLOWED_EMAILS` and
  `DEV_AUTH_BYPASS`, a signed-in placeholder Today page, PWA manifest and icons, dark mode;
- `/db`: Drizzle + libSQL, a `setting` table only, migrate scripts;
- `/shared`, `/worker` and `/agent/tools`: empty packages, one test each;
- `.github/workflows/ci.yml`.

**CI:** `pnpm install --frozen-lockfile` → lint → typecheck → test → `pnpm --filter web build`.

**Acceptance:**
```
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build
pnpm db:migrate        # against file:db/dev.db
DEV_AUTH_BYPASS=1 pnpm dev   # placeholder Today page renders signed in
```
Manual, listed in the PR for Will:
- create the Google OAuth client, the Turso DBs (`bamboo`, `bamboo-preview`) and the Vercel
  project;
- set the env vars;
- check that the production URL signs Will in and refuses any other account;
- check that "Add to Home Screen" on the iPhone opens it standalone.

**Out of scope:** domain tables, worker or tools logic.

**Notes:**

*Versions chosen (checked 2026-11-05):* Node **24** (`.nvmrc` = `24`, `engines.node` =
`>=24 <25`; built on 24.22.2), pnpm **12.16.1** (`packageManager`), Next.js **16.4.5** (App
Router, Turbopack), React **19.3.1**, Auth.js **next-auth 5.0.0-beta.32** (v5 is still only on the
`beta` tag), Tailwind **4.3.4** (`@tailwindcss/postcss`), Drizzle ORM **0.45.4** + drizzle-kit
**0.31.11** (`dialect: "turso"`), `@libsql/client` **0.18.0**, TypeScript **6.0.3**, ESLint
**9.39.5**, typescript-eslint **8.72.1**, eslint-config-next **16.4.5**, Prettier **3.9.10**,
Vitest **5.1.0**, tsx **4.23.15**. Runtime and build deps are pinned exactly; `@types/*` use
ranges.

*Deviations / choices:*
- **TypeScript 6, not 7.** typescript-eslint 8.72's peer range is still `<6.1.0`. Same call as
  PandaBase; revisit when it supports 7.
- **ESLint 9, not 10.** pnpm flags 9.39.5 as deprecated, but eslint-config-next 16.4.5 still pulls
  `eslint-plugin-react` 7.37, whose peer range stops at ESLint 9.
- **`DEV_AUTH_BYPASS` is stricter than DESIGN said:** refused on every Vercel deployment
  (`VERCEL` or `VERCEL_ENV` set), not only production. It needs no click: `getCurrentUser()`
  returns the fixed dev user (`dev@example.com`) and the proxy lets every request through. Under
  the bypass, a missing `AUTH_SECRET` falls back to a dev-only constant, so `DEV_AUTH_BYPASS=1
  pnpm dev` works with no `.env.local`. DESIGN §3.1, §8.1 and §10 #19 updated.
- **Previews can't complete Google sign-in** (Google has no wildcard redirect URIs and the host
  changes per build). Preview `ALLOWED_EMAILS` is left unset. DESIGN §3.1 and §10 #19.
- **Vercel Root Directory is `web`**, so the build command lives in `web/vercel.json` as
  `pnpm --dir .. db:migrate && pnpm build` (same effect as DESIGN's root-level command). On
  Vercel, `db:migrate` refuses a missing/local `TURSO_DATABASE_URL` or a missing
  `TURSO_AUTH_TOKEN`, so a misconfigured environment fails its build instead of deploying against
  an unmigrated DB. DESIGN §8.2 updated.
- **Icons are generated, not committed PNGs:** `web/components/bamboo-mark.tsx` is one SVG used in
  the UI and rendered by `app/icon.tsx` (`/icon/192`, `/icon/512`, prerendered at build) and
  `app/apple-icon.tsx` (180×180). The mark stays inside the maskable safe zone. The manifest is
  `app/manifest.ts` (`/manifest.webmanifest`, `display: standalone`), plus `appleWebApp` metadata.
- No shadcn/ui yet: the two M1 pages use plain Tailwind with CSS-variable tokens in
  `app/globals.css` (light + dark via `prefers-color-scheme`). Add components when M2 needs them.
- System fonts (with PingFang SC / Noto Sans SC for hanzi); no `next/font/google`, so
  `next build` needs no network.
- `setting` is `key text PK, value text NOT NULL` (migration `0000_setting`). M6 decides the value
  encoding.
- CI adds two cheap steps beyond the plan: the migrations match the schema
  (`drizzle-kit check` + `db:generate` leaves no diff) and they apply to a fresh `db/dev.db`.
- `spikes/` (M0's) is excluded from ESLint and Prettier: it is not part of the workspace.

*For M2+:*
- Packages ship TypeScript source with no build step (`exports: ./src/index.ts`); `/web`
  transpiles `@bamboo/db` and `@bamboo/shared` (`next.config.ts`). The worker and tools run with
  `tsx`.
- ESLint: the root `eslint.config.mjs` (JS + typescript-eslint + prettier) covers `/db`,
  `/shared`, `/worker`, `/agent/tools`; `/web` has its own (next core-web-vitals + typescript +
  prettier). `pnpm lint` = ESLint in every package + `prettier --check .`; Prettier ignores `*.md`
  and `db/migrations/`. `verbatimModuleSyntax` is on: use `import type`.
- `web` `typecheck` runs `next typegen && tsc --noEmit` (typed `PageProps`/`LayoutProps`);
  `next-env.d.ts` is gitignored.
- Next's types make `NodeJS.ProcessEnv.NODE_ENV` required, so functions that take an env for tests
  use `Env` from `web/lib/auth/allowlist.ts`.
- Auth: pages call `requireUser()` / `getCurrentUser()` from `web/lib/auth/current.ts` (never
  `auth()` directly, or the dev bypass is skipped). `web/proxy.ts` excludes `api/`, so machine
  routes must authenticate themselves.
- DB: `createTestDb()` from `@bamboo/db` gives a migrated in-memory libSQL per test. After editing
  `db/src/schema/*`, run `pnpm db:generate` and commit the migration; CI fails otherwise.
- `pnpm-workspace.yaml` `allowBuilds` denies install scripts for `esbuild`, `sharp` and
  `unrs-resolver`; a new dep that needs one must be added there.
- Playwright is not installed yet; M2 adds it and `test:e2e`.
- `Makefile`: `worker-install`, `worker-logs`, `mac-update` (M4) and `agent-install` (M5) are
  stubs that exit 1.

---

## M2 — Phrases, rounds & review *(first usable)*

**Goal:** Will can add phrases by hand and do a daily one-round spoken review on his phone, with
correct pinyin, audio and examples.

**Read:** PRD §3, §5.1, §5.2; DESIGN §2.1, §4.1–4.4, §4.6 (*Score* and *Queue order* only),
§4.8, §6 (Today, Review, Up next, Phrases, Audio), §7 (the review-related events).

**Owns:**
- the `phrase`, `card`, `review_log`, `round` and `event` tables and their migration;
- `shared/src/text.ts`;
- `web/lib/domain/{pinyin,session,fsrs,queue}.ts` (in `queue.ts`, scoring and ordering only);
- `web/lib/config.ts` and `web/lib/audio.ts`;
- pages: Today, Review (including Not useful / Already know), Up next, and Phrases (list, add,
  edit with examples, pinyin overrides and card types, drop);
- `pnpm db:seed` (synthetic phrases for local dev and e2e).

**Tests:**
- unit tests for normalization (the radical table, `hanziKey`);
- pinyin, including polyphones 得/行/长 in context, 一/不 sandhi, and examples;
- scoring and queue order (pinned first, age decay);
- rounds: the new cap across rounds, interleaving, sibling burying, Again within a round, the
  04:00 day boundary, the done-for-today logic, Not useful / Already know, and the asked-again
  rule as a pure function.

Coverage ≥ 90% on `web/lib/domain`. One Playwright e2e test at a phone viewport: add a phrase →
Start → reveal → Good → Done for today.

**Acceptance:**
```
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build
pnpm --filter web test:e2e
```
Manual on the iPhone (list it in the PR): the zh-CN voice speaks and slow replay works; ruby pinyin
is readable at phone width in light and dark mode; a round is ~10 cards.

**Out of scope:** imports, turns, jobs, Discord, reminder, stats.

**Notes:**

*Versions chosen (checked 2026-11-05):* ts-fsrs **6.0.0**, pinyin-pro **3.29.5**, zod **4.6.7**,
ulid **3.0.2**, @playwright/test **1.64.1** (1.65.0 was released the same day; not taken),
@vitest/coverage-v8 **5.1.0**, tsx **4.23.15** in `/web` (for the seed script). All exact.

*Acceptance (local, macOS, Node 24.22.2):* lint, typecheck, test, `web build` and `test:e2e` all
pass. Coverage on `web/lib/domain`: 99.6% statements, 94.5% branches, 98.9% functions, 99.5%
lines (`pnpm test` in `/web` fails below 90% on any of them).

*Deviations / choices:*
- **ts-fsrs 6 is a rewrite.** 6.0.0 (2026-10-28) replaces the `fsrs()` facade with an async
  `DefaultScheduler` that defaults to FSRS-7 and drops `Card.elapsed_days`. M2 uses FSRS-7 (no
  history to migrate) with `allowModelOverride: false`, since FSRS-7 otherwise skips the 1m/10m
  learning steps. The `card` columns follow the v6 card: `stability_fast`, `schedule_status`, and
  `scheduled_days` as real; no `elapsed_days`. DESIGN §2.1, §4.3 and §10 #22.
- **Pinyin context rules.** pinyin-pro 3.29.5 reads 跑得快/我得走 as `dé` and 长高 as `cháng`
  under every segmentation mode, so `pinyin.ts` adds a small rule table for 得 (de/děi) and 长
  (zhǎng). 行 is right out of the box. DESIGN §4.2 and §10 #23.
- **`normalizeText` skips NFKC on Chinese punctuation** (`，！？：；（）～…`): NFKC turns `…` into
  `...` and `，` into `,`, which would mangle stored, displayed hanzi and the frame slot.
  DESIGN §4.1.
- **Schema additions beyond DESIGN §2.1** (all in migration `0001_phrases_cards_rounds`):
  `phrase.pinned_at` (newest pin first), `card.suspended_at` (the editor's card-type toggle
  suspends instead of deleting, §10 #24), `review_log.state_before` and `review_log.round_id`,
  `round.card_ids`. `phrase.source_turn_id` has no FK yet: M3 adds the `turn` table (it can add
  the constraint only by rebuilding the table, so it may leave it as a plain column).
- **Rounds** (DESIGN §4.4 now spells these out): due cards take priority and new cards fill the
  remaining slots; one card per phrase per round; learning steps due within 20 min count as due
  (`learnAheadMinutes`); Again's re-insertion is judged at 15 s per remaining card
  (`secondsPerCard`), client-side. A phrase becomes `active` when its first card is graded.
- **Done for today** shows after any finished round, with "Another round (N due)" when more is
  waiting, instead of withholding "Done" until nothing is due. PRD §5.2 and DESIGN §10 #25.
- **The seed lives in `web/scripts/seed.ts`**, not `/db` as DESIGN §9 had it, because it uses the
  engine's pinyin, scoring and FSRS code. Root `pnpm db:seed` runs it; it refuses any non-`file:`
  database. 15 synthetic phrases, 6 active with past reviews and due now.
- **e2e** runs `next dev` on port 3100 against a fresh `db/e2e.db` (deleted and migrated by the
  web-server command), Chromium at 390×844 with touch. It doesn't use the seed: the flow needs an
  otherwise empty database. CI now also runs `pnpm db:seed`, installs Chromium and runs
  `test:e2e` after the build, uploading the Playwright report on failure.
- `requireUser()` now calls `connection()`, so every signed-in page renders per request even
  under `DEV_AUTH_BYPASS` (which reads no cookies and would otherwise let pages prerender, and
  query the database, at build time). Small edit to M1's `web/lib/auth/current.ts`.
- The Today page moved into the `app/(main)/` route group (shared bottom tab bar).
- Examples' pinyin is computed at read time, not stored.

*For M3+:*
- Domain code: `web/lib/domain/{day,fsrs,phrase,pinyin,queue,session,state}.ts`. `queue.ts` has
  `baseScore`, `effectiveScore`, `orderQueue`, `isLong`; M3 adds validation, dedupe, revival and
  expiry there. `session.ts` has `askedAgainCards()` for the asked-again rule; M3 applies it with
  `gradeCard`-style writes and `source: 'asked_again'`.
- DB access is in `web/lib/repo/` (`phrases.ts`, `review.ts`); `phraseRows()` builds a phrase and
  its cards (use it for imported phrases with `initialCardTypes(kind, turnKind)`). Multi-write
  operations use `runBatch()` (a libSQL batch is one transaction).
- Events written so far: `phrase_introduced`, `phrase_dropped` (with `via`), `already_know`,
  `review`, `round_finished`.
- Server actions are in `web/app/actions.ts`; each calls `requireUser()`.

---

## M3 — Capture: engine

**Goal:** everything on the Vercel side of capture: imports, turns, the job queue API, validation
and dedupe into the phrase queue, and expiry. The Mac side is faked in tests.

**Read:** PRD §5.3; DESIGN §2.2, §2.3 (`job`), §3, §4.5–4.7, §5.1 (*Results*), §5.3 (the
contract and engine side), §6 (Imports), §7.

**Owns:**
- the `import`, `turn` and `job` tables;
- contracts in `shared/src/contracts/` (`ImportRequest`, `ExtractTurnInput`,
  `ExtractTurnResult`, notification and nudge bodies);
- `shared/src/turns.ts`;
- routes `/api/imports*`, `/api/agent/notifications`, `/api/jobs/{claim,complete}`,
  `/api/worker/heartbeat`, `/api/cron/daily` (with the `vercel.json` cron);
- `web/lib/domain/queue.ts`: validation, dedupe, revive and expiry;
- import summaries;
- the Imports page, with the paste box and Retry failed;
- `pnpm smoke <url>` (`web/lib/smoke.ts`, `web/scripts/smoke.ts`): public, read-only checks of a
  deployment, run after each deploy (scope added by the orchestrator, approved by Will).

**Tests:** route integration tests on in-memory libSQL:
- `known` → `imports` with chunking and idempotency;
- turns deduped by `turn_key` across two imports, so the second import creates only new jobs;
- an image-only turn (empty prompt) keyed on its reply (DESIGN §4.5): two image-only turns with
  different replies get different keys;
- claim and lease, stale-attempt 409, lease expiry and requeue, 3-attempt failure, Retry failed;
- extract result:
  - a verbatim drop;
  - a `heard_as` drop;
  - an example drop (not verbatim / doesn't contain the term);
  - a merge into an active phrase (asked_count goes up and an Again review is logged);
  - a merge into a queued phrase (re-scored);
  - a revival of a dropped phrase;
  - examples capped at 3;
- the import goes to `done` with the right summary; notifications and `notified`;
- expiry by the cron;
- token scoping (the agent token cannot claim jobs, and vice versa).

The e2e test pastes text, completes the job through the API with a canned `ExtractTurnResult`, and
sees the phrase at the top of Up next.

**Acceptance:**
```
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build && pnpm --filter web test:e2e
```

**Out of scope:** the worker, `bamboo-tools`, the skill.

**Notes:**

*Versions:* no new runtime dependency in `/web`. `@bamboo/shared` now depends on zod **4.6.7**
(same as `/web`) for the contracts.

*Acceptance (local, macOS, Node 24.22.2):* lint, typecheck, test, `web build` and `test:e2e` (2
tests: M2's review flow and the new capture flow) all pass. Coverage on `web/lib/domain`: 99.7%
statements, 96.4% branches, 99.1% functions, 99.6% lines. `pnpm smoke` against a local
`next start` (fake Google client id, local tokens): 14/14. Against production (read-only, once,
before this PR is deployed): the 6 page/auth checks pass; the 8 machine-route checks get 404,
as expected, because the routes don't exist there yet.

*Deviations / choices:*
- **Frames: the slot is a wildcard in the verbatim check.** `您是说…吗` would otherwise fail on
  every turn that only contains the full sentence. Each fixed part must occur, in order.
  DESIGN §4.6, §10 #26.
- **`phrase.source_turn_id` has no FK** (deferred indefinitely): SQLite can add one only by
  rebuilding `phrase`, which isn't an expand-only migration. DESIGN §2.1, §10 #27.
- **Schema additions beyond DESIGN** (migration `0002_capture`, all additive):
  `phrase.last_asked_import_id` (asked again counts once per import, §10 #28);
  `import.idempotency_key` (unique), `phrases_new`, `phrases_again`, `uploaded_at`, `summary`;
  `turn.created_at`; `job.import_id` (fk). DESIGN §2.
- **Chunking protocol:** `POST /api/imports` takes `more: true` on every chunk but the last; the
  import can't finish before the last chunk. The response adds `turns_added` (this call) next to
  `turns_new` (the import's running total, so a retried call still reports the right number).
  A repeated `Idempotency-Key` on a first call returns the same import. §10 #31.
- **Attempts are counted by the engine.** A `complete` whose result fails `ExtractTurnResult`
  gets 422 `invalid_result` and uses up the attempt; so does an expired lease. `claim` sweeps
  expired leases first (the daily cron does too). §10 #30.
- **Reviving an introduced phrase** puts it back in `active` with Again on its reviewed cards,
  not in `queued` (where its reviewed cards could never come back). §10 #29.
- **An import with nothing new** is finished at once and marked notified (the skill already
  replied "Nothing new"), so `bamboo-tools replies` never posts for it.
- **Retry failed** reopens the import (status `extracting`, summary cleared) but doesn't reply in
  Discord again if it was already notified.
- **Summary wording** (`importSummary`): "✅ N new questions → M phrases queued. Next up: hanzi
  (english), …" with up to 3 of this import's queued phrases in queue order; extra lines for
  asked-again phrases, failed questions and the public-link reminder (links only). DESIGN §5.1.
- `newId()` now uses ULID's monotonic factory (small edit to M2's `web/lib/repo/db.ts`), so jobs
  created in one batch claim in turn order. `fsrsColumns` is now exported from M2's
  `web/lib/repo/review.ts` (for the asked-again Again review).
- **The Next dev indicator moved to the top right** (`next.config.ts`): with a fourth tab
  (Imports) it covered the Today tab at phone width and broke M2's e2e click.
- `turnKey(turn, kind)` takes the import kind; a prompt of only punctuation counts as empty.
- Today shows "⏳ N questions waiting for the Mac worker (last seen …)" when jobs are open and no
  heartbeat came in 25 min (`config.worker.offlineAfterMinutes`).
- The Vercel cron runs daily at 11:17 UTC (`web/vercel.json`), off the hour, around 04:00 LA.
- **`pnpm smoke <url>`** (orchestrator's scope addition): 14 checks, one line each, exit 1 on any
  failure. It never signs in and only ever sends the obviously fake `smoke-test-not-a-real-token`.
  Unit-tested against a fake deployment whose machine routes are the real route handlers
  (`web/lib/smoke.test.ts`), which also asserts the smoke list covers every machine route. CI
  never calls production.

*For M4 (worker):*
- Contracts: `ClaimedJob`, `CompleteRequest`, `CompleteResponse`, `Heartbeat`,
  `ExtractTurnInput`, `ExtractTurnResult` (+ `ExtractItem`, `TURN_KINDS`, `ITEM_KINDS`) from
  `@bamboo/shared`; limits in `sharedConfig.extraction` (≤ 8 items, `english` ≤ 120).
- `POST /api/jobs/claim` → 200 `ClaimedJob` or 204. `POST /api/jobs/complete` → 200
  `{job_status: 'queued' | 'done' | 'failed'}`, 409 `stale_attempt` (drop the job, claim the
  next), 422 `invalid_result` (counted as a failed attempt), 404 `not_found`. Echo `attempt`
  from the claim. Send `latency_ms` and `repaired` with results; `model` and `prompt_version`
  (`extract_turn.v1`) always.
- The engine counts attempts (max 3) and leases (10 min); the worker doesn't retry a job itself
  beyond its one repair turn: report `failed` and move on.
- `POST /api/worker/heartbeat` → 204. Only `WORKER_API_TOKEN` opens `/api/jobs/*` and
  `/api/worker/*`; the agent token gets 401 there.

*For M5 (bamboo-tools):*
- `turnKey({user_text, reply_text}, kind)` from `@bamboo/shared` (the engine recomputes).
  `POST /api/imports/known` takes ≤ `sharedConfig.imports.maxKnownKeys` (5,000) keys per call.
- `POST /api/imports` bodies ≤ `sharedConfig.imports.maxBodyBytes` (2 MiB) or 413. Chunk:
  first call without `import_id`, later calls with it, `more: true` on all but the last, and
  `Idempotency-Key: discord:<message id>` on every call. Print the final response's `turns_new`.
  Errors: 404 `not_found` (bad `import_id`), 409 `import_closed`, 409 `conflict` (retry).
- `GET /api/agent/notifications` → `{notifications: [{import_id, kind, discord_channel_id,
  discord_message_id, summary}]}`; post `summary` verbatim (it already has the link line), then
  `POST /api/imports/{id}/notified` (204, idempotent).
- `NudgeResponse` (`{text: string | null}`) is defined for M6's route.
- Error body everywhere: `ApiError` `{error, message?, issues?}`; codes in `API_ERROR_CODES`.

*Manual steps for Will (after merge):*
- `pnpm smoke https://bamboo-panda.vercel.app`: all 14 checks should pass once this is deployed.
- Vercel → *Observability → Cron Jobs* (corrected in M5): `/api/cron/daily` is listed, daily at 11:17 UTC; after its
  first run, its log shows a 200 with counts (a 401/503 means `CRON_SECRET` is missing).

---

## M4 — Worker *(parallel with M5)*

**Goal:** queued `extract_turn` jobs are processed on the Mac with the local model.

**Read:** DESIGN §1.2, §5.3, §8.3 (*Worker*), §8.4; M3 Notes.

**Owns:**
- `/worker`: the claim loop (concurrency 1, SIGTERM finishes the current job), the Ollama client
  (`format` schema, one repair turn), heartbeat and the model check;
- `prompts/extract_turn.v1.md`;
- `ops/launchd/com.bamboo.worker.plist`;
- the Makefile targets `worker-install`, `worker-logs`, `mac-update`.

**Tests:** the claim loop against a fake API; the Ollama client against recorded fake responses
(valid, invalid → repaired, invalid twice → failed); the prompt file loads and its version is
recorded. A test that uses a real model is opt-in only (`BAMBOO_EVAL_OLLAMA=1`) and is skipped in
CI: it runs the synthetic fixture turns through the real model and checks contract validity and
the verbatim pass rate.

**Acceptance:**
```
pnpm lint && pnpm typecheck && pnpm test
make worker-install && make worker-logs     # on the Mac: heartbeat posted
```
Manual on the Mac: paste a synthetic Gemini answer into the PWA's paste box → the phrases appear
in Up next within a minute.

**Out of scope:** reading links or PDFs (M5).

**Notes:**

*Versions:* no new third-party package. `@bamboo/worker` now depends on zod **4.6.7** (as `/web`
and `/shared` do) for `z.toJSONSchema`, and is version 0.1.0 (sent in the heartbeat with the
checkout's short sha).

*Acceptance (local, macOS, Node 24.22.2, as `willchan`):* `pnpm lint`, `pnpm typecheck` and
`pnpm test` pass (worker: 43 tests + the opt-in eval, skipped; web coverage on `lib/domain`
unchanged at 99.7%); `pnpm --filter web build` passes. `make worker-install && make worker-logs`
was **not** run for real (it belongs to `openclaw-agent`; this session may not touch launchd or
that account). Instead `worker/src/ops.test.ts` runs the three scripts for real against a temp
HOME with stub `launchctl`/`pnpm`/`git`: first run creates `worker.env` (600, dir 700) and
doesn't load without a token; with a token it renders and bootstraps the plist; a re-run is a
no-op; an existing `worker.env` is never overwritten (only its mode reset to 600); a changed
plist is booted out and re-bootstrapped; `KICKSTART=1` and `mac-update` kickstart; `DRY_RUN=1`
changes nothing; `worker-logs` shows the last heartbeat. `shellcheck`, `plutil -lint` and
`xmllint` pass. `main.ts` ran locally against a fake engine on localhost and the real Ollama:
heartbeat, one synthetic job done, SIGTERM mid-job → the job finished and was reported, exit 0.

*Real-model eval* (`BAMBOO_EVAL_OLLAMA=1`, `qwen3.5:9b`, `extract_turn.v1`, 8 synthetic turns,
final run): 8/8 contract-valid (0 repaired, 0 failed); items verbatim 15/15 (100%); examples
verbatim 9/11; turn kind agrees with the fixture's label 6/8 (the Cantonese-only turn came back
`decode` with no items; one decode turn came back `errand`); Cantonese-only term kept 0; 44 s of
model time. Five runs in all while tuning the term-example wording (each 40–50 s, sequential).

*Deviations / choices:*
- **The plist runs `node --import tsx src/main.ts`**, not `pnpm --filter @bamboo/worker start`, so
  SIGTERM reaches the worker; `ExitTimeOut` 300 s (launchd's default 20 s is shorter than a model
  call). The `start` script is the same command. DESIGN §8.3, §10 #38.
- **The worker reads `worker.env` itself** (`BAMBOO_WORKER_ENV`, default
  `~/.config/bamboo/worker.env`; the process env wins), so the plist has no secret. It warns if
  the file is readable by others. A missing/incomplete config exits 78 after a 5-min wait under
  launchd so `KeepAlive` doesn't spin. `worker-install` doesn't load the agent until
  `WORKER_API_TOKEN` is set. §10 #41.
- **The verbatim check moved to `shared/src/verbatim.ts`** (M3's `queue.ts` re-exports it,
  unchanged behaviour), so the eval measures exactly what the engine drops. §4.6, §10 #39.
- **Prompt file format:** `<!-- system -->`, `<!-- user -->`, `<!-- repair -->` parts; the repair
  turn's wording is versioned with the prompt. Tag list in the prompt: feeding, baby, toddler,
  food, cooking, groceries, household, cleaning, units, time, family, polite. §5.3.
- **Reply cut to 6,000 characters for the model** (`sharedConfig.worker.maxReplyCharsForModel`)
  to stay inside `num_ctx` 8192, kept equal to PandaBase's so the shared model isn't reloaded.
  §10 #40.
- **Ollama down mid-job** → `failed` reported and claims paused until `/api/tags` answers with the
  model (re-checked every 60 s, logged once). `complete` network/5xx errors are retried after
  5/20/60 s; 409/404 drop the job; 422 is logged. Claim errors back off 15 s → 5 min. §5.3.
- **`mac-update` kickstarts only when the pull moved HEAD** (a no-op update doesn't interrupt a
  job), and re-runs `worker-install`, which reloads instead if the plist changed.
- **Mac conventions (aligned with M5, PR #8):** everything runs as `openclaw-agent` from
  `~/Code/bamboo`; `worker.env` sits in `~/.config/bamboo/` next to M5's `agent.env` and
  `bamboo.config.json`; nothing goes into OpenClaw's gateway env. Scripts are in `ops/scripts/`
  (`lib.sh` follows PandaBase's `scripts/ops/lib.sh`: `DRY_RUN`, `run`, `need`; overridable
  `BAMBOO_CONFIG_DIR`, `LAUNCH_AGENTS_DIR`, `LOG_DIR`, `LAUNCHD_DOMAIN`). The launchd domain is
  `gui/<uid>`, which needs `openclaw-agent`'s login session (automatic login); over ssh without
  one, `LAUNCHD_DOMAIN=user/<uid>` is the fallback the error message suggests.
- **§10 numbering:** M4's rows are #38–41; #33–37 are M5's (PR #8).
- Fixtures: `worker/tests/fixtures/turns.json` (8 synthetic turns: decode ×2, say ×3 incl. a
  frame and a pasted answer, errand, a Cantonese-only term) and `ollama.json` (Ollama 0.40
  response shapes, recorded from a real call, with synthetic content).

*For M6 / later:* the heartbeat sends `version` (worker `package.json`), `sha` (12 chars),
`model`, `ollama_ok`. `pnpm --filter @bamboo/worker test:ollama` re-runs the eval after a prompt
or model change (`OLLAMA_TEXT_MODEL`, `EVAL_MIN_VERBATIM`).

*Manual steps for Will* (as `openclaw-agent`, e.g. `ssh agent`):
1. `git clone https://github.com/willchan/bamboo.git ~/Code/bamboo && cd ~/Code/bamboo` (skip if
   M5's setup already cloned it).
2. `make worker-install`: creates `~/.config/bamboo/worker.env` (600) and stops before loading.
3. Edit `~/.config/bamboo/worker.env`: paste the production `WORKER_API_TOKEN` from Vercel
   (Settings → Environment Variables → Production). Leave the rest as is.
4. `make worker-install` again: loads `com.bamboo.worker`.
5. `make worker-logs`: within a few seconds, `ollama ok: qwen3.5:9b is pulled` and
   `heartbeat ok (ollama_ok=true)` (a `heartbeat failed: HTTP 401 unauthorized` means the token
   doesn't match Vercel's). Today in the PWA stops showing the worker as offline.
6. End to end: in the PWA's Imports page, paste a synthetic Gemini answer (e.g. the `fx-say-1`
   reply in `worker/tests/fixtures/turns.json`) → within a minute `make worker-logs` shows
   `job … done, N item(s) … → job done` and the phrases appear in Up next. Remove them from Up
   next afterwards if you don't want them.
7. Later updates: `make mac-update`.

---

## M5 — Discord intake *(parallel with M4)*

**Goal:** Will shares a Gemini conversation to `#bamboo` and gets a reply with what was queued.

**Read:** PRD §5.3; DESIGN §4.1, §4.5, §5.1, §5.2, §8.3 (*Agent*), §8.4, Appendix A; M0 and M3
Notes. Also PandaBase's `agent/skills/discord-intake/SKILL.md` and DESIGN §6 (skill format,
command automations, `make install-agent-*`).

**Owns:**
- `/agent/tools` (`bamboo-tools`): `import --url | --file | --text-file`, `segment` (dry run),
  `replies`, and `nudge` (the CLI side only; the engine route is M6);
- `agent/tools/src/share.ts`: port the RPC reader from `spikes/share-link/read.mjs` (M0 Notes).
  Fetch with `node:https` and a large `maxHeaderSize`, because Node's `fetch` fails on Google's
  response headers. Don't ship Playwright. If the RPC breaks, reply asking for the PDF
  (`share_parse_failed`);
- the **PDF path is required** whatever M0 found: `--file`, `pdftotext`, segmentation;
- `shared/src/segment.ts` and the synthetic PDF-text fixture;
- `agent/skills/bamboo/SKILL.md` and `agent/bamboo.config.example.json`;
- the Makefile target `agent-install` (PATH, config, extraDirs with a backup, command
  automations).

**Tests:**
- segmentation of the synthetic PDF text (exact expected turns, radicals normalized, boilerplate
  and duplicates removed);
- share parsing of the synthetic RPC fixture (`share-rpc.txt` → `share-page.expected.json`);
- an image-only prompt from a link or a PDF gets the reply-based key (DESIGN §4.5);
- import chunking and the `known` round-trip against a fake API;
- `replies` prints `NO_REPLY` when idle and posts and marks notified otherwise;
- the skill's frontmatter parses, and every command it names exists (PandaBase's
  `test_skills.py` idea, in TypeScript).

**Acceptance:**
```
pnpm lint && pnpm typecheck && pnpm test
make agent-install
bamboo-tools segment --url <Will's link>     # on the Mac: sensible title and turn count
```
Manual, end to end (needs M4):
- share the real conversation link to `#bamboo` → acknowledgement → the reply arrives with
  "N new questions → M phrases queued";
- re-share it → "Nothing new since last time";
- add a message in Gemini, re-share (a new link, since old links are frozen snapshots; M0 Notes) →
  only the new question is reported;
- share the PDF of the same conversation → also nothing new (turn keys agree across formats).

Report counts only in the PR.

**Out of scope:** the reminder decision logic and stats (M6).

**Notes:**

*Versions:* no new third-party package. `@bamboo/tools` now depends on `zod` **4.6.7** (as
`/web` and `/shared`) and moves `tsx` **4.23.15** from dev to runtime dependencies (the
`bamboo-tools` wrapper runs the CLI with it). poppler (`pdftotext`) 26.10.0 from Homebrew (installed by Will mid-session; used only on synthetic PDFs).

*Acceptance (local, macOS, Node 24.22.2):* `pnpm lint`, `pnpm typecheck`, `pnpm test` pass
(shared 29, tools 44 tests; web 140 still at ≥ 90% coverage), and `pnpm --filter web build`.
`bamboo-tools segment --url <Will's link>`, run from Will's account (read-only; counts only):
**88 turns, 1 with no prompt text** (image-only), a 28-character title, no unknown components,
~1.5 s. That matches M0's re-shared link B. `make agent-install` was **not** run on the live
gateway (see below); it's tested against a fake `openclaw` in a temp HOME instead (`DRY_RUN`,
idempotency, backup, additive extraDirs, automations, no token in any output or call).

*Deviations / choices:*
- **Two macOS users.** OpenClaw, Ollama and PandaBase's agent checkout run as `openclaw-agent`
  (home mode 750), not as Will. Everything Bamboo installs belongs in that account, checkout
  at `~/Code/bamboo` (PandaBase's convention there; DESIGN said `~/src/bamboo`). The milestone
  session runs as Will, so it couldn't and didn't run `make agent-install` for real: Will runs it
  as `openclaw-agent` (manual steps). DESIGN §8.3, §10 #36. **For M4:** the worker's
  LaunchAgent, `~/.config/bamboo/worker.env` and logs belong in that account too, and
  `make worker-install` / `mac-update` run there.
- **No `requires.env` in the skill; settings in `~/.config/bamboo/`.** The gateway env
  (`~/.openclaw/.env`) already holds PandaBase's `AGENT_API_TOKEN`; Bamboo's token can't share
  the name, and new gateway env needs a gateway restart. `bamboo-tools` reads `agent.env`
  (`BAMBOO_API_URL`, `AGENT_API_TOKEN`, mode 600) and `bamboo.config.json` (Discord ids) from
  `~/.config/bamboo/`; the process env wins. DESIGN §5.1, §8.1, §10 #33.
- **`import` prints the reply.** Its JSON has a `reply` field the skill posts verbatim: "📥 Got
  it…", "✅ Nothing new since last time." (plus the public-link line for links), or a failure
  line (`share_parse_failed` asks for the PDF; `pdftotext_missing` / `pdf_unreadable` ask for the
  link). `NOTHING_NEW` and `PUBLIC_LINK_NOTE` moved to `@bamboo/shared/config.ts` so the engine's
  summary and the CLI share one string (small edit to M3's `web/lib/domain/imports.ts`, which
  re-exports `PUBLIC_LINK_NOTE`). An import with nothing new is still POSTed (empty `turns`), so
  it's recorded and a retried command reports the import's running `turns_new`. DESIGN §5.1,
  §10 #35.
- **Ligature repair in the PDF segmenter** (`!`→fi, `#`→tt, `&`→fl, `%`→ft, next to letters).
  Will's prompts have no hanzi, so their keys are English letters, and DESIGN §4.1's "leave
  ligatures alone" would make a PDF of a linked conversation look all new. The map is inferred
  from DESIGN's four examples; the manual real-PDF check confirms it. DESIGN §5.2, §10 #34.
- **Segmentation details** DESIGN didn't pin down: the "Explore related" block ends at 2+ blank
  lines or a page break; a duplicate line is collapsed only when adjacent or across a page break
  (`\f`), and the page gap goes with it so a prompt split by a break stays one block; a prompt
  may continue across a page break; prompt lines are joined with spaces. **Image-only turns in a
  PDF**: unverified (no real PDF yet). Most likely the bubble has no text, so the reply merges into
  the previous turn; that keeps "PDF after link → nothing new" true, while "link after PDF" would
  report the image-only turn as 1 new. Check with the real PDF.
- **Replies in Discord** follow PandaBase's `jobs replies`: one notification →
  `[[reply_to:<message id>]] <summary>`; several → each summary with a link to its message
  (needs `discord.guild_id`). Marked notified before printing, as PandaBase does.
- **`nudge` treats a 404 as `NO_REPLY`** until M6 deploys `GET /api/agent/nudge`, so the
  automation stays quiet instead of posting errors. **For M6:** keep the response
  `NudgeResponse`; the automation (`bamboo-nudge`, `*/30 17-23 * * *` in the config's tz) is
  already installed.
- **`make agent-install`** is `agent/install.sh` (bash 3.2-safe, `DRY_RUN=1`). It runs
  `pnpm install --frozen-lockfile`, links `~/.local/bin/bamboo-tools` →
  `agent/tools/bin/bamboo-tools`, creates the two config files only if missing (ids from
  `BAMBOO_DISCORD_CHANNEL_ID` / `BAMBOO_DISCORD_GUILD_ID`, URL from `BAMBOO_API_URL`, the token
  left empty), and appends `<checkout>/agent/skills` to `skills.load.extraDirs` after backing up
  `openclaw.json` (replacing only another *Bamboo* checkout's stale entry). The two command
  automations are added only once the token is set (a re-run), and edited in place by name
  after that (§10 #37). It never writes `~/.openclaw/.env`, never restarts the gateway, and
  never edits the Discord allowlist: if `#bamboo` isn't enabled for the bot it prints the
  `openclaw config set …` command instead.
- **The `bamboo-tools` wrapper** (`agent/tools/bin/bamboo-tools`, `sh`) resolves its symlink,
  puts `/opt/homebrew/bin` on PATH (node, pdftotext; command automations run `sh -lc`), and runs
  `src/main.ts` with tsx.
- **No Playwright on the Mac**, as M0 recommended; DESIGN §1, §1.2 and §8.3 no longer mention it.
- The CLI refuses a `--channel-id` that isn't the configured `#bamboo` channel (`wrong_channel`).
- Tests use an in-memory fake engine (`agent/tools/src/fake-engine.test-util.ts`) with M3's
  semantics; no web route is exercised from `/agent/tools`. The real-`pdftotext` test generates a
  tiny synthetic PDF and is skipped where poppler is missing (CI).
- **README**: the deploy step's cron check said *Settings → Cron Jobs*; Vercel has it under
  *Observability → Cron Jobs* (fixed, also in M3's manual steps above). New *Mac mini: Discord
  intake* section.
- During this session, the CLI calls made from Will's account (`openclaw config file`, `config
  get`, `automations list`) created an unused `~/.openclaw/state/` in **Will's** account (not the
  gateway's); it can be deleted. Read-only `ssh agent` probes (config get, automations list) ran
  before the orchestrator said not to ssh; nothing was changed there.

*Manual steps for Will (after merge; as `openclaw-agent` unless noted):*
1. `ssh agent`, then `git clone https://github.com/willchan/bamboo.git ~/Code/bamboo`.
2. `cd ~/Code/bamboo && BAMBOO_API_URL=https://bamboo-panda.vercel.app
   BAMBOO_DISCORD_CHANNEL_ID=<#bamboo id> BAMBOO_DISCORD_GUILD_ID=<server id> make agent-install`
   (try `DRY_RUN=1` first). It reports the `openclaw.json` backup path.
3. Put `AGENT_API_TOKEN` (production) in `~/.config/bamboo/agent.env`, then run
   `make agent-install` again to add the two automations.
4. If it warns that `#bamboo` isn't enabled for the bot, run the printed `openclaw config set
   channels.discord.guilds.<server>.channels.<#bamboo> …` with `#pandabase`'s user id.
5. `bamboo-tools segment --url <link>`: the title and a turn count.
6. End to end (needs M4's worker): the four checks in *Acceptance* above, including the PDF
   ones (export the PDF, share it to `#bamboo`; it should be "Nothing new" after the link).

---

## M6 — Reminder & stats

**Goal:** one well-timed evening reminder when a round is waiting, and a Stats page showing
whether this is working.

**Read:** PRD §5.4, §6; DESIGN §4.9, §6 (Stats), §7; M5 Notes.

**Owns:** `web/lib/domain/nudge.ts`; `GET /api/agent/nudge`; the reminder toggle on Today; the
`/stats` page and its queries; moving the daily cron to Vercel Schedules (below).

**Vercel Schedules.** Vercel now marks Cron Jobs (`crons` in `web/vercel.json`, which M3 added
for `/api/cron/daily`) as legacy and deprecated in favour of *Schedules*. Check Vercel's current
docs on Schedules and how to migrate, then move `/api/cron/daily` to Schedules, keeping its time
(11:17 UTC) and its `CRON_SECRET` check, or whatever Schedules uses instead. If Schedules can't
do that yet, keep the cron and record why in Notes. Update DESIGN §8 and the README's deploy
section (the cron is under Observability in the Vercel dashboard), and add `GET /api/agent/nudge`
to `pnpm smoke`'s machine-route list.

**Tests:** the nudge decision (sent at most once a day; suppressed after a finished round or when
there's nothing to do; the default 21:00 until 5 rounds exist; the median-minus-15 rule; the
clamp; the 04:00 day boundary); stats queries on fixture data.

**Acceptance:** the standard commands. Manual:
- a reminder arrives in `#bamboo` in the evening, and doesn't arrive on a day when a round is
  already done;
- after merge, the daily job shows in Vercel (Schedules, or Observability → Cron Jobs if it stayed)
  and its first run returns 200;
- `pnpm smoke https://bamboo-panda.vercel.app` passes.

**Notes:**
