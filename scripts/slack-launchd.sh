#!/bin/bash
# launchd wrapper for `valentine slack` — the /valentine slash command and the
# Slack interactivity endpoint. Keeps env sourcing and PATH resolution out of
# the plist: launchd agents get a minimal PATH and no shell profile, so we add
# the common Node locations (mise shims, Homebrew) here. Port comes from
# VALENTINE_SLACK_PORT (set in the plist, or in .env; default 3141).
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

exec ./node_modules/.bin/tsx src/cli.ts slack --port "${VALENTINE_SLACK_PORT:-3141}"
