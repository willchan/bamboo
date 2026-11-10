---
name: verify
description: How to see a Bamboo change working before calling it done — seeded phone screenshots (light and dark) for any UI change, then the read-only prod copy when real data matters. Read before finishing any change to web pages, components, styles, domain logic, scheduling, imports or stats.
---

# Verifying a Bamboo change

Tests passing isn't the bar: Will's iPhone checks (light-mode pinyin, the reminder switch after a
reload, "Learn 3 more") stayed pending for days after their PRs merged green. Look at the change
the way Will meets it, on a phone, in both themes. The tools are in docs/DESIGN.md §8.6.

**Bamboo's data is Will's real Gemini conversations about family Mandarin.** Prod data and
prod-copy screenshots never go in commits, PRs, fixtures, CI logs or chat. In chat: counts and
pass/fail only. No children's names anywhere. Never touch the live app or its database; use only
the read-only token, never `TURSO_AUTH_TOKEN`.

## Pick the loop by what changed

| Change | Do |
|---|---|
| Anything | The fast checks it touches (`pnpm lint && pnpm typecheck && pnpm test`) |
| UI: a page, component, style, copy | + **Seeded shots** |
| Behavior you can click (a switch, a button, a round) | + a test in `web/e2e/seeded/` if it needs data in several states |
| Scheduling, ranking, imports, stats, a migration | + **Prod copy** (after the seeded loop, with Will's OK) |

## 1. Seeded shots (always first)

1. `pnpm --filter web shot / /review/start /review/back /imports /stats …` — every path your
   change shows, light and dark, into `web/.shots/`. It starts its own seeded server
   (`web/scripts/seed-data.ts`: due reviews, today's learning cards, phrases waiting, imports, past
   rounds); `--base-url http://localhost:3000` reuses `dev-seeded` from `.claude/launch.json`.
   `/review/start` is a round's first card; `/review/back` is the same card after Show.
2. It exits 1 on any console error, page error, failed request or HTTP ≥ 400 — fix those, don't
   wave them through (a hydration warning is an error).
3. **Open every PNG and look**: layout at 390 px, both themes, contrast (pinyin is `--muted`),
   the bottom nav not covering content, text that fits.
4. Send Will the shots that show the change (SendUserFile). They're synthetic, but they are not
   committed: `web/.shots/` is gitignored.

## 2. Prod copy (when real data matters)

1. **Ask Will before `make prod-copy`.** It copies prod with the read-only token
   (`~/.config/bamboo/prod-ro.env`, or a cloud network secret with `PROD_RO_TOKEN_FROM_PROXY=1`)
   into `.scratch/prod-copy.db` and prints row counts. If the token is missing, say so and stop
   at the seeded loop.
2. Run what your change affects against the copy, never against prod:
   - Scripts and queries: `TURSO_DATABASE_URL=file:.scratch/prod-copy.db …`.
   - Screens: `dev-prod-copy` in `.claude/launch.json` or `pnpm --filter web shot --prod-copy …`.
     Look locally; these shots never leave the machine and are never sent to chat.
3. Report **counts and pass/fail only**: rows, cards due, checks passed. In the PR, the same.
4. A problem the copy reveals gets a **synthetic** regression test shaped like it (CLAUDE.md: bug
   fixes start with a regression test).
5. **Delete the copy before you report** (`make prod-copy-clean`) and say you did. Leave it only
   while the task still needs it, and say so.

## Before you call it done

- Name in the PR which loops ran and what each found (counts only for the prod copy).
- If a loop couldn't run (no token, Will hasn't OK'd the copy), say which and why.
