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

## Dependency graph

```
M1 ─▶ M2 ─┬─▶ M3 (starter decks)
          ├─▶ M4 (import: engine) ─▶ M5 (worker) ─▶ M6 (iOS Shortcut)
          └─▶ M7 (nudge + stats)
```

M3, M4 and M7 can run in parallel once M2 is merged. **Target: M1–M3 merged by the end of
November** (the in-laws arrive in December).

## Status

| Milestone | Status | PR |
|---|---|---|
| M1 Skeleton, auth, deploy | todo | |
| M2 Phrases & review (first usable) | todo | |
| M3 Starter decks | todo | |
| M4 Import pipeline: engine | todo | |
| M5 Worker on the Mac | todo | |
| M6 iOS Shortcut capture | todo | |
| M7 Daily nudge & stats | todo | |

---

## M1 — Skeleton, auth, deploy

**Goal:** a deployed, signed-in, empty app with green CI that every later milestone builds on.

**Read:** DESIGN §1, §3.1, §8, §9, §10. PandaBase's PLAN M1 *Notes* are a good reference for
version pinning and tooling choices (`github.com/willchan/pandabase`, `docs/PLAN.md`).

**Owns:** root `package.json` (pnpm workspace, `packageManager` pinned, Node 24 `engines`),
`pnpm-workspace.yaml`, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`), ESLint and
Prettier config, `.gitignore` (`.env*`, `*.db`, `private/`, `.next`), `.nvmrc`, `Makefile`
(stubs), `.env.example` (every variable in DESIGN §8.1), `/web` (Next.js latest stable, App
Router, Tailwind, Auth.js v5 Google with `ALLOWED_EMAILS` and `DEV_AUTH_BYPASS`, a signed-in
placeholder Today page, PWA manifest and icons), `/db` (Drizzle + libSQL, a `setting` table only,
migrate scripts), `/shared` (empty package, one test), `/worker` (empty package, one test),
`.github/workflows/ci.yml`, `README.md`.

**CI:** `pnpm install --frozen-lockfile` → lint → typecheck → test → `pnpm --filter web build`.

**Acceptance:**
```
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build
pnpm db:migrate        # against file:db/dev.db
DEV_AUTH_BYPASS=1 pnpm dev   # placeholder Today page renders signed in
```
Manual, listed in the PR for Will: create the Google OAuth client, the Turso DBs (`bamboo`,
`bamboo-preview`) and the Vercel project; set the env vars. The production URL then signs Will in
and refuses any other account. "Add to Home Screen" on the iPhone opens it standalone.

**Out of scope:** any domain tables, R2, worker logic.

**Notes:**

---

## M2 — Phrases & review *(first usable)*

**Goal:** Will can add phrases (or load a JSON file of them) and do a daily 5-minute spoken review
on his phone, with correct romanization and audio. **After this milestone Bamboo is useful.**

**Read:** PRD §3, §5.1, §5.2; DESIGN §2.1, §4.1–4.4, §4.8, §6 (Today, Review, Phrases, Audio),
§7 (`review`, `session_finished` events only).

**Owns:** `phrase`, `card`, `review_log` and `event` tables and their migration;
`shared/src/text.ts`; `web/lib/domain/{romanize,session,fsrs}.ts`; `web/lib/config.ts`;
`web/lib/audio.ts`; pages Today, Review, Phrases (list/add/edit, romanization override,
Used it ✓, suspend); `db` script `pnpm db:import-phrases <file.json>` (validates with a Zod
`PhraseSeed` schema in `shared`, upserts by `(lang, hanzi_key)`, creates cards per §4.8,
`source: 'seed'`, works against `TURSO_*` for prod).

**Tests:** unit tests for normalization (the radical table, `hanziKey`), romanization (including
polyphones 得/行/长 in context, 一/不 sandhi, and Jyutping for a few Cantonese words), and the
session builder (new cap, sibling burying, ordering, day boundary at 04:00 local, Used it ✓ rules,
asked-again rule). Coverage ≥ 90% on `web/lib/domain`. One Playwright e2e test at a phone
viewport: add a phrase → Start → reveal → Good → Done.

**Acceptance:**
```
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build
pnpm --filter web test:e2e
pnpm db:import-phrases seeds/example.json   # small synthetic file committed with this milestone
```
Manual on the iPhone (list it in the PR): the Mandarin voice and the Cantonese voice both speak;
a session stops at 5 minutes or 20 cards; ruby romanization is readable at phone width.

**Out of scope:** inbox, imports, push, stats.

**Notes:**

---

## M3 — Starter decks

**Goal:** real content to study before the import pipeline exists: a Cantonese holiday deck for
December, and Will's own Mandarin backlog.

**Read:** PRD §5.4; DESIGN §2.1, §8.4; M2 Notes (the `PhraseSeed` format).

**Owns:** `seeds/yue-holiday.json` (committed); `private/cmn-backlog.json` (gitignored, never
committed); a `review_needed` tag convention.

**Build:**
1. **Cantonese holiday deck** (~40 phrases): written by the session (dev-time content, not a
   runtime LLM call), as **spoken Cantonese** in traditional characters:
   - greetings and goodbyes;
   - terms of address for in-laws, written with placeholders Will fills in (his wife knows the
     right 嫲嫲/婆婆/… terms);
   - mealtime (食飯啦, 好好食, 飽啦, 再食啲);
   - thanks and politeness (唔該 vs 多謝, with a note on the difference);
   - holiday wishes;
   - 8–10 small-talk lines about the kids and the twins;
   - 5 "I don't understand / please say it slowly" survival lines.

   Every phrase gets the `review_needed` tag, which is cleared once his wife has checked it.
   Load it with `pnpm db:import-phrases`.
2. **Mandarin backlog deck**, *only on the Mac, only if Will has put his export in `private/`*:
   - read the export (`pdftotext -layout`, then `normalizeText`);
   - choose ~40 items: decoded words, anything asked about twice or more, units and measures, core
     baby and feeding vocabulary, and 6–8 reusable frames (阿姨，您是说…吗？ / 我知道了 /
     …可以吗？ / X 的时候用 Y / 我们有…，在这里);
   - prefer short spoken forms, and copy hanzi from the export (don't invent);
   - write `private/cmn-backlog.json` and import it to prod.

   Nothing from the export goes into the repo, the PR, or the PR description beyond counts.

**Acceptance:** `pnpm db:import-phrases seeds/yue-holiday.json` succeeds on a fresh dev DB; every
Jyutping computes (no `null` for hanzi characters, or the override is set in the seed). Manual:
Will reviews both decks on his phone. Afterwards, `git status` shows nothing under `private/`.

**Out of scope:** code changes beyond small fixes to the seed importer.

**Notes:**

---

## M4 — Import pipeline: engine

**Goal:** everything on the Vercel side of capture: upload, jobs API, turns, candidates, ranking,
and the Inbox. The worker is faked in tests.

**Read:** PRD §5.3; DESIGN §2.2, §2.3 (`job`), §3, §4.5–4.8, §5, §6 (Inbox, Import), §7.

**Owns:** the `import`, `turn`, `candidate` and `job` tables; contracts in `shared/src/contracts/`
(`SegmentImportResult`, `ExtractTurnInput`, `ExtractTurnResult`, API bodies); routes
`/api/imports*`, `/api/jobs/{claim,complete}`, `/api/worker/heartbeat`, `/api/cron/daily` (with
`vercel.json` cron); R2 presigning; `web/lib/domain/candidates.ts`; the Inbox and Import pages; the
text-paste import.

**Tests:** route integration tests on in-memory libSQL:
- claim and lease, stale-attempt 409, lease expiry and requeue, 3-attempt failure;
- segment result → turns deduped by `turn_key` across two imports, so the second import creates
  only new jobs;
- extract result → verbatim drop, `heard_as` drop, merge into an existing phrase (asked_count
  goes up and an Again review is logged), merge into a pending candidate;
- scoring order; expiry by the cron;
- token scoping (the capture token cannot claim jobs).

The e2e test pastes text, completes the job with a canned `ExtractTurnResult` through the API,
then keeps an item in the Inbox and sees it in Phrases.

**Acceptance:**
```
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build && pnpm --filter web test:e2e
```
Manual: create the R2 bucket (lifecycle: `imports/` 30 days) and set the env vars; upload a PDF
from the iPhone's Import page and see an import `queued`.

**Out of scope:** the worker, the Shortcut.

**Notes:**

---

## M5 — Worker on the Mac

**Goal:** importing the real Gemini PDF on the phone produces a ranked Inbox within the hour,
fully on local models.

**Read:** DESIGN §1.2, §4.1, §5.2, §5.3, §8.3, §8.4, Appendix A; M4 Notes.

**Owns:** `/worker`:
- the claim loop (concurrency 1, SIGTERM finishes the current job);
- `segment.ts`;
- the Ollama client (`format` schema, one repair turn);
- `prompts/extract_turn.v1.md`;
- heartbeat and prerequisite checks;
- the synthetic fixture and expected output (Appendix A);
- `ops/launchd/com.bamboo.worker.plist`;
- the Makefile targets `worker-install`, `worker-update`, `worker-logs`.

**Tests:** segmentation against the synthetic fixture (exact expected turns); normalization of the
fixture's radicals; the claim loop against a fake API; the Ollama client against recorded fake
responses (valid, invalid → repaired, invalid twice → failed). A test that uses a real model is
opt-in only (`BAMBOO_EVAL_OLLAMA=1`) and is skipped in CI.

**Acceptance:**
```
pnpm lint && pnpm typecheck && pnpm test
make worker-install && make worker-logs     # on the Mac: heartbeat posted, Today shows worker online
```
Manual, on the Mac with Will's PDF in `private/`:
- run `pnpm --filter @bamboo/worker segment private/<file>.pdf` (a dry-run CLI that prints turn
  count and the first 5 user prompts), and check the count roughly matches the conversation;
- upload the same PDF from the phone → the import reaches `done`, and the Inbox shows a sensible
  top 10;
- re-upload it → `turns_new = 0`.

Report counts only in the PR: turns, items, drop rate, minutes.

**Out of scope:** share-link fetching (ROADMAP), extraction of images.

**Notes:**

---

## M6 — iOS Shortcut capture

**Goal:** from the Gemini app or Files, Share → "Bamboo import", without opening the PWA.

**Read:** DESIGN §3, §5.1; M4 Notes.

**Owns:** `docs/SHORTCUT.md` (step-by-step build of the Shortcut: get the file → `upload-url` with
`CAPTURE_API_TOKEN` → PUT → `POST /api/imports` → show "Imported, N new turns soon"); any small
route changes needed (for example, accepting `application/octet-stream`); a `curl` script
`scripts/capture-smoke.sh` that exercises the same calls.

**Acceptance:** `scripts/capture-smoke.sh` against a preview deployment returns an import id.
Manual: Will builds the Shortcut from the doc and imports a PDF from the share sheet.

**Notes:**

---

## M7 — Daily nudge & stats

**Goal:** one gentle push notification a day when there's something to do, and a Stats page showing
whether this is working.

**Read:** PRD §5.5, §6; DESIGN §6 (Push, Stats), §7.

**Owns:** `push_subscription` table; the service worker's push handler; the subscribe flow on
Today ("Remind me daily at …"); push sending in `/api/cron/daily`; the `/stats` page; the
`setting` for the push time.

**Tests:** cron sends only when something is due or new, and only once per day; an expired
subscription (410) is deleted; stats queries on fixture data.

**Acceptance:** the standard commands. Manual: a push arrives on the iPhone (the PWA must be
installed to the home screen, iOS ≥ 16.4).

**Notes:**
