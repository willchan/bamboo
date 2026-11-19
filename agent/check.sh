#!/usr/bin/env bash
# `make agent-check` (DESIGN §8.3): read-only check of the OpenClaw agent that serves #bamboo
# (§5.1, §10 #69). The host binds that agent (the Mac's runbook); this only reports. Run it as the
# gateway's user (openclaw-agent); `make agent-install` runs it at the end. Exits 1 on a ✗.
#
#   ✗ #bamboo (discord.channel_id in ~/.config/bamboo/bamboo.config.json) isn't bound to an agent,
#     the agent has no config entry, or its skills allowlist leaves out bamboo;
#   ⚠ its model isn't Gemini Flash (the tutor, H5), its thinkingDefault isn't off (slow
#     replies), its workspace AGENTS.md lacks lines of SKILL.md's instructions or of the tutor
#     prompt (a stale inline copy), or the bamboo-* automations run on another agent. These are
#     the host's to change.
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
heads_up() { printf '⚠ %s\n' "$*"; }

channel_id=""
[ ! -f "$CONFIG" ] || channel_id="$(jq -r '.discord.channel_id // empty' "$CONFIG")"
case "$channel_id" in "" | *[!0-9]* | 000*) channel_id="" ;; esac
[ -x "$SETUP_TSX" ] || bad "missing $SETUP_TSX (pnpm install)"

agent=""
if [ -z "$channel_id" ]; then
  bad "no discord.channel_id in $CONFIG"
elif [ -x "$SETUP_TSX" ]; then
  agent="$(serving_agent "$channel_id")"
  if [ -n "$agent" ]; then
    ok "#bamboo ($channel_id) routes to $agent"
  else
    bad "#bamboo ($channel_id) isn't bound to an agent (it goes to OpenClaw's default); the host's runbook binds it"
  fi
fi

if [ -n "$agent" ]; then
  entry="$(cfg_get "agents.entries.$agent")"
  if [ -z "$entry" ]; then
    bad "no $agent agent (agents.entries.$agent)"
  else
    model="$(printf '%s' "$entry" | jq -r 'if (.model | type) == "object" then .model.primary else .model end // empty')"
    [ -n "$model" ] || model="$(cfg_get agents.defaults.model | jq -r 'if type == "object" then .primary else . end // empty' 2>/dev/null || true)"
    ok "the $agent agent exists (${model:-default model})"
    # H5: the tutor runs on Gemini Flash (DESIGN §5.5.7). The host's runbook sets the model and
    # the auth profiles; Bamboo only reports. `openclaw models status --agent <id> --probe`
    # shows which key serves.
    case "$model" in
      google/gemini-*flash*) ok "$agent answers with $model (the tutor)" ;;
      *) heads_up "$agent's model is '${model:-default}', not Gemini Flash: the #bamboo tutor needs google/gemini-…-flash (the host's runbook sets it, DESIGN §5.5.7)" ;;
    esac
    if printf '%s' "$entry" | jq -e '(.skills | type) != "array" or (.skills | index("bamboo"))' >/dev/null; then
      ok "$agent can use the bamboo skill"
    else
      bad "$agent's skills allowlist $(printf '%s' "$entry" | jq -c .skills) leaves out bamboo"
    fi
    thinking="$(printf '%s' "$entry" | jq -r '.thinkingDefault // empty')"
    [ -n "$thinking" ] || thinking="$(cfg_get agents.defaults.thinkingDefault | jq -r '. // empty' 2>/dev/null || true)"
    if [ "$thinking" = off ]; then
      ok "$agent thinkingDefault off"
    else
      heads_up "$agent thinkingDefault is '${thinking:-OpenClaw default}', not off: #bamboo replies can take minutes (DESIGN §5.1)"
    fi

    agents_md="$(agent_workspace "$agent" "$entry")/AGENTS.md"
    if [ ! -f "$agents_md" ]; then
      heads_up "no $agents_md: the agent will need to open SKILL.md itself"
    elif [ -x "$SETUP_TSX" ]; then
      if missing="$(setup missing "$SKILL_FILE" "$agents_md" "$TUTOR_FILE" 2>&1)"; then
        if [ -z "$missing" ]; then
          ok "$agents_md has SKILL.md's instructions and the tutor prompt"
        else
          heads_up "$agents_md lacks $(printf '%s\n' "$missing" | wc -l | tr -d ' ') line(s) of SKILL.md's instructions or the tutor prompt; run make agent-install (a dedicated agent) or update its #bamboo section (a shared agent). First: $(printf '%s\n' "$missing" | head -n 1)"
        fi
      else
        bad "can't compare $agents_md with $SKILL_FILE: $missing"
      fi
    fi
  fi

  autos="$(openclaw automations list --all --json 2>/dev/null || true)"
  others="$(printf '%s' "${autos:-[]}" | jq -r --arg a "$agent" '
    (if type == "array" then . else (.jobs // .automations // []) end)
    | map(select((.name // "" | startswith("bamboo-")) and has("agentId") and .agentId != $a))
    | map("\(.name) → \(.agentId)") | join(", ")' 2>/dev/null || true)"
  if [ -n "$others" ]; then
    heads_up "automations on another agent than $agent: $others (make agent-install moves them)"
  fi
fi

if [ "$failed" = 0 ]; then
  printf 'agent-check: ok\n'
else
  printf 'agent-check: problems above (the host binds #bamboo; see DESIGN §8.3)\n'
  exit 1
fi
