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

## Commands

> Keep this list accurate as milestones land. Node 24, pnpm (pinned in `package.json`).

```
pnpm install
pnpm dev                                   # web on localhost:3000 (DEV_AUTH_BYPASS=1 for local sign-in)
pnpm lint && pnpm typecheck && pnpm test   # what CI runs (web test enforces ≥ 90% coverage on lib/domain), plus: pnpm --filter web build
pnpm --filter web test:e2e                 # Playwright, phone viewport; own server on :3100 and fresh db/e2e.db
pnpm --filter web exec playwright install chromium   # once, before the first e2e run
pnpm db:generate                           # after editing db/src/schema/*: new migration (commit it)
pnpm db:migrate                            # apply migrations to TURSO_DATABASE_URL (default file:db/dev.db)
pnpm db:seed                               # synthetic dev phrases into a local DB (refuses Turso)
bamboo-tools segment --url <link> | --file <pdf>   # dry-run parse (agent/tools/bin/bamboo-tools in a checkout; no API calls)
pnpm smoke <url>                           # after each deploy: public, read-only checks of a deployment (no secrets)
make worker-install / worker-logs / agent-install / mac-update   # Mac mini, as openclaw-agent (DESIGN §8.3); DRY_RUN=1 make agent-install
pnpm --filter @bamboo/worker test:ollama   # opt-in eval: synthetic turns through the local Ollama model
```
