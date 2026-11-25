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
- **Slack DM notifier — SHIPPED 2026-08** as the fourth `--notify` channel:
  `watch --notify slack` opens a DM (`conversations.open`) and posts the
  verdict lines (`chat.postMessage`) using `VALENTINE_SLACK_BOT_TOKEN`
  (scopes `chat:write` + `im:write`) + `VALENTINE_SLACK_DM_USER`. The
  slash-command server stays signing-secret-only and token-free — the two
  Slack surfaces are deliberately separate apps/credentials.
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

## Fast path + rich output — SHIPPED 2026-09-16

- **`strategy: brief` (default)** — deterministic CRM reads (`src/gather.ts`),
  rule-based verdict + fact-grounded one-line summary from a single structured
  model call (`src/brief.ts`), CRMs swept in parallel. Two-CRM sweep on local
  LFM2.5-2.6B: 5–7 s, was ~90 s; the "llama-server returned invalid tool call
  arguments" failures are gone because there are no tool calls. The agent loop
  stays behind `--strategy agent` / `VALENTINE_STRATEGY=agent`.
- **Ollama**: `structured()` uses a think-skipping prefill on LFM2.5 (its
  template opens `<think>` unconditionally; `think:false` is a no-op and the
  prefill cannot be combined with the `format` grammar), `format` on models that
  answer directly. `keep_alive` 24h, `num_ctx` 8192 by default.
- **Rich output**: `facts` + `links` on every verdict (Attio `web_url`,
  Salesforce Lightning URL, website, LinkedIn search); Block Kit for the watch
  DM and the slash command (`src/slackblocks.ts`); OSC 8 hyperlinks in the CLI;
  `valentine <target> --notify slack`.
- **Model choice**: `scripts/bench-models.mjs` compares local models on the
  exact call Valentine makes. Liquid 2.6B / 1.2B-Instruct / 350M all produce
  valid JSON; 2.6B writes best, 1.2B is the lean pick.
- Parked: Affinity record deep links (needs the tenant subdomain — `whoami`
  has it; wire it when someone on Affinity can verify the URL shape).
- LFM2.5-8B-A1B (MoE, 1B active) — landed via `hf download` + `ollama create`
  (`~/models/lfm`, registered `lfm2.5-8b-a1b:q4`). Its template does NOT open
  `<think>`, but the model does on its own, so template sniffing was not
  enough: `OllamaClient` now probes once per model (`think:false` + one word;
  a `thinking` field or leading `<think>` = forced) and caches the answer in
  `~/.valentine/model-traits.json`. Bench: ~1 s, 4/4 grounded, prose drier
  than the 2.6B. Listed in `init`; 2.6B stays default for the 1.7 GB footprint.

## Slack card v2 — SHIPPED 2026-09-18 (read-only half of the design)

The desired-state design (`valentine-slack-preview`: five states, link spec,
state matrix) is implemented for everything that can be a **link**:

- Every entity in the card links to its record: domain → Account/company,
  name → Contact/company, owner → SF User, "last touched" → the Task/Event
  (via the `ActivityHistories` subquery) or the Attio activity/emails tab,
  list/campaign → Campaign or Attio `/collection/{list_id}`, people → Contact /
  Attio person, opportunity → Opportunity. The connectors now return ids +
  URLs for all of these (`CRMMatch.parent/ownerUrl/views`,
  `CRMContext.peopleLinks/activities`, `ListMembership.url/kind/open`).
- State pills computed from facts: `9y 3m stale`, stage on an open
  Opportunity (🔥 Active deal), `owner unset` / `SF owner unassigned`
  (placeholder owners like "Unassigned Atlanta" count as a gap),
  `names differ across CRMs`, `<CRM> unreachable`.
- *Valentine says*: `next_step` added to the one structured model call, same
  grounding gate as the summary, template fallback per situation.
- Per-CRM action rows with prefilled Lightning forms (`/lightning/o/{Object}/new?defaultFieldValues=…`):
  Log call · New task · Log meeting on a hit; `＋ Lead` · `＋ Account` seeded
  from the other CRM's record when Salesforce has nothing. Attio has no
  prefilled-create URL and no `/search` route (verified: redirects home), so a
  clean Attio row offers the companies table.
- Salesforce auth failures are thrown and surfaced as `unreachable`
  (ambiguous) instead of being swallowed into a false `clean` — found while
  building this: an expired browser session made cyth.com read as clean.

## Slack card v2 — the interactive half — SHIPPED 2026-09-18 (opt-in)

Reopened on request the same day. Built as the separate, opt-in contract the
note below asked for rather than a flag on the read path:

- `src/writers/` (`CRMWriter`: create company/person/lead, claim owner, add
  note, log activity, cross-link, Attio `rematch`). `SalesforceWriter` shares
  the read connector's `SalesforceSession` (same sid command, same 401
  refresh); `AttioWriter` takes `attioWriteKey` / `VALENTINE_ATTIO_WRITE_KEY`
  so the read token can stay read-only. `makeWriter` returns nothing unless
  `writes: true` / `VALENTINE_WRITES=1` (`init --writes`).
- `valentine slack` is also the Interactivity Request URL: `block_actions`
  payloads are verified with the same signing secret (a comma list lets one
  server answer the slash app and the DM bot app), acked, and dispatched by
  `src/slackactions.ts`. `/valentine note <target> <text>` is the one write
  the slash command itself offers.
- Card (`targetBlocks(…, { interactive: { writes } })`): the `···` menu
  (Re-run sweep · Copy SF/Attio ID · Mute domain 30d · Mark handled — local
  state in `~/.valentine/mutes.json`, honoured by the watch loop) whenever the
  endpoint is up; with writes on, *＋ Create company + person* (Attio, seeded
  from the SF hit), *Claim owner* (owner gap), *Link IDs* (both CRMs, not yet
  cross-linked — detected from notes/description), *Fix Attio match* (name
  doesn't fit the domain: moves the domain to a new company, notes both), *＋
  Lead in Salesforce* / *＋ Company in Attio* / *Both + cross-link* when
  nothing is anywhere, and on the heads-up *Claim SF owner* / *Log to both
  CRMs*. Every write button carries a confirm dialog naming what is written.
- Calendar: `Meeting.url` (`ical://ekevent/<id>?method=show&options=more`)
  and `Meeting.joinUrl` (Zoom/Meet/Teams/Webex link from the URL field,
  location or notes) → *Open event* / *Join* on the heads-up.
- Still parked: *Snooze to T-5* and *Prep brief* (need the watch loop to
  re-notify / the Lab to post in-thread), Attio *Add note* as a button (a
  button can't take text without a modal, which needs a bot token — use
  `/valentine note`).

The original reasoning, kept for the record:

> The design's write-through buttons need (a) a Slack interactivity endpoint
> on `valentine slack` and (b) CRM **write** scopes. (b) contradicts the
> read-only contract (SPEC §"Read-only, structurally"; `CRMConnector` has no
> mutating method by design). If this is ever wanted it should be a separate,
> opt-in package with its own token, not a flag on Valentine.

## Salesforce depth from the ownership desk — SHIPPED 2026-09-18

Ported from `~/github/salesforced` (the CRE SF ownership desk) after an
inventory of every field it reads:

- **Leads.** `search()` for people also returns unconverted Leads (`Email` /
  `Website` by domain, `Name` / `Company` by name), marked `recordType: "Lead"`
  with Lead deep links; a restricted Lead object costs nothing.
- **Opportunity fields.** `Amount, CloseDate, Probability, Type, Owner.Name`
  plus the desk's CRE custom fields (`Size__c, Size_Type__c, Term_Months__c,
  Lease_Type__c`) — probed once per connector, dropping a tier on
  `INVALID_FIELD`, so orgs without them lose nothing. Surfaced as
  `ListMembership.amount/closeDate/owner/detail`, `$1.3M · closes … · 45,000
  SF · Office` pills on the card, and in the model's facts.
- **Open activities.** `OpenActivities` subquery, soonest first (the desk's
  `nextTask` picked the *latest* due date — a known bug there), as
  `CRMContext.upcoming` / `facts.nextActivity`; the template next step
  becomes "Glenn already has a call scheduled for … — coordinate".
- **Bug found live while porting:** for non-admin users Salesforce only
  accepts `ORDER BY ActivityDate DESC, LastModifiedDate DESC` on
  `ActivityHistories` (and `ASC, LastModifiedDate DESC` on `OpenActivities`);
  the previous `NULLS LAST` was a MALFORMED_QUERY "implementation
  restriction", so the "last touched" deep link had silently never resolved
  for the browser-session user. Fixed; errors now carry the `errorCode`.
- **Free-mail blocklist** moved into `gather.ts` (the desk's 18 domains + the
  newer providers): a personal-mail target only searches people.
- Not ported: the classic-search-page scraping (Valentine has SOQL), report
  harvesting, the "unassigned-region" ladder (the placeholder-owner gap
  already covers it), ZoomInfo columns.

## Other
- ~~Multi-CRM merge (showcase idea 9)~~ — shipped 2026-08 as multi-CRM sweeps:
  `crms: [primary, …]` in config / `VALENTINE_CRMS` env / `init --crms`. One
  agent loop per CRM, per-CRM blocks on every surface, worst-of combined
  verdict for exit codes and watch. Born from the real setup here: company
  Salesforce + personal Attio between JP and Brian.
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
`sid` cookie straight from a logged-in browser (Chrome, BrowserOS neo, Comet,
Arc, Edge, Brave, Safari — decrypted via macOS Keychain), and that cookie IS a Salesforce
session id the REST API accepts as a Bearer token. Keep a tab logged into the
org and the session effectively never goes stale.

**Verified end-to-end against a live org** (`cresa.my.salesforce.com`, the
same instance the code-mode `salesforce-mcp` manual pins, with
`SALESFORCE_BROWSERS=comet,chrome,safari`; since 2026-09-18 the local
setup scans `neo,comet,chrome,safari`, BrowserOS neo first): the wrapper's per-call
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

**Integration — SHIPPED 2026-08 (steps 1–3), docs here are step 4:**

1. ~~Optional `salesforceSidCommand` config value~~ — shipped: config field +
   `VALENTINE_SALESFORCE_SID_COMMAND` env + `init --sid-command` flag. Any
   shell command that prints a fresh access token (the one-liner above works).
2. ~~Lazy mint + 401 retry~~ — shipped: the connector runs the command on
   first use, caches the token, and on a 401 re-runs it once and retries the
   query — mirroring the wrapper's per-call-refresh design. Covered by tests
   (counter-command fixture asserts one mint, reuse, and the 401 re-mint).
3. ~~`valentine init` "browser session (macOS)" choice~~ — shipped: Salesforce
   auth select in init; the command is stored in config instead of a token, so
   no secret ever lands in `~/.valentine/config.json`.
4. Caveats (the docs step): the first cookie read triggers a macOS Keychain
   prompt — click **Always Allow**. Orgs with "lock sessions to the IP address
   from which they originated" reject browser sids — use real connected-app
   OAuth there. And the browser must hold a LIVE session: the extractor
   returns whatever cookie exists, so if you've been logged out server-side,
   every mint 401s until you sign back in.

Keeps Valentine dependency-free: the Python package stays external; the
connector only shells out to a user-configured command.
- Subscription auth (P4) — parked indefinitely. Anthropic restricts Pro/Max
  OAuth to its own products; enforced fully since April 2026. Stub stays in
  `src/auth.ts` should that ever reverse.
