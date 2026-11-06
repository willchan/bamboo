#!/usr/bin/env bash
# `make agent-check` (DESIGN §8.3): read-only check of the dedicated `bamboo` OpenClaw agent
# (§5.1, §10 #50). Run it as the gateway's user (openclaw-agent); `make agent-install` runs it at
# the end. Exits 1 if anything is off; `make agent-install` fixes all of it.
#
#   - agents.defaults.systemAgent.agentId is main (every other message stays there);
#   - the bamboo agent exists, with thinkingDefault off and skills ["bamboo"];
#   - #bamboo (discord.channel_id in ~/.config/bamboo/bamboo.config.json) routes to it: the first
#     binding that matches the channel is the bamboo agent's;
#   - its workspace AGENTS.md is exactly what SKILL.md generates, and no BOOTSTRAP.md is there.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${BAMBOO_CONFIG:-$HOME/.config/bamboo/bamboo.config.json}"
case ":$PATH:" in *:/opt/homebrew/bin:*) ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
export PATH

for bin in jq openclaw; do
  command -v "$bin" >/dev/null 2>&1 || {
    printf '✗ missing %s\n' "$bin" >&2
    exit 1
  }
done
# shellcheck source=agent/openclaw-agent.sh
. "$ROOT/agent/openclaw-agent.sh"

failed=0
ok() { printf '✓ %s\n' "$*"; }
bad() {
  printf '✗ %s\n' "$*"
  failed=1
}

channel_id=""
[ ! -f "$CONFIG" ] || channel_id="$(jq -r '.discord.channel_id // empty' "$CONFIG")"
case "$channel_id" in "" | *[!0-9]* | 000*) channel_id="" ;; esac
[ -x "$SETUP_TSX" ] || bad "missing $SETUP_TSX (pnpm install)"

system_agent="$(cfg_get agents.defaults.systemAgent.agentId | jq -r '. // empty' 2>/dev/null || true)"
if [ "$system_agent" = "$SYSTEM_AGENT_ID" ]; then
  ok "systemAgent is $SYSTEM_AGENT_ID"
else
  bad "agents.defaults.systemAgent.agentId is '${system_agent:-unset}', not $SYSTEM_AGENT_ID"
fi

entry="$(cfg_get "agents.entries.$AGENT_ID")"
if [ -z "$entry" ]; then
  bad "no $AGENT_ID agent (agents.entries.$AGENT_ID)"
else
  ok "the $AGENT_ID agent exists ($(printf '%s' "$entry" | jq -r '.model // "default model"'))"
  thinking="$(printf '%s' "$entry" | jq -r '.thinkingDefault // empty')"
  if [ "$thinking" = off ]; then ok "thinkingDefault off"; else bad "thinkingDefault is '${thinking:-unset}', not off"; fi
  skills="$(printf '%s' "$entry" | jq -c '.skills')"
  if [ "$skills" = '["bamboo"]' ]; then ok 'skills ["bamboo"]'; else bad "skills is $skills, not [\"bamboo\"]"; fi
fi

if [ -z "$channel_id" ]; then
  bad "no discord.channel_id in $CONFIG"
elif [ -x "$SETUP_TSX" ]; then
  bindings="$(cfg_get bindings)"
  route="$(printf '%s' "${bindings:-[]}" | setup route "$channel_id" "$account_id" 2>/dev/null || true)"
  if [ "$route" = "$AGENT_ID" ]; then
    ok "#bamboo ($channel_id) routes to $AGENT_ID"
  else
    bad "#bamboo ($channel_id) routes to '${route:-the default agent}', not $AGENT_ID"
  fi
  if printf '%s' "${bindings:-[]}" | jq -e --arg a "$SYSTEM_AGENT_ID" \
    'type == "array" and any(.[]; .agentId == $a and .match.channel == "discord")' >/dev/null 2>&1; then
    ok "$SYSTEM_AGENT_ID keeps its Discord binding"
  else
    printf '⚠ no Discord binding for %s (other channels go to the default agent)\n' "$SYSTEM_AGENT_ID"
  fi
fi

workspace="$(agent_workspace "$entry")"
if [ -x "$SETUP_TSX" ]; then
  if agents_md="$(agents_md_file)"; then
    if [ -f "$workspace/AGENTS.md" ] && cmp -s "$agents_md" "$workspace/AGENTS.md"; then
      ok "$workspace/AGENTS.md matches SKILL.md"
    else
      bad "$workspace/AGENTS.md is missing or differs from what SKILL.md generates"
    fi
    rm -f "$agents_md"
  else
    bad "can't generate AGENTS.md from $SKILL_FILE"
  fi
fi
if [ -e "$workspace/BOOTSTRAP.md" ]; then
  bad "$workspace/BOOTSTRAP.md is active (it starts an onboarding chat)"
else
  ok "no BOOTSTRAP.md in the workspace"
fi

if [ "$failed" = 0 ]; then
  printf 'agent-check: ok\n'
else
  printf 'agent-check: problems above; make agent-install fixes them\n'
  exit 1
fi
