# Bamboo — Build Plan

> Living document. Each milestone is executed by **one fresh Claude Code session** producing
> **one PR**. Sessions read only what their milestone lists. When a milestone deviates from this
> plan or from DESIGN.md, record it in the milestone's **Notes** and update DESIGN.md in the same
> PR.

## Session protocol

1. Read `CLAUDE.md`, this file's *Session protocol*, and **your milestone only**, then the
   DESIGN/PRD sections it lists.
2. Branch from the latest `main`: `claude/m<N>-<slug>` (Hybrid milestones: `claude/h<N>-<slug>`).
3. Build to the acceptance criteria. Run every acceptance command locally; all must pass.
4. Update the status table below (→ `in review`) and your milestone's **Notes**: versions chosen,
   deviations, and anything later milestones need to know.
5. Open a PR titled `M<N>: <title>` (or `H<N>: <title>`). The body lists the acceptance commands and their results,
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
   and anything a milestone marks as Will's call. **Merging follows CLAUDE.md › *Merge when
   green*:** a PR that is mergeable, with every required check passed and no unresolved review
   thread, is merged without asking, unless its milestone (or Will) says he reviews it first.
   Anything that needs `sudo` or touches production is still asked first.
7. **Keeps the status table current,** then loops back to step 1 until M6 is merged. At the end it
   summarizes what was built, what changed from the plan, and the open ROADMAP candidates. The
   same loop runs the *Hybrid* milestones (H1–H7, below) until H7 is merged; their sessions
   branch as `claude/h<N>-<slug>` and title PRs `H<N>: <title>`.

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

Hybrid (Gemini-backed; DESIGN §5.5, §10 #74–#83), after the docs PR that records the decisions:

```
docs ─┬─▶ H1 (pinyin a) ──┐
      ├─▶ H3 (card back) ─┴─▶ H4 (worker on Gemini) ─┬─▶ H5 (tutor capture) ──┬─▶ H7 (backfill)
      │                                              └─▶ H6 (re-run; also H3) ─┤
      └─▶ H2 (estimate → Will chooses → new-card policy) ─────────────────────┘
```

H1 ∥ H3 may run in parallel (H1 adds no migration). Every milestone that adds a migration (H2b,
H3, H4, H6) runs **serially**: each starts from, or is rebased onto, the previous one's merge
before it generates its migration, so drizzle's journal and numbering never conflict. After every
merge, `make mac-update` on the Mac (CLAUDE.md › *Working on the live Mac mini*). H2 has no
dependency besides the docs and can go anywhere in the serial chain before H7, which waits for
H2b; its estimate step (H2a) can run at once. Merging follows CLAUDE.md › *Merge when green*. Steps that need Will (H2's choice,
H5's host change, H7's full run) are gathered by the orchestrator as inputs, as in its step 2.

## Status

| Milestone | Status | PR |
|---|---|---|
| M0 Share-link spike | merged | [#3](https://github.com/willchan/bamboo/pull/3) |
| M1 Skeleton, auth, deploy | merged | [#2](https://github.com/willchan/bamboo/pull/2) |
| M2 Phrases, rounds & review | merged | [#5](https://github.com/willchan/bamboo/pull/5) |
| M3 Capture: engine | merged | [#6](https://github.com/willchan/bamboo/pull/6) |
| M4 Worker | merged | [#9](https://github.com/willchan/bamboo/pull/9) |
| M5 Discord intake | merged | [#8](https://github.com/willchan/bamboo/pull/8) |
| M6 Reminder & stats | merged | [#13](https://github.com/willchan/bamboo/pull/13) |
| H1 Pinyin: large dictionary | merged | [#42](https://github.com/willchan/bamboo/pull/42) |
| H2 Frames retired; new-card policy | merged | [#45](https://github.com/willchan/bamboo/pull/45) |
| H3 Card back: breakdowns and glosses | merged | [#43](https://github.com/willchan/bamboo/pull/43) |
| H4 Worker on Gemini | merged | [#44](https://github.com/willchan/bamboo/pull/44) |
| H5 Tutor capture | in review | |
| H6 Re-run extension | in review | |
| H7 Backfill | planned | |

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

*Follow-up PR: review speed (2026-11-07).* From Will's iPhone report (slow pages and next card;
slow replay not slower; the same card first in several rounds):
- Functions pinned to `pdx1` next to Turso `us-west-2` (DESIGN §8.2, §10 #52). Request timing
  log lines and `Server-Timing` on API routes (§8.5, #53). Independent reads batched; the counts
  per request are pinned by `web/lib/repo/query-count.test.ts` (§8.5, #54).
- Grading no longer waits for the server: background saves with retry and an idempotent
  `reviewId` (§6, #55). New e2e test with a dropped save request.
- Slow replay 0.6 → 0.45, `cancel()` only when busy (§6 *Audio*, #56). Regression tests first.
- "Same card first": not a scheduling bug. A new card rated Good is due again in 10 minutes
  (inside learn-ahead), so it's in the next round, and by due it led because it was graded first
  (`web/lib/repo/evening.test.ts` replays it). Learning cards now come in a per-round order
  (§4.4, #57); scheduling is unchanged. Regression test first (fails on due order).
- *For Will:* on the iPhone, check that 🐢 Slow is clearly slower than Replay, and that pages and
  the next card feel fast. Vercel logs now show one `"msg":"timing"` line per request.

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
- **Pinyin in Discord replies (post-merge change, 2026-11-06).** Will can't read new words' hanzi,
  so Next up now reads `hanzi pinyin (english)`, e.g. `高压锅 gāo yā guō (pressure cooker)`: the
  phrase's stored pinyin with his overrides (`displayPinyin`), spaced like `pinyinText`, a frame's
  `…` kept (`replyPinyin`). A summary over Discord's 2,000 characters
  (`imports.discordMaxChars`) names fewer phrases instead of dropping pinyin. No other
  Bamboo-generated Discord text (failure replies, Nothing new, the link note, the M6 reminder)
  contains hanzi, so nothing else changed. DESIGN §5.1, §10 #48.
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
- **Prefixed token (follow-up PR, 2026-11-06).** Because the process env wins and OpenClaw
  passes its gateway env to every tool, `bamboo-tools` actually read PandaBase's
  `AGENT_API_TOKEN` instead of `agent.env`'s. The key is now `BAMBOO_AGENT_API_TOKEN`;
  `make agent-install` renames an older file's line in place (DESIGN §10 #42). PandaBase prefixes
  its side too (`PANDABASE_AGENT_API_TOKEN`).
- **`#bamboo` pinned to the skill (post-merge fix, 2026-11-05).** Live, the agent answered a bare
  share link in `#bamboo` with OpenClaw's `view_image` (which failed) instead of the bamboo skill.
  Two causes: nothing kept other tools and skills out of the channel, and the skill's unquoted
  `description` was cut at ` #bamboo` by OpenClaw's YAML parser, leaving "Bamboo intake in the".
  `make agent-install` now merges `skills: ["bamboo"]`, a firm `systemPrompt` and a `tools.deny`
  of the media/link readers into `#bamboo`'s existing entry (access keys and other channels
  untouched; the printed command for a missing entry includes them), and the description is a
  double-quoted string naming the bare share-link forms. Regression tests in
  `agent/tools/src/install.test.ts`. DESIGN §5.1, §8.3, §10 #43. **Will:** `git pull --ff-only &&
  make agent-install` as `openclaw-agent`, then start a new session in `#bamboo` (`/new`) so the
  agent picks up the pin and the new description.
- **Dedicated `bamboo` agent (post-merge, 2026-11-06).** Through the shared `main` agent a
  `#bamboo` message took 75–120 s, almost all of it the model (`ollama/qwen3.5:27b`) thinking;
  with thinking off the same model answers in ~5–25 s. OpenClaw sets thinking per agent, so the
  orchestrator set up a `bamboo` agent by hand on the Mac (thinking off, `skills: ["bamboo"]`, the
  skill's body inline in its workspace `AGENTS.md`, `#bamboo` bound to it ahead of main's Discord
  binding, systemAgent `main`). With thinking off the model didn't open `SKILL.md` and guessed
  flags; inline, it chose right for a link, a PDF, pasted text and chit-chat every time. A
  follow-up PR makes it reproducible: `make agent-install` applies it (the workspace `AGENTS.md`
  is generated from `SKILL.md`; `BOOTSTRAP.md` goes to `.orig/`; the binding is merged, keeping
  every other one), the new `make agent-check` verifies it, and `make mac-update` now ends with
  `agent-install` so a pulled `SKILL.md` reaches the agent. Routing is applied rather than
  printed because the merge only prepends one binding, refuses a `bindings` it can't read as a
  list, and leaves a non-`main` systemAgent alone. Tests: `agent/tools/src/openclaw/agent.test.ts`
  (generator on a synthetic skill, binding merge, routing) and `install.test.ts` (fake OpenClaw).
  DESIGN §5.1, §8.3, §10 #50. **Will:** `make mac-update` as `openclaw-agent`; it should end
  with `agent-check: ok`.
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

- **Later fix: quiet automation errors.** A single network blip posted
  `bamboo-tools replies: GET /api/agent/notifications: fetch failed` to `#bamboo`: OpenClaw posts
  stderr when stdout is empty, so M6's "exit 1 with nothing on stdout posts nothing" was wrong.
  `replies` and `nudge` now post nothing on transient errors and alert once after 30 min of
  outage (one line on recovery); other errors are posted once per distinct error (DESIGN §5.1
  *Automation errors*, §10 #51). Regression test committed first, failing (`automations stay
  quiet on a transient error`). For these two commands the 401 token-source message (§10 #46)
  now goes to stdout, not stderr. Deploy: `make mac-update` (the CLI is a symlink into the
  checkout; no automation change).

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

*What's here:*
- `web/lib/domain/nudge.ts` (pure: `eveningMinutes`, `practiceStarts`, `nudgeTime`, `nudgeText`,
  `decideNudge`) and `web/lib/repo/nudge.ts` (`takeNudge`, `evaluateNudge`, `getNudgeTime`,
  the `nudge_enabled` setting). `GET /api/agent/nudge` answers `NudgeResponse` unchanged
  (`{text: string | null}`). Tunables in `config.nudge` and `config.stats`.
- `/stats` (fifth tab) with `web/lib/domain/stats.ts` (pure measures) and
  `web/lib/repo/stats.ts` (queries); the reminder switch on Today (server action
  `setNudgeAction`).
- Tests: `web/lib/domain/nudge.test.ts`, `stats.test.ts`; `web/lib/repo/m6.test.ts` (the route
  and the Stats queries on synthetic fixture data, in-memory DB); `web/e2e/stats.spec.ts`;
  `web/lib/vercel-config.test.ts`. No migration: `setting`, `round` and `event` already had
  everything.

*Deviations / choices:*
- **Vercel Schedules: migrated.** Checked Vercel's docs (Schedules overview, *Migrating from Cron
  Jobs to Schedules*, Concepts, Configuration reference; 2026-10/11). A static schedule in
  `web/vercel.json` (`"schedules": {"daily": {"schedule": "17 11 * * *", "path":
  "/api/cron/daily", "requestMethod": "GET"}}`) keeps the route, the UTC time and the
  `CRON_SECRET` bearer check (Vercel still sends it, plus `user-agent: vercel-cron/1.0`); `crons`
  is removed in the same change (both would run the job twice). Caveats, recorded in DESIGN §8.2
  and §10 #44: Schedules are **beta**; runs start within a jitter window (1 min on Pro, always
  15 min on Hobby, which is still tighter than a legacy Hobby cron's "any time in the hour");
  failed path runs aren't retried; a run may very rarely be delivered twice (the job is
  idempotent). Static schedules are inactive on preview branches. The schedule name `daily` must
  stay stable (renaming creates a new schedule). Not done: a private `function` target (needs
  `@vercel/schedules` and an experimental trigger; not worth it for one idempotent job behind a
  secret). It now shows under the project's **Schedules** page, not *Observability → Cron Jobs*.
- **Practice days, not rounds.** DESIGN §4.9's "at least 5 rounds in the last 14 days" counts the
  first finished round of each household day before today, so "Another round" or an abandoned
  round doesn't pull the median (§10 #47). Today's rounds don't count. Times are measured inside
  the 04:00 day (00:30 → 24:30), then clamped to 18:00–23:00.
- **Text**: `📚 1 round · ~{min} min · {due} due · {new} new → {APP_URL}`: DESIGN's text plus the
  new count, zero counts left out, minutes from round size × `secondsPerCard` (10 cards → ~3).
  `APP_URL` falls back to the request origin.
- **Once a day, race-safe**: sending is a conditional upsert of `nudge_last_sent_day` (only one of
  two overlapping polls wins), then a `nudge_sent {local_time, nudge_at}` event.
- **`bamboo-tools nudge` no longer treats 404 as NO_REPLY** (M5's stopgap): the route exists now,
  and a 404 would more likely mean a wrong `BAMBOO_API_URL`. Errors exit 1 with nothing on stdout,
  so the automation posts nothing either way. *(Wrong: OpenClaw posts stderr when stdout is
  empty. Fixed later; see M5 Notes, "Later fix: quiet automation errors".)*
- **Stats definitions** (DESIGN §7): rolling 7-day weeks of household days ending today; true
  retention = Review-state `session` grades above Again; Not useful = `not_useful` drops over
  (those + introduced), split by kind and usefulness; extraction drop rate =
  `dropped_not_verbatim / items` from `extraction` events (PRD §6 now says that's how
  "extraction quality" is measured).
- **Extra scope (Will approved; from a closed PR):**
  1. On a 401, `bamboo-tools` (every command) says where its token came from:
     `token from BAMBOO_AGENT_API_TOKEN in <agent.env path>` or `token from environment variable
     BAMBOO_AGENT_API_TOKEN`; tests assert the value never appears in stdout or stderr. DESIGN
     §8.1, §10 #46.
  2. **`worker.env` now wins over the process env** for the keys it lists (`loadEnvFile`), so an
     inherited generic `WORKER_API_TOKEN` / `OLLAMA_URL` / `OLLAMA_TEXT_MODEL` can't override
     Bamboo's file; an empty value in the file means "default", and keys the file omits still
     come from the env. Regression test committed first, failing (`worker.env wins over inherited
     generic variables…`), then the fix. DESIGN §8.1, §10 #45.
- `pnpm smoke` now has 15 checks (`GET /api/agent/nudge` added to `MACHINE_ROUTES`).
- The status table's M4 row said *in review*; it's merged (#9), corrected here.

*Manual steps for Will (after merge):*
1. `pnpm smoke https://bamboo-panda.vercel.app`: all 15 checks pass.
2. Vercel → the project's **Schedules** page: `daily` is listed and active (`17 11 * * *`, UTC).
   Click *Run Schedule* once: the run returns 200 with counts (401/503 = `CRON_SECRET` missing).
   The *Cron Jobs* tab should be empty. If the deploy shows no schedule (beta not enabled for
   the account, say), revert `web/vercel.json` to the `crons` line in DESIGN §8.2.
3. In the evening (from 21:00 LA, or after enough practice days, just before the usual time) on a
   day with a round waiting and none done: one reminder in `#bamboo`. On a day with a round
   already done: none. The switch on Today shows the time and turns it off.
4. On the phone: the Stats tab renders (it's mostly empty until there's history).

*For the orchestrator (on the Mac, as `openclaw-agent`):* `make mac-update` in `~/Code/bamboo`
(pulls; restarts the worker, which now reads `worker.env` over its env; `bamboo-tools` is a
symlink into the checkout, so the new 401 message and nudge handling take effect at once). No
config change, no new automation: `bamboo-nudge` already runs `bamboo-tools nudge`.

---

# Hybrid H1–H7 *(Gemini-backed)*

Will's decisions of 2026-11 (DESIGN §5.5, §10 #74–#83) move Bamboo to Gemini for tutoring and
extraction, with Ollama only as a fallback. Each milestone below is one task, one session, one PR,
following the *Session protocol* (branch `claude/h<N>-<slug>`, PR title `H<N>: <title>`). Every
session also reads DESIGN §5.5 (the target design) and CLAUDE.md › *Privacy*. As a milestone
lands, it moves its part of §5.5 into the sections it changes (§2, §4, §5.3, §6, §7, §8) and says
so in §5.5.

**Order and merging.** See *Dependency graph*: H1 ∥ H3 may run in parallel; anything that adds a
migration (H2b, H3, H4, H6) runs serially, each rebased onto the previous merge before
`pnpm db:generate`, so drizzle migrations never conflict. After every merge, `make mac-update` on
the Mac. Merging follows CLAUDE.md › *Merge when green*, except where a milestone says Will
approves first.

**Standard commands** (every milestone): `pnpm lint && pnpm typecheck && pnpm test && pnpm
--filter web build`, plus `pnpm --filter web test:e2e` when the UI changes.

## H1 — Pinyin (a): large dictionary *(depends on: docs)*

**Goal:** computed pinyin reads everyday words right, neutral tones included, without a rule
table.

**Read:** DESIGN §4.2, §5.5.3, §10 #80; CLAUDE.md › the pinyin rule.

**Scope:**
- Load pinyin-pro's large dictionary (`@pinyin-pro/data`, via `addDict`), **trimmed** by a
  committed generator script to the entries that change a reading compared with pinyin-pro's
  built-in result, so the data fits a Vercel function. Record the package version, entry count
  and size in Notes.
- Remove the context-rule table (the 得 and 长 rules, and any others) from
  `web/lib/domain/pinyin.ts`, with its tests. Add no rules: polyphones are settled by H4's merge.
- Tests on synthetic sentences, including 梯子, 肚子, 舒服, 里脊 and 芝麻 (neutral tones).
- `repinyin` runs on deploy as today (DESIGN §8.2) and rewrites stored pinyin; overrides stay.
- Until H4, this is the only pinyin source (hand-added phrases keep it afterwards until their
  pinyin job has run).
- Update DESIGN §4.2 and §10 #23 (superseded).

**Acceptance:**
- the standard commands;
- `pnpm --filter web test -- pinyin` passes, with the five neutral-tone words and no context-rule
  tests left;
- `pnpm db:seed && pnpm --filter web repinyin` runs against `file:db/dev.db` and reports how
  many phrases changed;
- the generator script reproduces the committed data file byte for byte; `pnpm --filter web
  build` passes (the function bundle stays under Vercel's limit; record its size).

**Notes:**
- **Dictionary:** `@pinyin-pro/data` 1.3.1, the `complete` dictionary (348,838 entries), with
  pinyin-pro 3.29.5. Trimmed to 15,684 entries (607,000 bytes) in `web/lib/data/pinyin-dict.json`,
  kept with their frequencies. `complete` over `modern` (58,907 entries, 2,630 kept, 70 KB): both
  fix the five words, but on synthetic household sentences `complete` also reads 睡不着 zháo, 长牙
  zhǎng, 点儿 er and 等一等 yi, which `modern` misses. `@pinyin-pro/data` is a devDependency: only
  the generator reads it, and the build doesn't trace it.
- **Generator:** `web/scripts/pinyin-dict.ts` (`pnpm --filter web gen:pinyin-dict`, `--check`);
  `scripts/pinyin-dict.test.ts` asserts byte-for-byte reproduction in CI (about 0.3 s). The trim
  compares each entry in isolation with the built-in reading; a dropped entry could still have
  mattered for segmentation inside a longer sentence, which is accepted. Re-run it whenever
  pinyin-pro or `@pinyin-pro/data` is bumped (the test fails until you do).
- **Data file location:** `web/lib/data/` (with `wordfreq-zh.ts`) rather than `lib/domain/`, and
  added to `.prettierignore`, since it's generated.
- **Context rules removed** with their tests (得, 长, and the 行 context test). As decided, the
  readings they fixed regress until H4's merge (or Will's override): structural 得 (跑得很快) and
  modal 得 (我得走) read dé, and 长高 / 长得 read cháng; 长大 still reads zhǎng from the dictionary.
  行不行 now reads xíng bu xíng. Tests in `capture.test.ts` and `repo.test.ts` that relied on
  得 → děi now set a děi override instead.
- **Function size:** `pnpm --filter web build` passes; the largest traced function
  (`/phrases/[id]`) is 35.4 MB, far under Vercel's 250 MB.
- **Acceptance:** standard commands pass (web 263 tests; lib/domain coverage 99.5% statements,
  97.2% branches); e2e 9/9. `pnpm db:seed` with main's pinyin then `repinyin` with H1's: 3 of the
  17 synthetic phrases changed; a second run: 0.
- **CI flake fixed outside H1:** `agent/tools/src/install.test.ts`'s second `describe` (the
  agent binding) had the default 5 s timeout; one of its installer tests took 3.9 s on main and
  timed out once the heavier web suite ran alongside it in CI. It now uses `{ timeout: 20_000 }`,
  like the file's first `describe` (whitespace-only reindent otherwise).
- **For H4:** load the dictionary before any `pinyin(…, { multiple: true })` call, which means
  importing `web/lib/domain/pinyin.ts` (it calls `addDict` at module load). If the merge has to
  run in `shared/` or the worker, move the data file and the `addDict` call there.

## H2 — Frames retired; new-card policy *(depends on: docs)*

**Goal:** no frames, and new cards learned while fresh: no budget, no expiry, freshest first, a
daily new-card setting Will chose from an estimate.

**Read:** PRD §5.1–§5.3; DESIGN §4.3, §4.4, §4.6, §4.7, §5.5.5, §10 #77, #79.

H2 has two steps, possibly two sessions.

**H2a — Estimate (stops and reports; no PR needed unless the script is kept).**
- Simulate the review load with the real scheduler (`config.fsrs`, ts-fsrs) for a backlog of
  new phrases: the current queue size (from the Stats page, counts only; no `make prod-copy`
  without Will's OK) plus an allowance for H7's backfill. Assume recall at
  `desiredRetention`.
- For a few settings (for example 5, 10, 15, 20 new cards a day, and no limit), report: daily
  reviews during the burst (mean and peak), how many days the burst lasts, and daily reviews at
  steady state (Will's recent rate of new phrases per week, counts only).
- Propose one setting, with rounds per day it implies. **Stop and report.** Will chooses; the
  orchestrator passes the choice to H2b as an input.

**H2b — Implementation.** *Input: Will's new-card setting.*
- **Frames retired**: an expand-safe data migration sets every `kind = 'frame'` phrase to
  `dropped` (rows kept, cards out of scheduling, `review_log` untouched) and logs
  `phrase_retired {phrase_id, reason: 'frame'}`. The engine drops frame items from extraction
  results (counted `dropped_frame`); `kindWeight.frame` goes. The `kind` enum keeps `frame`
  (contract later).
- **No budget, no expiry**: the daily cron stops expiring (`sunk` and `over budget`, DESIGN
  §4.7); `config.queue.expireBelow`, `minAgeDays`, `budgetDays`, `budgetMinAgeDays` go. Existing
  `expired` rows stay restorable. Not useful and Already know are unchanged.
- **Freshest first**: queue order = pinned (newest pin first), then most recently asked
  (`last_asked_at` desc), then `effective_score` as the tie-break.
- **Daily limit**: `config.session.newPerDay` set to Will's choice (or removed); Learn more
  (DESIGN §4.4) stays only if a limit remains.
- Update PRD §3, §5.1–§5.3 and DESIGN §4.4, §4.6, §4.7, §6.

**Acceptance:**
- the standard commands; `pnpm db:migrate` on a fresh DB and on a seeded one;
- tests: queue order (pins, freshness, tie-break); frames retired with cards and `review_log`
  kept; the daily cron expires nothing; frame items dropped and counted;
- seeded shots per `.claude/skills/verify`: `pnpm --filter web shot / /queue /phrases`.

**Notes:**
- *Open question:* the H2a estimate needs a backfill allowance before H7's dry run has counted
  it; use v3's items per turn as the guess unless Will gives another.
- *Resolved (orchestrator default; Will may override):* `effective_score` stays as the tie-break after freshness.
- *H2a (estimate, no PR):* the real scheduler (`reviewCard`, ts-fsrs 6.0.0, FSRS-7,
  `config.fsrs`) over a backlog of new phrases. Assumptions: about 400 unseen (147 turns × v3's
  ~3 items, less those already introduced), 11 new a day (recent turns × 3 items), 15 s a card,
  every showing recalled at 0.85, one session a day; Not useful and Already know ignored
  (pessimistic). Counts only.

  | newPerDay | burst (days) | burst peak/day | steady/day |
  |---|---|---|---|
  | 5 | never drains | 74 | — |
  | 10 | never drains | 131 | — |
  | 15 | 100 | 116 | 114 |
  | 20 | 45 | 128 | 114 |
  | 30 | 22 | 124 | 115 |
  | no limit | 1 | 1,056 | 114 |

  Above intake the limit sets only how long the burst lasts; the steady load comes from intake
  (about 10 cards a day per daily new phrase).
- *H2b, Will's input:* `newPerDay` = 30 (about a 22-day burst, then about 115 cards, ~29 min, a
  day). A limit remains, so **Learn more** stays (still 3, `extraNewBatch`).
- *H2b, built:* migration `0006_retire_frames` (custom SQL, data only: frames not already
  `dropped` → `dropped`, unpinned, `dropped_at` set; one `phrase_retired {phrase_id, reason:
  'frame', status_before}` each; cards and `review_log` untouched; idempotent). The engine drops
  frame items first (`dropped_frame` on the `extraction` event; a frame doesn't use a cap slot).
  `kindWeight.frame` is gone (a frame scores 0 for kind); `config.queue` and `expiredPhraseIds`
  are gone, and the cron's answer no longer has `phrases_expired`. `orderQueue`: pins (newest
  first), `last_asked_at` desc, `effective_score` desc, newest.
- *H2b, deviations:*
  - the phrase editor no longer offers *frame* for a phrase (an old frame still shows its kind);
    Up next's blurb no longer says phrases expire;
  - `BAMBOO_TEST_NEW_PER_DAY` (`testNewPerDay` in `web/lib/config.ts`, ignored in production
    builds): both e2e servers set it to 5, since the e2e tests and seed use up the daily cap in
    a few cards. `repo.test.ts` mocks the cap to 5 the same way `session.test.ts` mocks 3;
  - the seed's two queued/active frames are now retired (`dropped`); the learning-today one is a
    sentence (能不能帮我拿一下？), and a new queued sentence keeps six phrases waiting;
  - a retired frame can still be restored by hand from Phrases (as any dropped phrase), and a
    term whose key equals a retired frame's slot-less key would revive it; neither is guarded.
- *For Will:* the steady state is about 115 cards (~11–12 rounds, ~29 min) a day at the current
  capture rate, whatever the limit, against PRD §3's one-round daily goal; one round still meets
  the goal, so the burst only drains if he does several rounds a day.
- *For H7:* the queue no longer expires anything, so the backfill's phrases all wait in the
  queue; with freshest first, re-run phrases are dated to their turn (§4.6.1) and sort behind
  anything asked since.

## H3 — Card back: breakdowns and glosses *(depends on: docs; ∥ H1)*

**Goal:** a richer card back: a character breakdown for terms, a word-by-word gloss and one note
for sentences.

**Read:** PRD §5.1; DESIGN §2.1, §6, §5.5.4, §10 #78; `.claude/skills/verify/SKILL.md`.

**Scope:**
- **Schema (expand only)**: a nullable `phrase.breakdown` json column. Terms: `{parts: [{hanzi,
  gloss}] (one per character), meaning}`; sentences: `{parts: [{hanzi, gloss}] (one per word),
  note}`. No pinyin stored in it: each part's pinyin is sliced from the phrase's displayed
  pinyin (merged, overrides applied), so it always matches.
- **Contract** in `shared/src/contracts/`: `PhraseBreakdown`, and an optional `breakdown` on
  extraction items (H4 fills it).
- **Validation** (pure, `web/lib/domain/`): the parts' hanzi, concatenated, must equal the
  phrase's hanzi (punctuation ignored); otherwise the breakdown is dropped and flagged
  `breakdown_dropped`. Glosses and notes are English only (no CJK), as `note` is today.
- **UI**: the back shows the breakdown under the hanzi (each part with its pinyin and gloss, then
  the meaning or note) and the example sentence(s) with pinyin and English. Without a breakdown
  it looks as today.
- Seed synthetic breakdowns for a term and a sentence in `pnpm db:seed` / `dev:seeded`.

**Acceptance:**
- the standard commands; `pnpm db:generate` produces one migration that only adds;
  `pnpm db:migrate` on fresh and seeded DBs;
- tests: the exact-match rule (match, mismatch, punctuation), English-only glosses, pinyin
  slicing with an override;
- seeded shots, light and dark: `pnpm --filter web shot /review/back` for a term and a sentence
  with breakdowns and one without; no console or request errors.

**Notes:**
- Migration `0004_phrase_breakdown.sql`: one `ALTER TABLE phrase ADD breakdown text` (expand only).
- Contract `shared/src/contracts/breakdown.ts`: `PhraseBreakdown` = `TermBreakdown {parts,
  meaning}` | `SentenceBreakdown {parts, note}`; limits in `sharedConfig.extraction`
  (`maxBreakdownParts` 40, `maxGlossChars` 60, `maxBreakdownSummaryChars` 160). `ExtractItem`
  has an optional `breakdown`; `ModelExtractTurnResult` (the Ollama schema) omits it, so the
  worker's current prompt and grammar are unchanged. **H4:** add it to the v4 output schema.
- Checks beyond the exact-match rule: every part must contain Chinese, the shape must fit the kind
  (frames get none), and the whole breakdown is dropped (not just one gloss) when anything fails.
  The exact match is on `hanziKey`, so ASCII letters and digits count as characters too.
- "English only" means a note on how a sentence is built can't quote the characters it explains
  (e.g. "Verb + 'finish'…"). **H4's prompt** should say so.
- Merges (asked again, re-extraction) fill in a breakdown only when the phrase has none. Editing a
  phrase re-runs the check against the new hanzi and kind.
- With a breakdown, a term's back shows all its examples (≤ 3), not just the first: Will asked for
  "example sentence(s)". Without one, the back is unchanged.
- `pnpm --filter web shot` gained `/review/back/<hanzi>` (the round's order varies, so a position
  isn't stable); the seeded term with a breakdown is `辅食` (泡打粉 isn't always in the round).

## H4 — Worker on Gemini *(depends on: H1, H3)*

**Goal:** the worker extracts each turn with Gemini (`extract_turn.v4`), within the free tier,
falling back to Ollama; names never reach a card; pinyin is merged with Gemini's.

**Read:** DESIGN §4.2, §4.6, §5.3, §5.5 (all), §7, §8.1, §10 #74–#83; CLAUDE.md › *Privacy*.

*Input from Will: the free-tier key in `openclaw-agent`'s `~/.config/bamboo/agent.env` (and
`names.deny` filled in by him; the session never reads it).*

**Scope:**
- **`worker/prompts/extract_turn.v4.md`**: terms and sentences (no frames), English, note,
  `heard_as`, examples copied verbatim (more than one allowed), usefulness, tags, Gemini's
  pinyin per item, and the breakdown/gloss of H3. The prompt says: never a person's name in a
  card (use 宝宝, 孩子, 阿姨, 月嫂 or 妈妈), and no personal health specifics (diagnoses, doses,
  measurements); ordinary words like 胀气 are fine. Copy hanzi exactly.
- **Gemini client**: the key from `agent.env` (`BAMBOO_GEMINI_API_KEY`, `BAMBOO_`-prefixed per
  DESIGN §10 #42; Will renames the existing entry in `agent.env` to this name); model and limits in `sharedConfig.worker.gemini`; JSON output
  with a schema; one turn per request; the request carries only the prompt and the turn (the
  whole stored turn; the 6,000-character cut stays for Ollama).
- **Rate limiter** for the free tier (requests per minute and per day, from Google's current
  docs, recorded in Notes); 429 backs off.
- **Ollama fallback**: when Gemini is unreachable or keeps failing, the job runs on Ollama with
  the same contract and the same `extract_turn.v4` prompt (a used-up free quota waits for the
  reset instead); `job.model` says which ran. Fallback items carry no Gemini pinyin.
- **Name filter** (Mac side, in the worker, before posting): any item, example, note or gloss
  containing a name from `~/.config/bamboo/names.deny` is dropped (or, for English fields,
  rewritten); only a count goes to the result and the log (`dropped_name`). Tests use a synthetic
  deny file with placeholder names.
- **Pinyin (b)** (engine, pure, `web/lib/domain/`): the per-syllable merge of DESIGN §5.5.3, a
  `pinyin` job type the worker runs (Gemini's reading for a hand-added or edited phrase, then the
  referee: one small call per phrase choosing among that character's valid readings plus the
  neutral tone), `phrase.pinyin_sources` (which source won for each disputed syllable),
  `pinyin_disagreement` events, and the counts on Stats. Prompts are versioned files.
- **Caps**: loosen `config.extraction` per-turn caps, with the evidence (the comparison with
  Gemini-made decks, counts only) in Notes.
- Heartbeat reports the Gemini model and `gemini_ok`; `make worker-logs` shows it.

**Acceptance:**
- the standard commands; `pnpm db:migrate` on fresh and seeded DBs;
- `pnpm --filter @bamboo/worker test` with a fake Gemini: rate limiter, 429 backoff, fallback to
  a fake Ollama, the name filter on the synthetic deny file, no turn text or key in logs;
- engine tests: the merge's four rules, the referee result limited to valid readings, hand-added
  phrase → pinyin job, events and Stats counts;
- opt-in live eval on the Mac as `openclaw-agent`, synthetic turns only
  (`BAMBOO_EVAL_GEMINI=1 pnpm --filter @bamboo/worker test:gemini`, added here): contract-valid,
  verbatim rate ≥ 0.8;
- after merge and `make mac-update`: `make worker-logs` shows a heartbeat with `gemini_ok`.

**Notes:**
- *Resolved (orchestrator default; Will may override):* when the free quota runs out, the worker waits for the reset (no fallback for
  quota).
- *Resolved (orchestrator default; Will may override):* the Ollama fallback uses `extract_turn.v4`.
- Migration `0005_pinyin_merge.sql` (expand only): `phrase.pinyin_sources` (json, nullable) and a
  new `pinyin_job` table. **Deviation:** pinyin jobs have their own table rather than a `type` in
  `job`, because `job.import_id` is required and a hand-added phrase has no import (DESIGN §2.3,
  §10 #84). H2b rebases onto this.
- **Free-tier limits (deviation: no published numbers).** On 2026-11-19 Google's rate-limit page
  (ai.google.dev, now redirecting to aistudio.google.com/docs/rate-limits) lists no free-tier
  RPM/RPD; it points to the per-project table at aistudio.google.com/rate-limit. It does say RPD
  resets at midnight Pacific and that limits are per project. Developer-forum reports put the
  free tier at about 20 requests/day for the newest Flash. Defaults: model `gemini-3.8-flash`
  (the Stable Flash on the models page), **5/min, 20/day**, overridable with `GEMINI_MODEL`,
  `GEMINI_RPM`, `GEMINI_RPD` in worker.env; Google's 429 is the backstop (DESIGN §10 #86).
  *Confirmed 2026-11-19:* Will read his project's free-tier limits in AI Studio: 5/min and
  20/day for `gemini-3.8-flash`, so the defaults are the real limits. At 20/day H7's backfill
  would take more than a week, so it runs on a paid key (H7, DESIGN §10 #88).
- **Caps (deviation: evidence not available here).** The Gemini-deck comparison's counts aren't
  in the repo and this session had no prod access, so the new caps are a judgment: errand 1 → 3
  items, say 2 → 5 terms, `ExtractTurnResult.items` 8 → 12, examples per term up to 3. H7's dry
  run (10 turns) should report items per turn and `dropped_over_cap` so they can be tuned.
- The API's request: `generateContent` (`responseMimeType` + `responseJsonSchema`, key in the
  `x-goog-api-key` header). Google's structured-output page now shows the newer Interactions API
  instead; generateContent is assumed still served, which the post-merge `test:gemini` confirms.
- Claim body `{types}` (DESIGN §3.2): without it only extract_turn jobs are offered, so the old
  worker keeps working between the Vercel deploy and `make mac-update`.
- A daily-quota 429 in the middle of a job reports it `failed` (one attempt), then the worker
  claims nothing until midnight Pacific. Other Gemini failures (2 network/5xx tries, any other
  4xx, invalid output after the repair turn) send that job to Ollama; a model failure also rests
  Gemini 10 min (no pinyin jobs meanwhile).
- Name filter: an item or example whose Chinese has a name is dropped; English fields are
  rewritten to `someone` (not a role word: the list doesn't say who a name is, DESIGN §10 #87);
  `heard_as` is cleared. A missing deny file is a startup warning, not an error.
- Pinyin merge (DESIGN §5.5.3 *Built*, §10 #85): rule 2 is literal (Gemini's neutral tone counts
  only if pinyin-pro lists it); 一/不's citation tones agree with the sandhi. Only new phrases
  are merged; phrases an extraction merges into keep their pinyin (H6 refreshes them). A
  promoted sentence gets a pinyin job (Gemini read the term, not the sentence).
- **For H2b:** v4's schema has no frames, but the engine doesn't drop frame items yet
  (`dropped_frame` is H2b's). `kindWeight.frame` untouched.
- **For H6:** `mergedPinyin` / `pinyinFollowUps` (`web/lib/repo/pinyin.ts`) are what a re-run
  should call for every phrase it picks; `storedPinyin` keeps referee choices.
- Acceptance (local): shared 43, db 26, worker 68 (+2 opt-in evals skipped), web 287 (coverage
  gate passed), agent/tools 117; lint, typecheck, `pnpm --filter web build`; `pnpm db:migrate` on a
  fresh DB and on a DB seeded at 0004 then migrated (17 phrases, `repinyin` 0 changed); e2e 9/9;
  `shot /stats` light and dark, no console or request errors. The live `test:gemini` and the
  heartbeat check are post-merge (orchestrator).

## H5 — Tutor capture *(depends on: H4)*

**Goal:** Will asks the `#bamboo` agent directly; every question and its answer become a Bamboo
turn, with no share link.

**Read:** PRD §5.3; DESIGN §5.1, §5.5.1, §5.5.7, §5.5.8, §8.3, §10 #69, #73, #75, #82.

**Scope (Bamboo):**
- The skill and `agent/workspace/` files: the agent answers Will's Mandarin questions as a tutor
  (a versioned tutor prompt with the privacy rules: no names, no health specifics), then hands
  the question and answer to `bamboo-tools` by file path; share links, PDFs and pasted answers
  still import as today.
- A `bamboo-tools` command and an agent-token endpoint in the engine that stores one turn (and
  its extract job), idempotent on the Discord message id; the turn then goes through H4's path.
- `make agent-check` learns what the new agent setup should look like.

**Scope (host; documented here and for PandaDen's runbook, run by the orchestrator via
`ssh agent` only after Will approves):** the `bamboo` agent's model becomes Gemini Flash; the
free key becomes its auth profile and is pinned (DESIGN §5.5.7). Check with
`openclaw models status --agent bamboo --probe` and one real request.

**Acceptance:**
- the standard commands; tests for the command and the endpoint (synthetic text; idempotency;
  agent token required);
- on the Mac after the host change: `make agent-check` passes; `openclaw models status --agent
  bamboo --probe` shows `google:bamboo-free` serving; one real question in `#bamboo` gets an
  answer and its turn shows on Imports (counts only).

**Notes:**
- *Open question:* how does the agent tell a pasted Gemini answer (imported as text today) from a
  question that contains Chinese?
- *Resolved (orchestrator default; Will may override):* a captured tutor turn gets no extra Discord summary reply.
- *Resolved (orchestrator default; Will may override):* if the endpoint needs a migration (a new `import.kind`/`origin` value, say), H5
  joins the serial migration chain.
- *Still open, for the H5 session to propose:* pasted answer vs question (above).
- **Proposed rule (for the orchestrator to review): pasted answer vs question** (DESIGN §5.1,
  §10 #90). Code decides, not the model: every text message goes to `bamboo-tools ask`, which
  runs `routeText` (`shared/src/paste.ts`). (1) A message starting `paste:`/`pasted:`/`📋` is a
  pasted answer, `ask:` a question (marker dropped). (2) Otherwise a pasted answer only if it has
  Chinese, ≥ 300 characters and ≥ 4 non-blank lines (`sharedConfig.tools.paste`). (3) Everything
  else is a question, including a short message quoting Chinese to decode. Either mistake still
  reaches Bamboo. A message with no question in it (thanks, ok) gets a few words and no command;
  the old help line ("Send me a Gemini share link…") is gone, since any text is now a question.
- **No migration.** `import.kind` gains `tutor`, but the column is SQLite text and the enum is
  TypeScript-only; `pnpm db:generate` reports no changes. H5 adds nothing to the serial
  migration chain, so H6 doesn't need to rebase onto a migration of H5's.
- `POST /api/turns` (agent token, `TutorTurnRequest`) stores a `tutor` import with one turn and
  its extract job, through `receiveImport`; `source_ref` is the tutor prompt version, no title.
  Its idempotency key is `tutor:<message id>`, apart from the imports' `discord:<message id>`, so
  the same message can't be both. Tutor turns key on question and answer, like text imports
  (DESIGN §4.5). The import is marked notified at creation, so `replies` never posts for it.
- The tutor prompt is `worker/prompts/tutor.v1.md` (`sharedConfig.tools.tutorPrompt`), in the
  agent's `AGENTS.md` between the header and the skill's instructions (its leading note
  stripped); `make agent-check` warns when its lines are missing, and when the serving agent's
  model isn't `google/gemini-…flash…`. The check doesn't read the auth order (OpenClaw's
  `models auth order get` output isn't documented); the runbook's `models status --probe` does.
- **Deviation (host): two Google profiles, not one.** Will's free tier is 5/min and 20/day for
  `gemini-3.8-flash`, shared with the worker. OpenClaw rotates to the next profile in the auth
  order on a rate limit, but its docs don't say an env key (`GEMINI_API_KEY` in
  `~/.openclaw/.env`) is tried once an order is pinned. So the runbook adds the paid key as a
  second profile, `google:bamboo-paid`, and the order is `google:bamboo-free google:bamboo-paid`:
  the tutor falls back to the paid key instead of failing, and the worker waits for the reset
  (DESIGN §5.5.7, §10 #91). Will pastes both keys during `paste-token`. No model fallback
  (`model` is a plain string): Ollama stays the worker's only.
- Bamboo's channel `systemPrompt` and the `bamboo` workspace files (`AGENTS.header.md`,
  `SOUL.md`, `IDENTITY.md`, `USER.md`) now describe a tutor plus intake clerk; `make mac-update`
  rewrites them on the dedicated agent.
- Seed data gains one synthetic tutor import, so Imports shows "Asked in #bamboo" (and the
  seeded Re-run offers 5 older questions, not 4).
- Acceptance (local): shared 50, db 27, worker 68 (+2 opt-in skipped), web 290 (coverage gate
  passed), agent/tools 128; lint, typecheck, `pnpm --filter web build`; `pnpm db:generate` no
  changes; shellcheck on `agent/*.sh`; e2e 9/9 (the seeded Re-run spec now counts 5 older
  questions, with the new tutor import); `shot /imports` light and dark, no console or request
  errors. The Mac checks (`make agent-check`, `models status --probe`, a real question in
  `#bamboo` showing on Imports) are post-merge, after the host change (orchestrator).

## H6 — Re-run extension *(depends on: H3, H4)*

**Goal:** a re-run with v4 refreshes every phrase it picks and reports the ones it no longer
picks, so the queue can be rebuilt from stored turns without losing history.

**Read:** PRD §5.3; DESIGN §4.6.1, §5.5.6, §6, §10 #65, #81.

**Scope:**
- A re-run refreshes `english`, `note`, `breakdown` and pinyin (through H4's merge; overrides
  kept) on every phrase it picks, **in any status**, leaving the hanzi, the cards and their FSRS state alone (a dropped phrase stays
  dropped).
- Phrases that are active, pinned or asked about more than once and that the re-run no longer
  picks are **reported** (marked, not changed): a Phrases filter lists them, with a bulk
  **Retire** that drops them and keeps `review_log`.
- A re-run can be limited to N turns (for H7's dry run), and can re-run turns already on the
  newest prompt (H7 runs all 147).
- Plain queued phrases first made from a re-run turn that it no longer picks are **dropped**
  (not expired, as superseding does today).
- Re-runs go one turn per request, through H4's rate limiter.

**Acceptance:**
- the standard commands; `pnpm db:migrate` on fresh and seeded DBs;
- tests (`planReextract`): refresh in each status, hanzi/cards/FSRS untouched, reported phrases,
  bulk retire keeps `review_log`, the limit;
- seeded shots: `pnpm --filter web shot /phrases /imports` with the filter on.

**Notes:**
- *Resolved (orchestrator default; Will may override):* the re-run refreshes pinyin through H4's merge and keeps Will's overrides.
- *Resolved (orchestrator default; Will may override):* plain queued phrases it no longer picks are **dropped**, not expired (a change
  from today's superseding, DESIGN §4.6.1).
- *Built (H6, DESIGN §10 #92):* `planReextract` returns `create`, `merges` (each with Gemini's
  reading for the merge), `dropped` and `reported`; migration `0007_phrase_unpicked` adds a
  nullable `phrase.unpicked_at` (expand-only). The report covers only phrases whose
  `source_turn_id` is the re-run turn (as superseding did). A breakdown is taken only if it fits
  the phrase's own hanzi and kind; a missing one keeps the old. An item without a reading (Ollama,
  a promoted sentence) leaves the pinyin as it is. Restore clears `unpicked_at`.
- *Decided here (no doc settled it):* the N-turn limit and "already on the newest prompt" go
  through a new agent route, `POST /api/agent/reextract {all?, limit?}` → `{queued, open}`, not
  the Imports button (which keeps re-running stale turns only). `all` skips turns whose latest
  finished job is a re-run on the newest prompt, so H7's full run after its dry run doesn't redo
  those 10, and calling it twice queues nothing. Oldest turns first.
- *For H7:* the re-run's `extraction` event carries `phrases_created/refreshed/dropped/reported`
  per turn; `phrase_unpicked` and `phrase_superseded` (`to: "dropped"`) events name the phrases.
  Re-runs are still claimed after ordinary and pinyin jobs and look like any job to the worker:
  `POST /api/jobs/claim` doesn't say a job is a re-run, so a paid-key backfill worker that must
  take only re-runs needs a claim option or an input flag (H7's call). Turns whose every job
  failed aren't picked by any re-run; use Retry failed first. `limit` is capped at 1000.
- *Seed:* two learning sentences carry `unpicked_at`, so `/phrases?unpicked=1` and the Imports
  link show in seeded shots; the seeded e2e retires them.

## H7 — Backfill *(depends on: H2b, H5, H6)*

**Goal:** all 147 stored turns read by v4, with learning cards and review history intact.

**Read:** DESIGN §5.5.6, §5.5.7, §8.1, §8.6, §10 #81, #82, #88; H4 and H6 Notes.

*Input from Will: `BAMBOO_GEMINI_API_KEY_PAID` in `openclaw-agent`'s
`~/.config/bamboo/agent.env` (done; the session never reads or prints it).*

**Scope:**
0. **Paid key for the backfill run:** the two-key support is already built (see Notes); the
   backfill run starts the worker with `--gemini-key=paid` (DESIGN §5.5.7), e.g. stop the
   launchd worker, run `pnpm --filter @bamboo/worker start -- --gemini-key=paid` as
   `openclaw-agent`, then restart the launchd worker (which keeps the free key). Confirm the paid
   tier's limits in AI Studio and set `GEMINI_PAID_RPM` / `GEMINI_PAID_RPD` (or the defaults in
   `sharedConfig.worker.gemini.paid`) to match, recorded in Notes.
1. **Dry run**: re-run 10 turns on the paid key. Report counts only: items kept and dropped (by reason), phrases
   new, refreshed and reported, pinyin disagreements and referee calls, Gemini requests, minutes,
   and how many stored turns have `reply_text` at exactly the 12,000-character cap.
   **Stop.**
2. **Full run**, after Will approves: the remaining turns, on the paid key at its limits. Report the same
   counts, plus reviewed cards and `review_log` rows before and after.
3. Will decides, from the counts: whether to re-import the one turn cut at 12,000 characters, and
   whether to bulk-retire the reported leftovers.

**Acceptance:**
- the standard commands (the two-key tests landed in PR #48);
- the dry and full runs log `gemini: using the paid key (BAMBOO_GEMINI_API_KEY_PAID)`, and the
  launchd worker logs the free key after it restarts;
- every stored turn has a finished `extract_turn.v4` job;
- `review_log` rows and reviewed cards are the same before and after (counts);
- Stats renders; `pnpm smoke https://bamboo-panda.vercel.app` passes.

**Notes:**
- *Resolved (orchestrator default; Will may override):* H7 also waits for H2b, so backfilled phrases arrive with frames gone and
  freshest-first ordering in place.
- *Decided by Will (2026-11-19):* the backfill runs on a paid key; everyday work stays on the
  free key. **No Batch API:** it is 50% cheaper, but the backfill is about 147 turns (a dollar
  or two), and Batch would need a new submit/collect flow, a second pass for referee calls and
  up to 24 h turnaround (DESIGN §10 #88). The two-key support is built here, not in its own
  milestone.
- *Two keys done early in PR #48* (2026-11-19), because Will had already renamed the key in
  `agent.env` and the live worker was on Ollama only. The worker reads `BAMBOO_GEMINI_API_KEY_FREE`
  and `BAMBOO_GEMINI_API_KEY_PAID` from `agent.env` (the process env wins), still accepts
  `BAMBOO_GEMINI_API_KEY` as the free key's deprecated alias (a later PR drops it), and logs each
  key's variable, never its value. **Selection hook:** `--gemini-key=paid` on the worker's command
  line (`worker/src/config.ts` › `geminiKeyChoice`, `selectGeminiKey`) uses the paid key with
  `sharedConfig.worker.gemini.paid` (60/min, 2,000/day by default; `GEMINI_PAID_RPM`,
  `GEMINI_PAID_RPD`); without the paid key that run exits 78 at startup. Tested with fake keys
  (`worker/src/config.test.ts`). No migration.
- *Still open:* the turn cut at 12,000 characters. The dry run reports how many stored turns have
  `reply_text` at exactly the cap (counts only), and Will decides then.
