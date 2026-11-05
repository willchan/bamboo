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

worker-install: # stub (M4): install and load ops/launchd/com.bamboo.worker.plist
	@echo "worker-install: not implemented yet (M4)"; exit 1

worker-logs: # stub (M4): tail ~/Library/Logs/bamboo/
	@echo "worker-logs: not implemented yet (M4)"; exit 1

agent-install: # stub (M5): bamboo-tools on PATH, tools config, OpenClaw extraDirs + automations
	@echo "agent-install: not implemented yet (M5)"; exit 1

mac-update: # stub (M4): git pull --ff-only, pnpm install --frozen-lockfile, launchctl kickstart
	@echo "mac-update: not implemented yet (M4)"; exit 1
