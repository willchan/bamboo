#!/usr/bin/env bash
# `make worker-install` (DESIGN §8.3): run as the account that owns the worker (on the Mac mini,
# openclaw-agent, from its own Bamboo checkout). Idempotent:
#   1. pnpm install --frozen-lockfile (SKIP_PNPM_INSTALL=1 skips it; mac-update already ran it);
#   2. ~/.config/bamboo/worker.env from ops/worker.env.example, mode 600, only if it is missing:
#      an existing file is never overwritten or printed;
#   3. the LaunchAgent ops/launchd/com.bamboo.worker.plist rendered into ~/Library/LaunchAgents
#      and (re)loaded only when it changed. It isn't loaded while WORKER_API_TOKEN is empty.
#   KICKSTART=1 restarts an unchanged, loaded worker (mac-update uses it after a pull).
set -euo pipefail
# shellcheck source=ops/scripts/lib.sh
. "$(dirname "$0")/lib.sh"

need node
[ "${SKIP_PNPM_INSTALL:-0}" = 1 ] || need pnpm
[ "$DRY_RUN" = 1 ] || need launchctl

# 1. Dependencies.
if [ "${SKIP_PNPM_INSTALL:-0}" = 1 ]; then
  note "skipped pnpm install"
else
  (cd "$ROOT" && run pnpm install --frozen-lockfile)
fi

# 2. worker.env: create from the template if missing; never overwrite.
run mkdir -p "$CONFIG_DIR"
run chmod 700 "$CONFIG_DIR"
if [ -f "$ENV_FILE" ]; then
  note "kept $ENV_FILE (exists)"
  run chmod 600 "$ENV_FILE"
elif [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] would create $ENV_FILE (mode 600) from ops/worker.env.example"
else
  (umask 077 && cp "$ROOT/ops/worker.env.example" "$ENV_FILE")
  chmod 600 "$ENV_FILE"
  info "created $ENV_FILE (mode 600) from ops/worker.env.example"
fi

# 3. The LaunchAgent.
node_bin="$(command -v node)"
template="$ROOT/ops/launchd/$LABEL.plist"
rendered="$(sed -e "s|@REPO@|$ROOT|g" -e "s|@HOME@|$HOME|g" -e "s|@NODE@|$node_bin|g" \
  -e "s|@ENV_FILE@|$ENV_FILE|g" -e "s|@LOG_DIR@|$LOG_DIR|g" "$template")"
run mkdir -p "$AGENTS_DIR" "$LOG_DIR"

if ! env_has WORKER_API_TOKEN "$ENV_FILE"; then
  warn "not loading $LABEL: WORKER_API_TOKEN is empty in $ENV_FILE"
  info "Next: paste the production WORKER_API_TOKEN (Vercel → Settings → Environment Variables)"
  info "into $ENV_FILE, then run 'make worker-install' again."
  exit 0
fi

is_loaded=0
if command -v launchctl >/dev/null 2>&1 && loaded; then is_loaded=1; fi
if [ -f "$PLIST" ] && [ "$(cat "$PLIST")" = "$rendered" ] && [ "$is_loaded" = 1 ]; then
  if [ "${KICKSTART:-0}" = 1 ]; then
    run launchctl kickstart -k "$DOMAIN/$LABEL"
    info "restarted $LABEL (it finishes its current job first)"
  else
    note "kept $LABEL (installed, loaded)"
  fi
  exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] would write $PLIST"
else
  printf '%s\n' "$rendered" >"$PLIST"
  if command -v plutil >/dev/null; then plutil -lint -s "$PLIST"; fi
fi
if [ "$is_loaded" = 1 ]; then
  run launchctl bootout "$DOMAIN/$LABEL" || true
  # bootout returns before a busy worker has finished its job (ExitTimeOut is 300 s).
  for _ in $(seq 1 310); do loaded || break; sleep 1; done
fi
run launchctl bootstrap "$DOMAIN" "$PLIST" ||
  die "launchctl bootstrap $DOMAIN failed. Is this account logged in (automatic login)? Over ssh without a login session, try LAUNCHD_DOMAIN=user/$(id -u)."
info "loaded $LABEL: logs in $LOG_DIR/worker.log ('make worker-logs')"
