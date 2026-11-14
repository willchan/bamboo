# CLAUDE.md

Bamboo helps Will remember the Mandarin he looks up in Gemini for talking to his family: the
yuesao, his toddler and the nanny. He shares Gemini conversations to OpenClaw in Discord
(`#bamboo`). A **local** LLM on the Mac mini extracts phrases into a ranked queue, and a PWA runs
a short daily spoken review (one round of ~10 cards, FSRS).

The pieces:
- a Next.js + Turso **State Engine** on Vercel;
- a Node **worker** and a **`bamboo-tools`** CLI with an OpenClaw skill on the Mac mini;
- an authenticated HTTP API between them.

It's all TypeScript. It follows PandaBase's stack and conventions (`github.com/willchan/pandabase`)
and shares that Mac's Ollama and OpenClaw.

## Start here

| Doc | Read when |
|---|---|
| [docs/PRD.md](docs/PRD.md) | You need to know *what* the product does and *why* |
| [docs/DESIGN.md](docs/DESIGN.md) | You're changing architecture, schema, API, algorithms, prompts or ops |
| [docs/PLAN.md](docs/PLAN.md) | You're executing a build milestone: follow its *Session protocol* |
| [docs/PROMPTS.md](docs/PROMPTS.md) | You're Will, starting a session (orchestrator, milestone, plan update, quality review) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | You're tempted to build a tutor, Cantonese, a Discord quiz, or neural TTS: they're deferred |

Read only the sections your task needs.

## Rules

- **The docs are living.** A PR that changes user-visible behavior updates `docs/PRD.md`. A PR
  that changes architecture, schema, API contracts, algorithms or prompts updates
  `docs/DESIGN.md` (including §10 *Key decisions*). Deviations from a milestone go in its
  **Notes** in `docs/PLAN.md`.
- **The State Engine owns data and logic.** The worker and `bamboo-tools` never touch the DB; they
  call the API. Domain rules (validation of LLM output, dedupe, ranking, scheduling, the reminder
  decision, pinyin) are pure, tested functions in `web/lib/domain/`, or in `shared/` when the Mac
  side needs them too.
- **Never trust LLM-written Chinese metadata.** Pinyin is always computed (pinyin-pro), and
  Gemini's pinyin is never stored. Extracted hanzi, including example sentences, must appear
  verbatim in the source turn, or they are dropped.
- **Local models only at runtime.** No cloud LLM API calls anywhere in Bamboo. The worker uses
  Ollama on the Mac. The OpenClaw skill never reads or summarizes conversation content itself.
- **Prompts are versioned files** in `worker/prompts/`. Changing a prompt means a new version file;
  jobs record `prompt_version`.
- **Tunables live in config**: `web/lib/config.ts` (engine) and `shared/src/config.ts` (Mac side).
  No magic numbers in domain code.
- **Contracts are Zod schemas in `shared/src/contracts/`**, imported by web, worker and tools.
- **Migrations are expand → contract.** Migrations run in the Vercel build before new code
  serves; add freely, and drop or rename only in a later PR.
- **Nothing blocks on a human.** The queue picks new material automatically; stale items expire.
- **Privacy:** Will's real conversations (share links, PDFs) are never committed, never used as
  test fixtures, and never quoted in docs, PRs or commit messages; report counts only. Debug
  copies go in the gitignored `private/`. Children's names and health details must not appear in
  the repo. Fixtures are synthetic.
- **Bug fixes start with a regression test** that fails before the fix.
- **Done means seen working.** Before finishing a UI, data or scheduling change, follow
  `.claude/skills/verify/SKILL.md`: seeded screenshots first, the read-only prod copy when real
  data matters. Prod data and prod-copy screenshots never go in commits, PRs, fixtures, CI logs
  or chat (counts and pass/fail only). Ask Will before `make prod-copy`; delete the copy when done.
- **Opened a PR?** Turn on its Auto-fix (the app's PR monitor) so CI failures, merge conflicts
  and review comments wake you.

## Commands

> Keep this list accurate as milestones land. Node 24, pnpm (pinned in `package.json`).

```
pnpm install
pnpm dev                                   # web on localhost:3000 (DEV_AUTH_BYPASS=1 for local sign-in)
pnpm lint && pnpm typecheck && pnpm test   # what CI runs (web test enforces ≥ 90% coverage on lib/domain), plus: pnpm --filter web build
pnpm --filter web test:e2e                 # Playwright, phone viewport; servers on :3100 (fresh db/e2e.db) and :3101 (seeded)
pnpm --filter web exec playwright install chromium   # once, before the first e2e run
pnpm db:generate                           # after editing db/src/schema/*: new migration (commit it)
pnpm db:migrate                            # apply migrations to TURSO_DATABASE_URL (default file:db/dev.db)
pnpm db:seed                               # synthetic dev phrases into a local DB (refuses Turso)
pnpm --filter web dev:seeded               # next dev on a throwaway seeded db/dev-seeded.db (dev sign-in)
pnpm --filter web shot / /review/back /imports /stats   # phone shots, light + dark → web/.shots; nonzero on console/request errors
make prod-copy                             # ask Will first: prod → .scratch/prod-copy.db, READ-ONLY token, counts only (DESIGN §8.6)
pnpm --filter web dev:prod-copy            # next dev on the prod copy (refuses non-file: DBs)
make prod-copy-clean                       # delete the copy when you're done
bamboo-tools segment --url <link> | --file <pdf>   # dry-run parse (agent/tools/bin/bamboo-tools in a checkout; no API calls)
pnpm smoke https://bamboo-panda.vercel.app   # after each deploy (prod): public, read-only checks, no secrets (cloud: README › After each deploy)
make worker-install / worker-logs / agent-install / agent-check / mac-update   # Mac mini, as openclaw-agent (DESIGN §8.3); DRY_RUN=1 make agent-install
pnpm --filter @bamboo/worker test:ollama   # opt-in eval: synthetic turns through the local Ollama model
make tutor-eval ARGS="run | serve | score …"   # Mac, as openclaw-agent: local tutor evaluation (DESIGN §5.4); output in ~/bamboo-eval/
```

## Working on the live Mac mini

Lessons from live runs (November 2026). Ask before anything that changes production.

- **Two accounts.** Claude sessions run as the admin user; Bamboo's Mac side belongs to
  `openclaw-agent`. Run there with `ssh agent '<cmd>'` from `~/Code/bamboo`. Its token lives in
  that account's `~/.config/bamboo/agent.env` as `BAMBOO_AGENT_API_TOKEN` (Vercel's stays
  `AGENT_API_TOKEN`), never in the admin's home.
- **After a PR merges,** run `make mac-update` there.
- **Shared with PandaBase:** the OpenClaw gateway and Ollama. Ollama's settings, models and memory
  budget belong to the host's runbook, not to Bamboo: don't change them from here. New
  automations need `--agent` (the installer passes the agent the host binds `#bamboo` to, on
  the Mac a dedicated `bamboo` agent). Routing and agents are the host's too: Bamboo never adds an agent or
  changes `bindings` (DESIGN §10 #69).
- **"ok" isn't proof.** An automation can finish "ok" without doing its work. Check the run
  (`openclaw automations runs <id> --json`) and the output it should have produced.
