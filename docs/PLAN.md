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
| M0 Share-link spike | todo | |
| M1 Skeleton, auth, deploy | todo | |
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
4. Check against his PDF export, if he has one in `private/`: compare turn counts, and confirm
   the user prompts match closely enough for turn keys (§4.5) to agree across formats.
5. Write the findings into DESIGN §5.2: method, selectors or data path, wait strategy, known
   fragility, timing. Make the synthetic fixture from the real structure, with all text replaced.

**Acceptance:** `node spikes/share-link/read.mjs <link>` on the Mac prints the title, turn count,
and the first 3 user prompts truncated to 40 chars. The PR contains only counts and synthetic
content. DESIGN §5.2 states one of: **link works** (method), or **PDF only** (why). If PDF only,
update PRD §5.3 and the M5 scope in this file.

**Out of scope:** integrating into `bamboo-tools` (M5).

**Notes:**

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
- `agent/tools/src/share.ts` (from M0's findings);
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
