#!/usr/bin/env bash
# `make worker-logs` (DESIGN §8.3): the worker's launchd state and last heartbeat, then its log.
#   LINES=50   how many lines to show first
#   FOLLOW=0   print and exit instead of following (tail -F)
set -euo pipefail
# shellcheck source=ops/scripts/lib.sh
. "$(dirname "$0")/lib.sh"

log="$LOG_DIR/worker.log"
if command -v launchctl >/dev/null 2>&1 && loaded; then
  state="$(launchctl print "$DOMAIN/$LABEL" | awk -F' = ' '
    /^\tstate = / { s = $2 } /^\tpid = / { p = $2 } /^\tlast exit code = / { e = $2 }
    END { printf "%s%s%s", s, (p ? ", pid " p : ""), (e ? ", last exit " e : "") }')"
  info "$LABEL: loaded ($state)"
else
  warn "$LABEL is not loaded in $DOMAIN (make worker-install)"
fi

if [ ! -f "$log" ]; then
  warn "no log yet at $log"
  exit 0
fi
last_hb="$(grep -E 'heartbeat (ok|failed)' "$log" | tail -n 1 || true)"
info "last heartbeat: ${last_hb:-none yet}"
info "--- $log"
if [ "${FOLLOW:-1}" = 0 ]; then
  tail -n "${LINES:-50}" "$log"
else
  exec tail -n "${LINES:-50}" -F "$log"
fi
