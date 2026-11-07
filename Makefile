# Thin wrappers over pnpm. Targets marked "stub" are filled in by the milestone named.
.PHONY: install dev lint typecheck test build check db-migrate \
	worker-install worker-logs agent-install agent-check mac-update tutor-eval

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
# bamboo-tools on PATH, ~/.config/bamboo, skills.load.extraDirs (backed up first), the #bamboo
# pin, the dedicated bamboo agent (its AGENTS.md from SKILL.md, its binding) and the command
# automations. Idempotent; DRY_RUN=1 prints what it would change (agent/install.sh).
agent-install:
	agent/install.sh

agent-check: # read-only: bamboo agent, thinking off, #bamboo binding, AGENTS.md in step (agent/check.sh)
	agent/check.sh

mac-update: # git pull, pnpm install, worker-install (reload/kickstart), then agent-install
	ops/scripts/mac-update.sh

# Local tutor evaluation (DESIGN §5.4), as openclaw-agent: bamboo-eval with ARGS, e.g.
#   make tutor-eval ARGS="run --seed nov"   then ARGS="serve --out <dir> --host <ip>", "score …"
# Output goes to ~/bamboo-eval/<run id>/, never the checkout.
tutor-eval:
	@agent/tools/node_modules/.bin/tsx agent/tools/src/eval/main.ts $(ARGS)
