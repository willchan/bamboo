# Bamboo 🎋

A personal tool for remembering the Mandarin you look up, so you can actually say it next time.

Share a Gemini conversation to Discord. A local LLM picks out the words, patterns and sentences
worth keeping, and a short daily round of spoken review (FSRS) makes them stick.

See [CLAUDE.md](CLAUDE.md) and [docs/](docs/) for the product, design, and build plan.

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
