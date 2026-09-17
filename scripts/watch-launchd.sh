#!/bin/bash
# launchd wrapper for `valentine watch --once`. Keeps env sourcing and PATH
# resolution out of the plist: launchd agents get a minimal PATH and no shell
# profile, so we add the common Node locations (mise shims, Homebrew) here.
# Channel comes from VALENTINE_WATCH_NOTIFY (set in the plist; default macos).
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

exec ./node_modules/.bin/tsx src/cli.ts watch --once --notify "${VALENTINE_WATCH_NOTIFY:-macos}"
