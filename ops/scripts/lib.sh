#!/usr/bin/env bash
# Shared helpers for ops/scripts (PandaBase's scripts/ops/lib.sh pattern). Source it; don't run it.
# Everything runs as the account that owns the worker: on the Mac mini, openclaw-agent, from its
# own Bamboo checkout. Overridable for tests and dry runs:
#   DRY_RUN=1           print the commands that change something instead of running them
#   BAMBOO_CONFIG_DIR   default ~/.config/bamboo (worker.env lives here)
#   LAUNCH_AGENTS_DIR   default ~/Library/LaunchAgents
#   LOG_DIR             default ~/Library/Logs/bamboo
#   LAUNCHD_DOMAIN      default gui/<uid> (the agent account's login session)
# shellcheck disable=SC2034  # ROOT etc. are used by the scripts that source this file

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRY_RUN="${DRY_RUN:-0}"
CONFIG_DIR="${BAMBOO_CONFIG_DIR:-$HOME/.config/bamboo}"
ENV_FILE="$CONFIG_DIR/worker.env"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/bamboo}"
LABEL="com.bamboo.worker"
PLIST="$AGENTS_DIR/$LABEL.plist"
DOMAIN="${LAUNCHD_DOMAIN:-gui/$(id -u)}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BAD=$'\033[31m' C_WARN=$'\033[33m' C_DIM=$'\033[2m' C_OFF=$'\033[0m'
else
  C_BAD='' C_WARN='' C_DIM='' C_OFF=''
fi

info() { printf '%s\n' "$*"; }
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
warn() { printf '%s⚠ %s%s\n' "$C_WARN" "$*" "$C_OFF" >&2; }
die() {
  printf '%s✗ %s%s\n' "$C_BAD" "$*" "$C_OFF" >&2
  exit 1
}

# Run a command, or only print it when DRY_RUN=1.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s[dry-run]%s' "$C_DIM" "$C_OFF"
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

need() {
  local bin
  for bin in "$@"; do
    command -v "$bin" >/dev/null 2>&1 || die "missing '$bin' (DESIGN §8.3 prerequisites)"
  done
}

# True if KEY has a non-empty value in an env file. Never prints the value.
env_has() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 1
  awk -v k="$key" '
    index($0, k "=") == 1 { v = substr($0, length(k) + 2) }
    END { gsub(/^[ \t"'\'']+|[ \t"'\'']+$/, "", v); exit (v == "") }
  ' "$file"
}

# True if the worker's LaunchAgent is loaded in $DOMAIN.
loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}
