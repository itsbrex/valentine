#!/bin/bash
# Install (or update) the two launchd agents behind the always-on Slack
# endpoint: survives reboots, needs no terminal.
#
#   com.valentine.slack        `valentine slack` — slash command + interactivity
#   com.valentine.cloudflared  the named tunnel that fronts it with a stable URL
#
#   scripts/install-slack-launchd.sh [port]          # default 3141
#   scripts/install-slack-launchd.sh --print [port]  # show the plists, install nothing
#   scripts/install-slack-launchd.sh --uninstall
#
# Logs: ~/.valentine/slack.log · ~/.valentine/cloudflared.log
# Status: launchctl print gui/$UID/com.valentine.slack
#
# Create the tunnel once before installing (see README § "Always-on: the Slack
# endpoint behind a tunnel"): `cloudflared tunnel create valentine`, an ingress
# stanza in ~/.cloudflared/config.yml, then `cloudflared tunnel route dns`.
set -euo pipefail

LABEL="com.valentine.slack"
TUNNEL_LABEL="com.valentine.cloudflared"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TUNNEL_PLIST="$HOME/Library/LaunchAgents/$TUNNEL_LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
UID_N="$(id -u)"
TUNNEL_NAME="valentine"
TUNNEL_CONFIG="$HOME/.cloudflared/config.yml"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$UID_N" "$PLIST" 2>/dev/null || true
  launchctl bootout "gui/$UID_N" "$TUNNEL_PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$TUNNEL_PLIST"
  echo "uninstalled: $LABEL + $TUNNEL_LABEL (the tunnel itself and its DNS record stay)"
  exit 0
fi

PRINT=0
if [ "${1:-}" = "--print" ]; then PRINT=1; shift; fi

PORT="${1:-3141}"
case "$PORT" in ''|*[!0-9]*)
  echo "port must be a number: $PORT" >&2; exit 1;;
esac

# launchd agents get a minimal PATH, so the plist needs an absolute cloudflared.
CLOUDFLARED="$(command -v cloudflared 2>/dev/null || true)"
[ -n "$CLOUDFLARED" ] || CLOUDFLARED="/opt/homebrew/bin/cloudflared"

slack_plist() {
  cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$REPO/scripts/slack-launchd.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VALENTINE_SLACK_PORT</key><string>$PORT</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/.valentine/slack.log</string>
  <key>StandardErrorPath</key><string>$HOME/.valentine/slack.log</string>
</dict>
</plist>
PLIST_EOF
}

tunnel_plist() {
  cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLOUDFLARED</string>
    <string>--config</string><string>$TUNNEL_CONFIG</string>
    <string>--no-autoupdate</string>
    <string>tunnel</string>
    <string>run</string>
    <string>$TUNNEL_NAME</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/.valentine/cloudflared.log</string>
  <key>StandardErrorPath</key><string>$HOME/.valentine/cloudflared.log</string>
</dict>
</plist>
PLIST_EOF
}

if [ "$PRINT" = 1 ]; then
  echo "# $PLIST"; slack_plist; echo
  echo "# $TUNNEL_PLIST"; tunnel_plist
  exit 0
fi

[ -x "$CLOUDFLARED" ] || {
  echo "cloudflared not found at $CLOUDFLARED — \`brew install cloudflared\` first." >&2; exit 1; }

if ! grep -qs '^tunnel:' "$TUNNEL_CONFIG" || ! grep -qs '^ingress:' "$TUNNEL_CONFIG"; then
  cat >&2 <<MSG
$TUNNEL_CONFIG has no tunnel/ingress stanza. Create the named tunnel once,
then write it (keep any lines already there, e.g. \`protocol: http2\`):

  cloudflared tunnel login
  cloudflared tunnel create $TUNNEL_NAME          # prints <UUID>, writes ~/.cloudflared/<UUID>.json
  cloudflared tunnel route dns $TUNNEL_NAME valentine.example.com

  # ~/.cloudflared/config.yml
  tunnel: <UUID>
  credentials-file: $HOME/.cloudflared/<UUID>.json
  ingress:
    - hostname: valentine.example.com
      service: http://localhost:$PORT
    - service: http_status:404
MSG
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.valentine"

slack_plist > "$PLIST"
tunnel_plist > "$TUNNEL_PLIST"

launchctl bootout "gui/$UID_N" "$PLIST" 2>/dev/null || true
launchctl bootout "gui/$UID_N" "$TUNNEL_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$PLIST"
launchctl bootstrap "gui/$UID_N" "$TUNNEL_PLIST"

echo "loaded: $LABEL — :$PORT · log: ~/.valentine/slack.log"
echo "loaded: $TUNNEL_LABEL — tunnel \"$TUNNEL_NAME\" · log: ~/.valentine/cloudflared.log"
echo "Slack app → Request URL + Interactivity Request URL: https://<your hostname>/ (any path; the server answers every POST)"
