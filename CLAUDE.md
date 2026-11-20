# CLAUDE.md

Bamboo helps Will remember the Mandarin he looks up in Gemini for talking to his family: the
yuesao, his toddler and the nanny. He asks the `#bamboo` OpenClaw agent (Gemini Flash) in Discord,
or shares Gemini conversations there. The Mac mini's worker has Gemini extract phrases from each
turn into a queue, and a PWA runs a short daily spoken review (one round of ~10 cards, FSRS).
(The move from local models to this Gemini-backed hybrid is done: docs/PLAN.md › *Hybrid
H1–H7*, DESIGN §5.5.)

The pieces:
- a Next.js + Turso **State Engine** on Vercel;
- a Node **worker** and a **`bamboo-tools`** CLI with an OpenClaw skill on the Mac mini;
- an authenticated HTTP API between them.

It's all TypeScript. It follows PandaBase's stack and conventions (`github.com/willchan/pandabase`)
and shares that Mac's OpenClaw (and its Ollama, now only the worker's fallback).

## Start here

| Doc | Read when |
|---|---|
| [docs/PRD.md](docs/PRD.md) | You need to know *what* the product does and *why* |
| [docs/DESIGN.md](docs/DESIGN.md) | You're changing architecture, schema, API, algorithms, prompts or ops |
| [docs/PLAN.md](docs/PLAN.md) | You're executing a build milestone: follow its *Session protocol* |
| [docs/PROMPTS.md](docs/PROMPTS.md) | You're Will, starting a session (orchestrator, milestone, plan update, quality review) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | You're tempted to build Cantonese, a Discord quiz, or neural TTS: they're deferred |

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
- **Stored pinyin is always a valid dictionary reading; Gemini only chooses among those
  readings.** Pinyin is computed (pinyin-pro, large dictionary) and merged per syllable with
  Gemini's: a reading that isn't valid for the character loses to the computed one, a real
  dispute goes to a referee call limited to valid readings plus the neutral tone, and Will's
  override wins (DESIGN §5.5.3). No context-rule heuristics (H1 removed the 得/长 rules; H4 added
  the merge, `shared/src/pinyin-merge.ts`). Extracted hanzi, including example sentences, must appear verbatim in the source
  turn, or they are dropped; a card-back breakdown must match its phrase's hanzi exactly.
- **Gemini at runtime, nothing else.** The `#bamboo` agent (tutor, Gemini Flash) and the
  worker's extraction (Gemini, free-tier key) are the only LLM calls; Ollama is only the worker's
  fallback, and the engine on Vercel calls no LLM. An extraction request carries only the prompt
  and one turn (a `pinyin` job's: the prompt and one phrase with its examples). The tutor never
  writes cards: every turn goes through the worker and the engine's checks. The agent never reads
  a share link, PDF or pasted answer itself (DESIGN §5.5, §10 #74; the worker is on Gemini since
  H4; the agent answers with a `worker/prompts/tutor.v*.md` prompt since H5, v2 since §10 #99,
  once the host has moved its model to Gemini Flash).
- **Prompts are versioned files** in `worker/prompts/`. Changing a prompt means a new version file;
  jobs record `prompt_version`.
- **Tunables live in config**: `web/lib/config.ts` (engine) and `shared/src/config.ts` (Mac side).
  No magic numbers in domain code.
- **Contracts are Zod schemas in `shared/src/contracts/`**, imported by web, worker and tools.
- **Migrations are expand → contract.** Migrations run in the Vercel build before new code
  serves; add freely, and drop or rename only in a later PR.
- **Nothing blocks on a human.** The queue picks new material automatically, freshest first.
  Unseen phrases don't expire (no queue budget); Not useful and Already know stay (DESIGN §4.7,
  since H2b).
- **Privacy:** Will's real conversations (share links, PDFs) are never committed, never used as
  test fixtures, and never quoted in docs, PRs or commit messages; report counts only. Debug
  copies go in the gitignored `private/`. Children's names and health details must not appear in
  the repo. Fixtures are synthetic. On the Gemini path (DESIGN §5.5.8):
  - every prompt (tutor, extraction, referee) says never to put a person's name in an answer or
    card (use 宝宝, 孩子, 阿姨, 月嫂 or 妈妈) and to keep personal health specifics (diagnoses,
    doses, measurements) out of cards; ordinary words like 胀气 are fine;
  - the name deny-list is `~/.config/bamboo/names.deny` in `openclaw-agent`'s account, on the
    Mac only, filled in by Will. Anything extracted containing a listed name is dropped or
    rewritten. Never read it into chat, commit it, log it or test with it; fixtures use
    synthetic placeholder names;
  - only the turn and the prompt go to Gemini;
  - prod data is counts only, anywhere.
- **Bug fixes start with a regression test** that fails before the fix.
- **Done means seen working.** Before finishing a UI, data or scheduling change, follow
  `.claude/skills/verify/SKILL.md`: seeded screenshots first, the read-only prod copy when real
  data matters. Prod data and prod-copy screenshots never go in commits, PRs, fixtures, CI logs
  or chat (counts and pass/fail only). Ask Will before `make prod-copy`; delete the copy when done.
- **Opened a PR?** Turn on its Auto-fix (the app's PR monitor) so CI failures, merge conflicts
  and review comments wake you.
- **Merge when green.** Will doesn't review PRs here. Once a PR you opened (or were asked to drive)
  is mergeable, every required check on its head commit has passed, and no review thread is
  unresolved, merge it yourself (squash) without asking. Don't merge on red, pending or
  conflicting; anything that needs `sudo` or touches production still needs asking first.

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
pnpm --filter @bamboo/worker backfill -- --gemini-key=paid --count | --limit 10 | --all   # Mac, as openclaw-agent, launchd worker stopped: H7 re-runs on the paid key; counts only
pnpm --filter @bamboo/worker gemini-probe -- [--gemini-key=paid]   # Mac, as openclaw-agent: 4 synthetic Gemini requests (each schema as sent), pass/fail and Google's error each
make tutor-eval ARGS="run | serve | score …"   # Mac, as openclaw-agent: local tutor evaluation (DESIGN §5.4); output in ~/bamboo-eval/
```

## Working on the live Mac mini

Lessons from live runs (November 2026). Ask before anything that changes production.

- **Two accounts.** Claude sessions run as the admin user; Bamboo's Mac side belongs to
  `openclaw-agent`. Run there with `ssh agent '<cmd>'` from `~/Code/bamboo`. Its token lives in
  that account's `~/.config/bamboo/agent.env` as `BAMBOO_AGENT_API_TOKEN` (Vercel's stays
  `AGENT_API_TOKEN`), never in the admin's home.
- **After a PR merges,** run `make mac-update` there. It pulls, installs, restarts the worker and
  runs `agent-install` (which ends with `agent-check`), so it also picks up a new tutor prompt or
  skill. If it changed an extraction schema or prompt, run the Gemini probe there too
  (`gemini-probe`, above): Google rejects some schemas only on a real request ("too many states
  for serving", H7), which CI can't see.
- **Cloud sessions can't reach the Mac.** Whenever something has to run there, end your report
  with the exact line(s) for Will to paste from his own account (`willchan`) on the Mac mini,
  never a list of steps. Wrap each command in `ssh agent` and a login shell, so `pnpm` is on the
  PATH:

  ```
  ssh agent 'zsh -lc "cd ~/Code/bamboo && <command>"'
  ```

  Chain with `&&` when one should stop on failure. After merging a PR that touches the Mac side
  (`worker/`, `agent/`, `shared/`, `ops/`, a prompt), the command is `make mac-update`; add
  `pnpm --filter @bamboo/worker gemini-probe` after it when an extraction schema or prompt
  changed. A line that touches the shared OpenClaw gateway or Ollama (a restart, a config
  change) affects PandaBase too: mark it as the host's and say so beside it. Ask Will to
  paste back output you need, counts and pass/fail only.
- **Shared with PandaBase:** the OpenClaw gateway and Ollama. Ollama's settings, models and memory
  budget belong to the host's runbook, not to Bamboo: don't change them from here. New
  automations need `--agent` (the installer passes the agent the host binds `#bamboo` to, on
  the Mac a dedicated `bamboo` agent). Routing and agents are the host's too: Bamboo never adds an agent or
  changes `bindings` (DESIGN §10 #69).
- **"ok" isn't proof.** An automation can finish "ok" without doing its work. Check the run
  (`openclaw automations runs <id> --json`) and the output it should have produced.
