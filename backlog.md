# Valentine — Backlog

Ideas parked for later. Not in scope for the current build.

## Calendar integration (`valentine watch` — P1)
Read the user's calendar, resolve each external attendee's email domain, run the
read-only sweep, and surface a heads-up ~30 min before each external meeting.
- Auth: Google Calendar OAuth (per-user, local).
- Notification channel — open question: Slack DM vs macOS notification vs email.
- Must stay read-only on the CRM side (sweep only).

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
- Slack slash command `/valentine acme.com` (P2).
- Additional CRM connectors: Affinity, HubSpot, Salesforce (P3).
- Subscription auth, if/when Anthropic's third-party terms allow (P4).
