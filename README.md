# Bamboo 🎋

A personal tool for remembering the Mandarin you look up, so you can actually say it next time.

Share a Gemini conversation to Discord. A local LLM picks out the words, patterns and sentences
worth keeping, and a short daily round of spoken review (FSRS) makes them stick.

See [CLAUDE.md](CLAUDE.md) and [docs/](docs/) for the product, design, and build plan.

**Production:** https://bamboo-panda.vercel.app

## Develop

Node 24 and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```
pnpm install
pnpm db:migrate                 # creates db/dev.db
pnpm db:seed                    # optional: 15 synthetic phrases, some due now
DEV_AUTH_BYPASS=1 pnpm dev      # http://localhost:3000, signed in as a fixed dev user
pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build   # what CI runs
pnpm --filter web exec playwright install chromium   # once
pnpm --filter web test:e2e      # Playwright at a phone viewport (own server and db/e2e.db)
```

`.env.example` lists every variable. For real Google sign-in locally, copy its web block to
`web/.env.local`, fill in `AUTH_SECRET`, `AUTH_GOOGLE_*` and `ALLOWED_EMAILS`, and leave
`DEV_AUTH_BYPASS` unset.

| Path | What |
|---|---|
| `web/` | Next.js State Engine: UI (PWA), API, domain logic. Deployed on Vercel |
| `db/` | `@bamboo/db`: Drizzle schema, migrations (`pnpm db:generate`, `pnpm db:migrate`) |
| `shared/` | `@bamboo/shared`: contracts and normalization shared by web and the Mac side |
| `worker/` | `@bamboo/worker`: runs extraction jobs on the Mac's local Ollama (M4) |
| `agent/tools/` | `@bamboo/tools`: the `bamboo-tools` CLI for the OpenClaw skill (M5) |
| `agent/skills/bamboo/` | The OpenClaw skill for `#bamboo` (M5) |

## Deploy (one-time setup)

Vercel deploys `main` to production and every PR to a preview (DESIGN §8.2). The build runs
`pnpm db:migrate` first, against that environment's Turso database.

1. **Turso**: create two databases, `bamboo` (production) and `bamboo-preview`. For each, save
   its `libsql://…` URL and a database auth token.
2. **Vercel**: *Add New → Project* → import this repo. **Root Directory: `web`** (framework
   Next.js; pnpm is detected from the lockfile). Keep *Include files outside the root directory
   in the Build Step* on: the app imports `/db` and `/shared`. `web/vercel.json` sets the build
   command. Note the production domain (`https://<name>.vercel.app`).
3. **Google OAuth**: Google Cloud console → *Google Auth Platform*: External audience, publishing
   status *Testing*, your Google account as the only test user. *Clients → Create client* → Web
   application, with these **Authorized redirect URIs**:
   - `https://<production domain>/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`

   Preview deployments get a new host per build, so they don't get a redirect URI: previews show
   the sign-in page but can't complete Google sign-in. That's intended.
4. **Vercel environment variables** (*Settings → Environment Variables*, mark secrets
   *Sensitive*, leave *Development* unticked):

   | Variable | Production | Preview |
   |---|---|---|
   | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | `bamboo` | `bamboo-preview` |
   | `AUTH_SECRET` | `openssl rand -hex 32` | a different one |
   | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | step 3 | same as production |
   | `ALLOWED_EMAILS` | your Google address | leave unset (nobody signs in on previews) |
   | `HOUSEHOLD_TZ` | `America/Los_Angeles` | same |
   | `APP_URL` | `https://<production domain>` | same |
   | `AGENT_API_TOKEN`, `WORKER_API_TOKEN`, `CRON_SECRET` | `openssl rand -hex 32` each (used from M3) | different ones |

   Never set `DEV_AUTH_BYPASS` on Vercel (the app ignores it there anyway).
5. Redeploy production (*Deployments → … → Redeploy*) so it picks up the variables.
6. **Daily job**: `web/vercel.json` declares a Vercel **Schedule** named `daily` that calls
   `GET /api/cron/daily` once a day (11:17 UTC, around 04:00 in Los Angeles, within Vercel's jitter
   window). Vercel sends `CRON_SECRET` as its bearer token. After the first production deploy
   that includes it, open the project's **Schedules** page: `daily` is listed and active; select it
   and click *Run Schedule* to check that it returns 200 with counts (a 401/503 means
   `CRON_SECRET` is missing). The *Cron Jobs* tab there (formerly *Observability → Cron Jobs*)
   should be empty: Bamboo no longer uses legacy Cron Jobs.

## After each deploy

Run the public smoke check against the deployment (no sign-in, no secrets, never a real token):

```
pnpm smoke https://bamboo-panda.vercel.app
```

In a Claude Code cloud session, `bamboo-panda.vercel.app` must be in the environment's allowed
hosts, and Node's `fetch` only uses the session's proxy with
`NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` in front of the command.

It prints one line per check and exits non-zero on any failure: `/` redirects signed-out
visitors to `/sign-in`; the manifest is standalone and its icons load; Google is the auth provider
with this host's callback, and the sign-in POST redirects to `accounts.google.com` with a Google
client id and that callback; and every machine route (`/api/imports*`, `/api/agent/*`,
`/api/jobs/*`, `/api/worker/*`, `/api/cron/*`) answers 401 with no token and with a wrong one.

## Mac mini: Discord intake (once)

OpenClaw, Ollama and PandaBase's agent run as the `openclaw-agent` user, and Bamboo's Mac side
does too (DESIGN §8.3).

Bamboo shares that Mac's Ollama and never changes its settings or pulls models: the host owns
those, along with the memory budget. What Bamboo needs from it is one model, `qwen3.8:27b`
(~18GB): OpenClaw's reply model for the agent that serves `#bamboo` (the host sets it; every
OpenClaw agent on the Mac uses it) and the worker's text model (`OLLAMA_TEXT_MODEL`). The worker
asks for it at OpenClaw's 32k context and 30m keep-alive, so a job uses the loaded model and never
reloads or unloads it (DESIGN §1.2). Ollama keeps one model loaded (`OLLAMA_MAX_LOADED_MODELS=1`
on the 32GB Mac) and answers one request at a time, so a job and a reply can wait for each other;
PandaBase's vision jobs still swap in `qwen3.5:9b`. From your own account, `ssh agent`, then:

```
git clone https://github.com/willchan/bamboo.git ~/Code/bamboo && cd ~/Code/bamboo
BAMBOO_API_URL=https://<production domain> \
BAMBOO_DISCORD_CHANNEL_ID=<#bamboo channel id> BAMBOO_DISCORD_GUILD_ID=<server id> \
  make agent-install            # add DRY_RUN=1 first to see what it would change
```

It installs dependencies, links `~/.local/bin/bamboo-tools`, creates
`~/.config/bamboo/bamboo.config.json` and `~/.config/bamboo/agent.env` (only if missing), and
adds `agent/skills` to OpenClaw's `skills.load.extraDirs` (backing up `openclaw.json` first). It
also pins `#bamboo`'s channel entry to the bamboo skill (`skills`, `systemPrompt`, `tools.deny`;
DESIGN §5.1), keeping its `enabled`, `requireMention` and `users` as they are. It never adds an
agent or changes `bindings`: the host binds `#bamboo` to an agent (on Will's Mac, `willchan`, per
the Mac's runbook), and the automations run on that agent. It ends with `make agent-check`
(read-only; run it on its own any time), which fails if `#bamboo` isn't bound or the agent can't
use the skill, and warns if the agent's thinking isn't off or its `AGENTS.md` lacks the skill's
current instructions (DESIGN §5.1). Then:

1. Put the production `AGENT_API_TOKEN` in `~/.config/bamboo/agent.env` as
   `BAMBOO_AGENT_API_TOKEN=…` with an editor (not on a command line), and run `make agent-install` again: it adds the `bamboo-replies` and
   `bamboo-nudge` command automations.
2. If it warns that `#bamboo` isn't enabled for the bot, run the `openclaw config set …` line it
   prints, with the same Discord user id as `#pandabase`'s entry (the line already includes the
   pin), then run `make agent-install` again.
3. `bamboo-tools segment --url <a share link>`: a dry run that prints the title and turn count.

PDF imports need poppler's `pdftotext` (`brew install poppler`) in `/opt/homebrew/bin`. New
OpenClaw sessions pick the skill up. After later merges: `make mac-update` in `~/Code/bamboo`
(it pulls, updates the worker, then runs `make agent-install`).

## Mac mini: tutor evaluation (one-off)

Is a local model a good enough Mandarin tutor? (docs/ROADMAP.md › Tutor; DESIGN §5.4.) Needs the
`GET /api/agent/eval/turns` deploy and `make mac-update`. As `openclaw-agent`, in `~/Code/bamboo`:

```
make tutor-eval ARGS="run --seed <any word>"     # sample ~20 questions, replay through qwen3.8:27b
                                                  # (--models a,b,… for more, each pulled): ~10–20 min
make tutor-eval ARGS="serve --out ~/bamboo-eval/<run id> --host $(/opt/homebrew/bin/tailscale ip -4)"
make tutor-eval ARGS="score --out ~/bamboo-eval/<run id>"
```

`run` prints the run directory. Will opens the URL `serve` prints on his iPhone (Tailscale on),
rates every answer 1–5 for accuracy and naturalness, marks the one he prefers, and taps **Save to
Mac** (ratings survive reloads; **Export** downloads the JSON instead, to put in the run directory
as `results.json`). Answers are labeled A, B, C… with no model names; the key is `key.json` in the
run directory. Compare more models with `--models <a>,<b>` (each must be pulled); an interrupted run
resumes with `run --out <run dir>`. Everything stays in `~/bamboo-eval/`, never the checkout.
