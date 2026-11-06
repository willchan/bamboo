#!/usr/bin/env bash
# `make mac-update` (DESIGN §8.3): run as the account that owns the worker, in its checkout.
# git pull --ff-only, pnpm install --frozen-lockfile, then `make worker-install` again, which
# reloads the LaunchAgent if its plist changed and otherwise restarts the worker
# (launchctl kickstart -k) when the pull brought new commits. worker.env is never touched.
set -euo pipefail
# shellcheck source=ops/scripts/lib.sh
. "$(dirname "$0")/lib.sh"

need git pnpm
cd "$ROOT"
before="$(git rev-parse HEAD)"
run git pull --ff-only
after="$(git rev-parse HEAD)"
run pnpm install --frozen-lockfile

if [ "$before" = "$after" ]; then
  note "already up to date at ${after:0:12}"
  kick=0
else
  info "updated ${before:0:12} → ${after:0:12}"
  kick=1
fi
# Run the (possibly just-updated) install script in a fresh process.
SKIP_PNPM_INSTALL=1 KICKSTART="$kick" "$ROOT/ops/scripts/worker-install.sh"
