#!/usr/bin/env bash
# Shared by agent/install.sh and agent/check.sh: reading the OpenClaw agent that serves #bamboo
# (DESIGN §5.1, §10 #69). The host binds that agent (the Mac's runbook); Bamboo never adds one or
# changes bindings. Source it after ROOT and CONFIG are set; don't run it.
# shellcheck disable=SC2034  # used by the scripts that source this file

SKILL_FILE="$ROOT/agent/skills/bamboo/SKILL.md"
SETUP_TSX="$ROOT/agent/tools/node_modules/.bin/tsx"

# Optional override in bamboo.config.json: agent.discord_account_id (the OpenClaw Discord account
# the binding matches).
account_id="default"
if [ -f "$CONFIG" ]; then
  account_id="$(jq -r --arg d "$account_id" '.agent.discord_account_id // $d' "$CONFIG")"
fi

# agent/tools/src/openclaw/main.ts: route, missing.
setup() { "$SETUP_TSX" "$ROOT/agent/tools/src/openclaw/main.ts" "$@"; }

# A config value as compact JSON, or nothing when it's unset (or the CLI fails).
cfg_get() {
  local v
  v="$(openclaw config get "$1" --json 2>/dev/null)" || return 0
  printf '%s' "$v" | jq -e '(type == "object" and .ok == false and has("error")) | not' \
    >/dev/null 2>&1 || return 0
  printf '%s' "$v" | jq -c .
}

# The agent the host binds #bamboo ($1) to, or nothing (no readable bindings, or none matches:
# OpenClaw's default agent).
serving_agent() {
  local bindings
  bindings="$(cfg_get bindings)"
  [ -n "$bindings" ] || return 0
  printf '%s' "$bindings" | setup route "$1" "$account_id" 2>/dev/null || true
}

# The agent's workspace from its config entry (JSON), ~ expanded; OpenClaw's default otherwise.
agent_workspace() { # $1 agent id, $2 entry JSON
  local ws
  ws="$(printf '%s' "${2:-}" | jq -r '.workspace // empty' 2>/dev/null || true)"
  if [ -z "$ws" ]; then
    if [ "$1" = main ]; then ws="$HOME/.openclaw/workspace"; else ws="$HOME/.openclaw/workspace-$1"; fi
  fi
  # shellcheck disable=SC2088  # a literal ~/ in the config value
  case "$ws" in "~/"*) ws="$HOME/${ws#\~/}" ;; esac
  printf '%s' "$ws"
}
