#!/usr/bin/env bash
# Shared by agent/install.sh and agent/check.sh: the dedicated `bamboo` OpenClaw agent (DESIGN
# §5.1, §10 #50). Source it after ROOT and CONFIG are set; don't run it.
# shellcheck disable=SC2034  # used by the scripts that source this file

AGENT_ID=bamboo
SYSTEM_AGENT_ID=main
DEFAULT_WORKSPACE="$HOME/.openclaw/workspace-$AGENT_ID"
SKILL_FILE="$ROOT/agent/skills/bamboo/SKILL.md"
SETUP_TSX="$ROOT/agent/tools/node_modules/.bin/tsx"

# Optional overrides in bamboo.config.json: agent.model (only used when the agent is added) and
# agent.discord_account_id (the OpenClaw Discord account the binding matches).
agent_model="ollama/qwen3.5:27b"
account_id="default"
if [ -f "$CONFIG" ]; then
  agent_model="$(jq -r --arg d "$agent_model" '.agent.model // $d' "$CONFIG")"
  account_id="$(jq -r --arg d "$account_id" '.agent.discord_account_id // $d' "$CONFIG")"
fi

# agent/tools/src/openclaw/main.ts: agents-md, bindings, route.
setup() { "$SETUP_TSX" "$ROOT/agent/tools/src/openclaw/main.ts" "$@"; }

# A config value as compact JSON, or nothing when it's unset (or the CLI fails).
cfg_get() {
  local v
  v="$(openclaw config get "$1" --json 2>/dev/null)" || return 0
  printf '%s' "$v" | jq -e '(type == "object" and .ok == false and has("error")) | not' \
    >/dev/null 2>&1 || return 0
  printf '%s' "$v" | jq -c .
}

# The agent's workspace from its config entry (JSON), ~ expanded; OpenClaw's default otherwise.
agent_workspace() {
  local ws
  ws="$(printf '%s' "${1:-}" | jq -r '.workspace // empty' 2>/dev/null || true)"
  ws="${ws:-$DEFAULT_WORKSPACE}"
  # shellcheck disable=SC2088  # a literal ~/ in the config value
  case "$ws" in "~/"*) ws="$HOME/${ws#\~/}" ;; esac
  printf '%s' "$ws"
}

# Generate the workspace AGENTS.md from SKILL.md into a temp file; print its path.
agents_md_file() {
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/bamboo-agents-md.XXXXXX")"
  if ! setup agents-md "$SKILL_FILE" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  printf '%s' "$tmp"
}
