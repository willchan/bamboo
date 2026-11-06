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
| M0 Share-link spike | in review | [#3](https://github.com/willchan/bamboo/pull/3) |
| M1 Skeleton, auth, deploy | merged | [#2](https://github.com/willchan/bamboo/pull/2) |
| M2 Phrases, rounds & review | todo | |
| M3 Capture: engine | todo | |
| M4 Worker | todo | |
| M5 Discord intake | todo | |
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
- the Imports page, with the paste box and Retry failed.

**Tests:** route integration tests on in-memory libSQL:
- `known` → `imports` with chunking and idempotency;
- turns deduped by `turn_key` across two imports, so the second import creates only new jobs;
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

---

## M5 — Discord intake *(parallel with M4)*

**Goal:** Will shares a Gemini conversation to `#bamboo` and gets a reply with what was queued.

**Read:** PRD §5.3; DESIGN §4.1, §4.5, §5.1, §5.2, §8.3 (*Agent*), §8.4, Appendix A; M0 and M3
Notes. Also PandaBase's `agent/skills/discord-intake/SKILL.md` and DESIGN §6 (skill format,
command automations, `make install-agent-*`).

**Owns:**
- `/agent/tools` (`bamboo-tools`): `import --url | --file | --text-file`, `segment` (dry run),
  `replies`, and `nudge` (the CLI side only; the engine route is M6);
- `agent/tools/src/share.ts` (from M0's findings; omit if M0 found links unreadable);
- the **PDF path is required** whatever M0 found: `--file`, `pdftotext`, segmentation;
- `shared/src/segment.ts` and the synthetic PDF-text fixture;
- `agent/skills/bamboo/SKILL.md` and `agent/bamboo.config.example.json`;
- the Makefile target `agent-install` (PATH, config, extraDirs with a backup, command
  automations).

**Tests:**
- segmentation of the synthetic PDF text (exact expected turns, radicals normalized, boilerplate
  and duplicates removed);
- share parsing of the synthetic page fixture;
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
- share the PDF of the same conversation → also nothing new (turn keys agree across formats).

Report counts only in the PR.

**Out of scope:** the reminder decision logic and stats (M6).

**Notes:**

---

## M6 — Reminder & stats

**Goal:** one well-timed evening reminder when a round is waiting, and a Stats page showing
whether this is working.

**Read:** PRD §5.4, §6; DESIGN §4.9, §6 (Stats), §7; M5 Notes.

**Owns:** `web/lib/domain/nudge.ts`; `GET /api/agent/nudge`; the reminder toggle on Today; the
`/stats` page and its queries.

**Tests:** the nudge decision (sent at most once a day; suppressed after a finished round or when
there's nothing to do; the default 21:00 until 5 rounds exist; the median-minus-15 rule; the
clamp; the 04:00 day boundary); stats queries on fixture data.

**Acceptance:** the standard commands. Manual: a reminder arrives in `#bamboo` in the evening,
and doesn't arrive on a day when a round is already done.

**Notes:**
