# Thin wrappers over pnpm. Targets marked "stub" are filled in by the milestone named.
.PHONY: install dev lint typecheck test build check db-migrate \
	worker-install worker-logs agent-install mac-update

install:
	pnpm install

dev:
	pnpm dev

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test

build:
	pnpm --filter web build

# What CI runs.
check: lint typecheck test build

db-migrate:
	pnpm db:migrate

# --- Mac mini (DESIGN §8.3) ---------------------------------------------------------------------

worker-install: # as openclaw-agent, in its checkout; idempotent, DRY_RUN=1 prints (ops/scripts/)
	ops/scripts/worker-install.sh

worker-logs: # launchd state, last heartbeat, tail -F ~/Library/Logs/bamboo/worker.log (FOLLOW=0)
	ops/scripts/worker-logs.sh

# Run as the OpenClaw gateway's user (openclaw-agent on the Mac mini), from its Bamboo checkout:
# bamboo-tools on PATH, ~/.config/bamboo, skills.load.extraDirs (backed up first) and the command
# automations. Idempotent; DRY_RUN=1 prints what it would change (agent/install.sh).
agent-install:
	agent/install.sh

mac-update: # git pull --ff-only, pnpm install --frozen-lockfile, worker-install (reload/kickstart)
	ops/scripts/mac-update.sh
