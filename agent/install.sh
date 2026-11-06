#!/usr/bin/env bash
# `make agent-install` (DESIGN §8.3): set up Bamboo's side of OpenClaw. Run it as the user that
# owns the OpenClaw gateway (on Will's Mac: `openclaw-agent`, via `ssh agent`), from that
# account's Bamboo checkout. Safe to re-run; every change is additive, and openclaw.json is backed
# up before it changes. PandaBase shares this gateway: nothing here touches its skills dir, its
# automations or the gateway env (~/.openclaw/.env), and nothing restarts the gateway.
#
#  1. pnpm install (tsx and the CLI's dependencies);
#  2. link $BIN_DIR/bamboo-tools → agent/tools/bin/bamboo-tools (BIN_DIR=~/.local/bin, which must
#     be on the gateway's PATH; PandaBase's pandabase-tools lives there too);
#  3. create ~/.config/bamboo/bamboo.config.json (from agent/bamboo.config.example.json; ids from
#     BAMBOO_DISCORD_CHANNEL_ID / BAMBOO_DISCORD_GUILD_ID) and ~/.config/bamboo/agent.env
#     (BAMBOO_API_URL from the environment, BAMBOO_AGENT_API_TOKEN left empty for Will) if
#     missing, and renames an older file's unprefixed AGENT_API_TOKEN to BAMBOO_AGENT_API_TOKEN;
#  4. add <checkout>/agent/skills to OpenClaw's skills.load.extraDirs (replacing a stale Bamboo
#     checkout's entry, never anyone else's);
#  5. check that the #bamboo channel is enabled for the bot (prints the command if not);
#  6. once BAMBOO_AGENT_API_TOKEN is set: add or update the two command automations, bamboo-replies
#     and bamboo-nudge (no model call), announcing to #bamboo;
#  7. openclaw skills check.
#
#   DRY_RUN=1            print what would change, change nothing
#   SKIP_PNPM_INSTALL=1  skip step 1 (tests)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN="${DRY_RUN:-0}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CONF_DIR="$HOME/.config/bamboo"
CONFIG="$CONF_DIR/bamboo.config.json"
AGENT_ENV="$CONF_DIR/agent.env"
SKILLS_DIR="$ROOT/agent/skills"
TOOLS_BIN="$ROOT/agent/tools/bin/bamboo-tools"
case ":$PATH:" in *:/opt/homebrew/bin:*) ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
export PATH

info() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run]'
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
backup() {
  local file="$1" copy
  copy="$file.bak.$(date +%Y%m%d-%H%M%S)"
  run cp -p "$file" "$copy"
  info "backed up $file → $copy"
}

need node pnpm jq openclaw realpath
command -v pdftotext >/dev/null 2>&1 || warn "pdftotext not found: PDF imports need poppler (brew install poppler)"

# 1. dependencies
if [ "${SKIP_PNPM_INSTALL:-0}" != 1 ]; then
  (cd "$ROOT" && run pnpm install --frozen-lockfile)
fi

# 2. bamboo-tools on PATH
run mkdir -p "$BIN_DIR"
if [ "$(readlink "$BIN_DIR/bamboo-tools" 2>/dev/null || true)" = "$TOOLS_BIN" ]; then
  note "kept $BIN_DIR/bamboo-tools → $TOOLS_BIN"
else
  run ln -sfn "$TOOLS_BIN" "$BIN_DIR/bamboo-tools"
  info "linked $BIN_DIR/bamboo-tools → $TOOLS_BIN"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on this shell's PATH; it must be on the OpenClaw gateway's PATH" ;;
esac

# 3. config files (never overwritten; the token is Will's to fill in)
run mkdir -p "$CONF_DIR"
[ "$DRY_RUN" = 1 ] || chmod 700 "$CONF_DIR"
if [ -f "$CONFIG" ]; then
  note "kept $CONFIG"
elif [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] would create $CONFIG"
else
  jq --arg c "${BAMBOO_DISCORD_CHANNEL_ID:-}" --arg g "${BAMBOO_DISCORD_GUILD_ID:-}" '
    del(._comment)
    | if $c != "" then .discord.channel_id = $c else . end
    | if $g != "" then .discord.guild_id = $g else . end' \
    "$ROOT/agent/bamboo.config.example.json" >"$CONFIG"
  info "created $CONFIG"
fi
if [ -f "$AGENT_ENV" ]; then
  note "kept $AGENT_ENV"
elif [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] would create $AGENT_ENV"
else
  (
    umask 077
    printf '%s\n' \
      "# bamboo-tools settings (DESIGN §8.1). Mode 600; never commit or paste it." \
      "BAMBOO_API_URL=${BAMBOO_API_URL:-}" \
      "# The engine's AGENT_API_TOKEN (Vercel → Settings → Environment Variables, Production)." \
      "BAMBOO_AGENT_API_TOKEN=" >"$AGENT_ENV"
  )
  info "created $AGENT_ENV (BAMBOO_AGENT_API_TOKEN is empty: fill it in, then re-run make agent-install)"
fi
# Older files used the unprefixed AGENT_API_TOKEN, a name other apps' tools share (DESIGN §10 #42).
if [ -f "$AGENT_ENV" ] && grep -q '^AGENT_API_TOKEN=' "$AGENT_ENV" \
  && ! grep -q '^BAMBOO_AGENT_API_TOKEN=' "$AGENT_ENV"; then
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would rename AGENT_API_TOKEN to BAMBOO_AGENT_API_TOKEN in $AGENT_ENV"
  else
    tmp="$(mktemp "$AGENT_ENV.XXXXXX")"
    sed 's/^AGENT_API_TOKEN=/BAMBOO_AGENT_API_TOKEN=/' "$AGENT_ENV" >"$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$AGENT_ENV"
    info "renamed AGENT_API_TOKEN to BAMBOO_AGENT_API_TOKEN in $AGENT_ENV"
  fi
fi
[ "$DRY_RUN" = 1 ] || [ ! -f "$AGENT_ENV" ] || chmod 600 "$AGENT_ENV"

channel_id=""
guild_id=""
tz="America/Los_Angeles"
replies_cron="*/5 * * * *"
nudge_cron="*/30 17-23 * * *"
if [ -f "$CONFIG" ]; then
  channel_id="$(jq -r '.discord.channel_id // empty' "$CONFIG")"
  guild_id="$(jq -r '.discord.guild_id // empty' "$CONFIG")"
  tz="$(jq -r --arg d "$tz" '.automations.tz // $d' "$CONFIG")"
  replies_cron="$(jq -r --arg d "$replies_cron" '.automations.replies_cron // $d' "$CONFIG")"
  nudge_cron="$(jq -r --arg d "$nudge_cron" '.automations.nudge_cron // $d' "$CONFIG")"
fi
case "$channel_id" in
  "" | *[!0-9]* | 000*) channel_id="" ;;
esac
[ -n "$channel_id" ] || warn "no #bamboo channel id in $CONFIG yet (discord.channel_id)"
case "$guild_id" in "" | *[!0-9]* | 000*) guild_id="" ;; esac

# 4. skills.load.extraDirs
config_file="$(openclaw config file --json 2>/dev/null | jq -r '.path // empty' || true)"
config_file="${config_file:-$HOME/.openclaw/openclaw.json}"
[ -f "$config_file" ] || die "no OpenClaw config at $config_file: run this as the user that owns the gateway"
current="$(openclaw config get skills.load.extraDirs --json 2>/dev/null || true)"
printf '%s' "$current" | jq -e 'type == "array"' >/dev/null 2>&1 || current='[]'
# Another Bamboo checkout's entry (it has bamboo/SKILL.md, or it's gone and was Bamboo's) is
# replaced by this one; every other entry stays as it is.
stale='[]'
while IFS= read -r dir; do
  [ -n "$dir" ] && [ "$dir" != "$SKILLS_DIR" ] || continue
  case "$dir" in */agent/skills) ;; *) continue ;; esac
  if [ -f "$dir/bamboo/SKILL.md" ] || { [ ! -e "$dir" ] && case "$dir" in *bamboo*) true ;; *) false ;; esac; }; then
    stale="$(printf '%s' "$stale" | jq -c --arg d "$dir" '. + [$d]')"
  fi
done < <(printf '%s' "$current" | jq -r '.[] | strings')
wanted="$(printf '%s' "$current" | jq -c --arg d "$SKILLS_DIR" --argjson s "$stale" \
  '[.[] | select(. as $x | $s | index($x) | not)] | if index($d) then . else . + [$d] end')"
if [ "$(printf '%s' "$current" | jq -c .)" = "$wanted" ]; then
  note "kept skills.load.extraDirs (already includes $SKILLS_DIR)"
else
  backup "$config_file"
  run openclaw config set skills.load.extraDirs "$wanted" --strict-json >/dev/null
  info "skills.load.extraDirs: added $SKILLS_DIR$([ "$stale" = '[]' ] || printf ', replaced %s' "$(printf '%s' "$stale" | jq -r 'join(", ")')")"
fi

# 5. Is #bamboo open to the bot? (read-only: the channel allowlist is Will's call)
if [ -n "$channel_id" ] && [ -n "$guild_id" ]; then
  enabled="$(openclaw config get "channels.discord.guilds.$guild_id.channels.$channel_id.enabled" --json 2>/dev/null || true)"
  if [ "$enabled" = true ]; then
    note "kept #bamboo ($channel_id): enabled for the bot"
  else
    warn "#bamboo isn't enabled for the bot yet. Copy #pandabase's entry (same users), e.g.:"
    warn "  openclaw config set channels.discord.guilds.$guild_id.channels.$channel_id '{\"enabled\":true,\"requireMention\":false,\"users\":[\"<your Discord user id>\"]}' --strict-json"
  fi
fi

# 6. Command automations (no model call), once the token is there.
if ! grep -Eq '^BAMBOO_AGENT_API_TOKEN=.+' "$AGENT_ENV" 2>/dev/null; then
  warn "skipped the automations: BAMBOO_AGENT_API_TOKEN is empty in $AGENT_ENV (fill it in, then re-run)"
elif [ -z "$channel_id" ]; then
  warn "skipped the automations: no discord.channel_id in $CONFIG"
else
  if [ "$DRY_RUN" = 1 ]; then
    existing='[]'
  else
    existing="$(openclaw automations list --all --json)" || die "can't list automations: is the gateway running?"
  fi
  job_id() {
    printf '%s' "$existing" |
      jq -r --arg n "$1" '(if type == "array" then . else (.jobs // .automations // []) end)
        | map(select(.name == $n)) | first | .id // empty'
  }
  upsert() {
    local name="$1" cron="$2" command="$3" id
    local args=(--cron "$cron" --tz "$tz" --command "$command" --announce --channel discord --to "channel:$channel_id")
    id="$(job_id "$name")"
    if [ -n "$id" ]; then
      run openclaw automations edit "$id" "${args[@]}" >/dev/null
      info "updated automation $name ($cron)"
    else
      run openclaw automations add --name "$name" "${args[@]}" >/dev/null
      info "added automation $name ($cron)"
    fi
  }
  bin="$(printf '%q' "$TOOLS_BIN")"
  upsert bamboo-replies "$replies_cron" "$bin replies"
  upsert bamboo-nudge "$nudge_cron" "$bin nudge"
fi

# 7. Report
if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] would run: openclaw skills check"
else
  openclaw skills check || warn "openclaw skills check reported problems (see above)"
fi
info "New OpenClaw sessions pick the skill up; existing ones keep their snapshot."
