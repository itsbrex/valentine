# Valentine — Backlog

Ideas parked for later. Not in scope for the current build.

## ~~Calendar integration (`valentine watch` — P1)~~ — SHIPPED 2026-08

Decisions made (recorded for transparency):

- **Calendar source: the macOS Calendar app via EventKit** (`src/calendar/macos.ts`),
  not Google Calendar OAuth. Rationale: everything the Calendar app syncs comes
  for free — including **Outlook/M365 added under System Settings → Internet
  Accounts → Microsoft Exchange**, which sidesteps needing Graph API admin
  consent entirely. Cheap, simple, documented in the docs page. The layer is
  provider-agnostic (`src/calendar/types.ts`); Google-API and .ics sources are
  one file each if ever needed.
- **Deliberately skipped: Google Calendar / Gmail / HubSpot work** — not in
  personal use here. The interfaces are where they'd plug in.
- **Notification channels shipped**: `macos` banner (terminal-notifier with the
  Valentine heart icon in `assets/valentine.png` when installed, AppleScript
  fallback), `fullscreen` (InYourFace-style magenta takeover), `stdout`.
- **Slack DM notifier — planned, not shipped.** Needs a bot token
  (`chat.postMessage` + a DM channel open), which the signing-secret-only
  `valentine slack` design deliberately avoids. Plan: optional
  `VALENTINE_SLACK_BOT_TOKEN` + `VALENTINE_SLACK_DM_USER`; when set, watch
  posts the same verdict lines via the Slack Web API as a fourth `--notify`
  channel. Keep the slash-command server token-free.
- **The Google-specific prep-event / `extendedProperties.private` design below
  stays parked** — it only applies if a Google Calendar source ever lands.
  With the macOS source, notifications replace calendar writes entirely, which
  also keeps Valentine's zero-write story intact (watch state lives in
  `~/.valentine/watch-state.json`, not on the calendar).

## Internal-only annotation on the calendar event (exploration)
Goal: attach Valentine's synopsis to a meeting **without other guests seeing it.**

Constraint: a shared event's `description` is visible to ALL guests. Google Calendar
has no per-attendee private note in the UI. So the viable mechanisms are:

1. **`extendedProperties.private`** (Google Calendar API)
   - Key/value attached to the requester's copy; never sent to other guests.
   - Truly invisible to guests, but API-only (not shown in the Calendar UI).
   - Best for: machine state ("already briefed"), storing the synopsis or a brief URL.

2. **Separate private prep event** (recommended for a *visible* internal brief)
   - Valentine creates a "✦ Prep: <Company>" event on the user's own calendar
     30 min prior, synopsis in its description. Private (no guests), human-visible,
     fully owned by us. No risk of leaking to the founder.

3. **Internal synopsis URL**
   - Host the brief at a team-gated page (e.g. valentine.80x.ai/brief/<id> behind
     team SSO). Either:
     - put the link in the shared description (guests see the link, can't open it), or
     - store it in `extendedProperties.private` + surface via the watch notifier or a
       browser extension (guests see nothing).

**Proposed clean combo:** watch mode → sweep → (a) create a private prep event /
DM with the synopsis, and (b) stamp `extendedProperties.private` on the real event
for idempotency + an internal brief URL. Guests never see anything.

Caveats to resolve later:
- This would be Valentine's first *write* — but to the **calendar**, never the CRM.
  Keep the CRM strictly read-only; gate calendar writes behind an explicit opt-in.
- Other calendar providers (Outlook/Microsoft 365) have analogous private
  extended-property mechanisms; design the calendar layer provider-agnostic like
  the CRM connector.

## Other
- ~~Slack slash command `/valentine acme.com` (P2).~~ Shipped — `valentine slack`.
- Additional CRM connectors: ~~Affinity~~ (shipped), ~~Salesforce~~ (shipped),
  HubSpot (P3).
- ~~Local models via Ollama.~~ Shipped — `--provider ollama`.
- AWS Bedrock provider (listed in `init`, disabled until wired).
- Salesforce token refresh — v1 takes a session access token that expires.
  See "Salesforce browser-session auth" below for the verified workaround and
  the integration plan; connected-app OAuth remains the production answer.

## Salesforce browser-session auth (verified 2026-08)

The expiring-token problem has a working local answer:
[`salesforce-mcp-auto-auth-chrome`](https://github.com/kugamon/salesforce-mcp-auto-auth-chrome)
(local checkout: `~/github/salesforce-mcp-auto-auth-chrome`). It reads the
`sid` cookie straight from a logged-in browser (Chrome, Comet, Arc, Edge,
Brave, Safari — decrypted via macOS Keychain), and that cookie IS a Salesforce
session id the REST API accepts as a Bearer token. Keep a tab logged into the
org and the session effectively never goes stale.

**Verified end-to-end against a live org** (`cresa.my.salesforce.com`, the
same instance the code-mode `salesforce-mcp` manual pins, with
`SALESFORCE_BROWSERS=comet,chrome,safari`): the wrapper's per-call
monkey-patch injected a fresh sid over a deliberately wrong construction-time
token, and Valentine's own `SalesforceConnector` ran `search()` +
`getContext()` successfully with a sid extracted the same way. One connector
bug surfaced and was fixed: `whoami()` assumed `Organization` is queryable;
some orgs return `INVALID_TYPE` for it, so it now falls back to the instance
hostname.

**Use it today (macOS, one line):**

```bash
VALENTINE_SALESFORCE_KEY=$(cd ~/github/salesforce-mcp-auto-auth-chrome && \
  uv run python -c "from salesforce_mcp_auto_auth_chrome.cookies import read_sid; \
  print(read_sid('https://yourorg.my.salesforce.com'))") \
VALENTINE_SALESFORCE_INSTANCE_URL=https://yourorg.my.salesforce.com \
valentine acme.com
```

**Integration plan (fixture it into the connector):**

1. Add an optional `salesforceSidCommand` config value — a shell command that
   prints a fresh access token (the one-liner above, or anything else).
2. `SalesforceConnector` runs it lazily on construction when no static key is
   set, and re-runs it once on a 401/`INVALID_SESSION_ID` before failing —
   mirroring the wrapper's per-call-refresh + retry design.
3. `valentine init --crm salesforce` offers "browser session (macOS)" as an
   auth choice and writes the command into config instead of a token, so no
   secret ever lands in `~/.valentine/config.json`.
4. Document the Keychain "Always Allow" prompt and the org IP-lock caveat
   (orgs with session-IP pinning need real connected-app OAuth instead).

Keeps Valentine dependency-free: the Python package stays external; the
connector only shells out to a user-configured command.
- Subscription auth (P4) — parked indefinitely. Anthropic restricts Pro/Max
  OAuth to its own products; enforced fully since April 2026. Stub stays in
  `src/auth.ts` should that ever reverse.
