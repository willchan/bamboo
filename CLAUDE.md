# CLAUDE.md

Bamboo helps Will remember the Mandarin (and some Cantonese) he looks up in Gemini for talking
to his family: the yuesao, his toddler, the nanny, and his in-laws. It imports the Gemini
conversation, extracts phrases with a **local** LLM on the Mac mini, and runs a 5-minute daily
spoken review (FSRS) in a PWA. It is a Next.js + Turso **State Engine** on Vercel plus a Node
**worker** on the Mac mini, talking over an authenticated HTTP API. It follows the stack and
conventions of PandaBase (`github.com/willchan/pandabase`) and shares that Mac's Ollama.

## Start here

| Doc | Read when |
|---|---|
| [docs/PRD.md](docs/PRD.md) | You need to know *what* the product does and *why* |
| [docs/DESIGN.md](docs/DESIGN.md) | You're changing architecture, schema, API, algorithms, prompts or ops |
| [docs/PLAN.md](docs/PLAN.md) | You're executing a build milestone: follow its *Session protocol* |
| [docs/ROADMAP.md](docs/ROADMAP.md) | You're tempted to build a tutor, Discord, share-link import, or neural TTS: they're deferred |

Read only the sections your task needs.

## Rules

- **The docs are living.** A PR that changes user-visible behavior updates `docs/PRD.md`. A PR
  that changes architecture, schema, API contracts, algorithms or prompts updates
  `docs/DESIGN.md` (including §10 *Key decisions*). Deviations from a milestone go in its
  **Notes** in `docs/PLAN.md`.
- **The State Engine owns data and logic.** The worker never touches the DB; it calls the API.
  Domain rules (ranking, validation of LLM output, scheduling, romanization) are pure, tested
  functions in `web/lib/domain/` (or in `shared/` when the worker needs them too).
- **Never trust LLM-written Chinese metadata.** Romanization is always computed (pinyin-pro /
  to-jyutping) and Gemini's pinyin is never stored. Extracted hanzi must appear verbatim in the
  source turn, or the item is dropped.
- **Local models only at runtime.** No cloud LLM API calls anywhere in Bamboo. The worker uses
  Ollama on the Mac.
- **Prompts are versioned files** in `worker/prompts/`. Changing a prompt means a new version file;
  jobs record `prompt_version`.
- **Tunables live in `web/lib/config.ts`.** No magic numbers in domain code.
- **Contracts are Zod schemas in `shared/src/contracts/`**, imported by both web and worker.
- **Migrations are expand → contract.** Migrations run in the Vercel build before new code
  serves; add freely, and drop or rename only in a later PR.
- **Nothing blocks on a human.** Inbox candidates expire; every review flow has a default outcome.
- **Privacy:** `private/` holds Will's real Gemini exports and personal seed decks. Never commit
  it, never use it as a test fixture, and never quote it in docs, PRs or commit messages
  (counts only). Children's names and health details must not appear in the repo. Fixtures are
  synthetic.
- **Bug fixes start with a regression test** that fails before the fix.

## Commands

> Keep this list accurate as milestones land. Node 24, pnpm (pinned in `package.json`).

```
pnpm install
pnpm dev                                   # web on localhost:3000 (DEV_AUTH_BYPASS=1 for local sign-in)
pnpm lint && pnpm typecheck && pnpm test   # what CI runs, plus: pnpm --filter web build
pnpm --filter web test:e2e                 # Playwright, phone viewport
pnpm db:generate                           # after editing db/src/schema/*: new migration (commit it)
pnpm db:migrate                            # apply migrations to TURSO_DATABASE_URL (default file:db/dev.db)
pnpm db:import-phrases <file.json>         # load a seed deck (M2+)
make worker-install / worker-update / worker-logs   # Mac mini worker via launchd (M5+)
```
