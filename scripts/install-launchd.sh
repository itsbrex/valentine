#!/bin/bash
# Install (or update) the launchd agent that runs `valentine watch --once`
# every 5 minutes: survives reboots, needs no terminal.
#
#   scripts/install-launchd.sh [macos|fullscreen|stdout|slack]   # default macos
#   scripts/install-launchd.sh --uninstall
#
# Logs: ~/.valentine/watch.log · Status: launchctl print gui/$UID/com.valentine.watch
# First run may show a macOS Calendars permission prompt — click Allow.
set -euo pipefail

LABEL="com.valentine.watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
UID_N="$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$UID_N" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled: $LABEL"
  exit 0
fi

CHANNEL="${1:-macos}"
case "$CHANNEL" in macos|fullscreen|stdout|slack) ;; *)
  echo "unknown channel: $CHANNEL (use macos|fullscreen|stdout|slack)" >&2; exit 1;;
esac

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.valentine"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$REPO/scripts/watch-launchd.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VALENTINE_WATCH_NOTIFY</key><string>$CHANNEL</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.valentine/watch.log</string>
  <key>StandardErrorPath</key><string>$HOME/.valentine/watch.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID_N" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$PLIST"
echo "loaded: $LABEL — every 5 min · --notify $CHANNEL · log: ~/.valentine/watch.log"
