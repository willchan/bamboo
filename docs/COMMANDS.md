# Bamboo — Commands

The full command reference. `CLAUDE.md` lists only the everyday ones; look here (grep for the
tool or script) before guessing a command. Keep this list accurate as milestones land.
Node 24, pnpm (pinned in `package.json`).


```
pnpm install
pnpm dev                                   # web on localhost:3000 (DEV_AUTH_BYPASS=1 for local sign-in)
pnpm lint && pnpm typecheck && pnpm test   # what CI runs (web test enforces ≥ 90% coverage on lib/domain), plus: pnpm --filter web build
pnpm check:plan                            # finished milestones' sections have left docs/PLAN.md (in pnpm test)
pnpm --filter web test:e2e                 # Playwright, phone viewport; servers on :3100 (fresh db/e2e.db) and :3101 (seeded)
pnpm --filter web exec playwright install chromium   # once, before the first e2e run
pnpm db:generate                           # after editing db/src/schema/*: new migration (commit it)
pnpm db:migrate                            # apply migrations to TURSO_DATABASE_URL (default file:db/dev.db)
pnpm --filter web repinyin                 # recompute stored phrase pinyin after a pinyin change (the Vercel build runs it)
pnpm --filter web gen:pinyin-dict          # regenerate web/lib/data/pinyin-dict.json after bumping pinyin-pro or @pinyin-pro/data (--check verifies)
pnpm db:seed                               # synthetic dev phrases into a local DB (refuses Turso)
pnpm --filter web dev:seeded               # next dev on a throwaway seeded db/dev-seeded.db (dev sign-in)
pnpm --filter web shot / /review/back /imports /stats   # phone shots, light + dark → web/.shots; nonzero on console/request errors
pnpm --filter web shot /review/back/辅食    # the answer of the round's card showing that hanzi (one /review/… path per run)
make prod-copy                             # ask Will first: prod → .scratch/prod-copy.db, READ-ONLY token, counts only (DESIGN §8.6)
pnpm --filter web dev:prod-copy            # next dev on the prod copy (refuses non-file: DBs)
make prod-copy-clean                       # delete the copy when you're done
bamboo-tools segment --url <link> | --file <pdf>   # dry-run parse (agent/tools/bin/bamboo-tools in a checkout; no API calls)
bamboo-tools ask --text-file <txt> / turn --question-file … --answer-file … --message-id …   # the skill's pasted-answer/question routing and tutor capture (H5)
pnpm smoke https://bamboo-panda.vercel.app   # after each deploy (prod): public, read-only checks, no secrets (cloud: README › After each deploy)
make worker-install / worker-logs / agent-install / agent-check / mac-update   # Mac mini, as openclaw-agent (DESIGN §8.3); DRY_RUN=1 make agent-install
pnpm --filter @bamboo/worker test:ollama   # opt-in eval: synthetic turns through the local Ollama model (the fallback)
BAMBOO_EVAL_GEMINI=1 pnpm --filter @bamboo/worker test:gemini   # Mac, as openclaw-agent: synthetic turns through Gemini (free-tier key in agent.env; counts only)
pnpm --filter @bamboo/worker backfill -- --gemini-key=paid --count | --limit 10 | --all | --named | --examples-pinyin[=N]   # Mac, as openclaw-agent, launchd worker stopped: H7 re-runs on the paid key (--named: turns the name filter acted on; --examples-pinyin: pinyin jobs for examples without stored pinyin, §10 #107); counts only
pnpm --filter @bamboo/worker gemini-probe -- [--gemini-key=paid]   # Mac, as openclaw-agent: 4 synthetic Gemini requests (each schema as sent), pass/fail and Google's error each
make tutor-eval ARGS="run | serve | score …"   # Mac, as openclaw-agent: local tutor evaluation (DESIGN §5.4); output in ~/bamboo-eval/
```
