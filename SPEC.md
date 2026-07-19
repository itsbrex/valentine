# Valentine — Feature Spec

> **Know before you walk in.** The open-source agent that remembers every founder
> your fund has talked to, and reads your CRM the moment it matters.

---

## 1. Product in one sentence

A **read-only** command-line agent that, given a founder or company, sweeps your
fund's CRM memory and returns **one verdict line** — *has anyone here touched this
before, who, when, and what happened* — fast enough to run in the 90 seconds before
a call.

## 2. Why it exists

The record exists. The note exists. The email is in someone's inbox. But it's
9:58am and the call is at 10:00, and you walk in blind — about to re-pitch a deal a
partner already passed on, or double-track a company someone owns. Valentine closes
that two-minute gap.

## 3. Goals / Non-goals

**Goals**
- Sub-10-second answer before a meeting.
- A *verdict*, not a search result. One line a partner reads and acts on.
- Trustworthy enough to point at a live CRM on day one: **read-only, auditable, local.**
- Bring-your-own-key. Nothing leaves the fund.
- CRM-agnostic by design (Attio first).

**Non-goals (v1)**
- ❌ Writing to the CRM (ever — see §9).
- ❌ Enrichment from external data sources (that's a different product).
- ❌ A hosted SaaS. Valentine runs locally with the user's own keys. (A managed
  offering may exist separately; it is out of scope for the OSS tool.)
- ❌ Deal scoring, pipeline analytics, reporting.

## 4. Users

- **Primary:** investors (partners, principals, associates) about to take a founder
  call who need to know if there's prior history.
- **Secondary:** the platform/ops person who installs it and wires the triggers for
  the partnership.

## 5. The verdict — the heart of the product

Every run resolves to exactly one of three outcomes:

| Outcome | When | Example |
|---|---|---|
| ⚠ **Prior contact** | A matching record has owner + history | `⚠ Sarah owns Acme — emailed founder May 11, logged "passed, too early."` |
| ✅ **Clean** | No matching record / no history | `✅ No prior contact on record.` |
| ❓ **Ambiguous** | Multiple weak matches, can't disambiguate | `❓ 2 possible matches — "Acme Inc" (Sarah) and "Acme Labs" (unowned).` |

A verdict always carries: **who** (owner), **when** (last touch), **what happened**
(status from notes), and the **record IDs** used (citations). Never a 40-row dump.

## 6. Commands / run modes

```
valentine <domain|name|linkedin-url>   # the 10-second gut-check (P0)
valentine init                         # connect CRM + pick model/auth (P0)
valentine mcp                          # stdio MCP server for agent hosts (shipped)
valentine slack                        # serve the /valentine slash command (P2 — shipped)
valentine watch                        # calendar trigger, heads-up before meetings (P1)
valentine --json <target>              # machine-readable verdict for scripting (P0)
valentine help | --version             # (P0)
```

The Slack trigger is a small webhook server: it verifies the app's signing
secret, acks within Slack's 3-second window, sweeps with the same read-only
agent, and answers through `response_url` — ephemeral, visible only to the
person who ran `/valentine`. No bot token; it cannot post on its own.

## 7. Onboarding (`valentine init`)

A branded, interactive wizard (the "feels like installing a real tool" moment):

1. **CRM** → Attio, Affinity, or Salesforce (HubSpot = "coming soon").
   Salesforce also asks for the instance URL.
2. **CRM API key** (read-only token encouraged) → tested live, shows workspace name.
3. **Model provider** → Anthropic API · Local (Ollama) — AWS Bedrock listed,
   disabled until wired. Ollama asks for host + model instead of an API key.
4. **Model** → e.g. `claude-haiku-4-5` (cheap, default), `claude-sonnet-4-6`;
   for Ollama any tool-calling model (llama3.1, qwen2.5…).
5. **Auth** → API key today. (Subscription/OAuth is a stubbed, clearly-labeled
   "not yet supported for third-party tools" slot — see §10.)
6. First-run: offer to run a sample sweep.

Config persists to `~/.valentine/config.json`; secrets may also come from env.

## 8. Architecture — three moving parts

```
TRIGGER ────────► AGENT ───► CONNECTOR ───► your CRM (read-only)
(cli/mcp/slack/   (loop +     (Attio ·
 watch)            tools +     Affinity ·
                   prompt)     Salesforce)
```

- **Connector** (`src/connectors/*`) — implements a small `CRMConnector` interface:
  `whoami()`, `search()`, `getContext()`. Attio, Affinity, and Salesforce ship;
  others slot in.
- **Agent** (`src/agent.ts`) — the loop: model → read tool → result → repeat →
  verdict. ~40 lines, hand-rolled against a minimal `ModelClient` surface —
  the Anthropic client satisfies it directly, and `src/ollama.ts` adapts local
  Ollama models to it. Model- and provider-swappable.
- **Trigger** (`src/cli.ts`, `src/mcp.ts`, `src/slack.ts`, later `src/watch.ts`)
  — how a sweep gets kicked off.

Design rule: **the agent and triggers never import a specific CRM** — only the
`CRMConnector` interface. Adding a CRM = one new file, zero changes elsewhere.

## 9. Safety guarantees (load-bearing for trust)

1. **Read-only, structurally.** No write tools exist in the codebase. The connector
   interface exposes no mutating methods. This is enforced by *absence*, not config.
2. **Never sends, never moves.** No messaging, no deal-stage changes, no emails.
3. **Local & BYO-key.** Keys live on the user's machine; data flows only between the
   user's CRM and the user's chosen model. No Valentine servers.
4. **Cited.** Every verdict references the record IDs it used.
5. **Auditable.** Small enough (~300 lines) that a fund's eng can read all of it.

## 10. Auth & models

- **Today (compliant):** `ANTHROPIC_API_KEY`, or a local Ollama model (no key —
  the sweep never leaves the machine). AWS Bedrock / GCP Vertex: not yet wired.
- **Cost:** a sweep is a few short tool round-trips + a one-line answer — roughly a
  cent or two on Sonnet, near-zero on Haiku, free on Ollama. Haiku is the default.
- **Subscription/OAuth:** a stubbed auth method, disabled with a clear message, in
  anticipation of Anthropic's post-2026-06-15 third-party terms. Flippable in one
  place (`src/auth.ts`) if/when those terms permit distribution.

## 11. Output

- **Human:** a colored verdict block (⚠ amber / ✅ green / ❓ grey), owner + last
  touch + status + "↗ open in CRM" link, then a one-line summary.
- **`--json`:** `{ verdict: "prior_contact|clean|ambiguous", summary, owner,
  last_touch, status, citations: [recordIds], crm_links: [...] }`.
- **Exit codes:** `0` clean · `10` prior contact · `20` ambiguous · `1` error.
  (Lets `watch`/Slack/scripts branch on the result.)

## 12. Errors & edge cases

- Bad/expired CRM key → clear message, re-run `init`.
- Object missing in workspace (no `deals`) → skip gracefully, don't fail.
- No match → that's a valid ✅ verdict, not an error.
- Rate limit / model error → surface plainly; never fabricate a verdict.
- Ambiguous input ("Acme") → search both companies and people; return ❓ if unsure.

## 13. Performance & cost targets

- p50 end-to-end < 8s on a warm key.
- ≤ 6 tool calls per sweep (search company, search people, read notes, done).
- Bounded fan-out: cap matches examined (e.g. top 10) and **say so** if truncated.

## 14. Roadmap / phasing

- **P0 (build now):** ~~CLI mode end-to-end, `init` with model/auth/CRM choice, Attio
  connector, verdict engine, `--json`, exit codes, error handling.~~ (done)
- **P1:** `valentine watch` — read calendar, DM a heads-up 30 min before external
  meetings (resolve attendee domains → sweep → notify).
- **P2:** ~~Slack slash command for the whole partnership.~~ (done — `valentine slack`)
- **P3:** ~~Affinity~~ (done) / ~~Salesforce~~ (done) / HubSpot connectors.
- **P4 (revisit):** subscription auth, if/when terms allow. AWS Bedrock provider.

## 15. Open questions

- Attio query filter syntax — confirm against a live workspace before publishing.
- Affinity field mappings — confirm against a live workspace. Auth + `/whoami`
  verified; still to verify on real data: `term` search hits, `interaction_dates`,
  and `list_entries` on the single-record GET. Note V1 exposes no org-level
  relationship *owner* or list *stage*, so those stay unresolved (verdict still
  fires on interaction dates / list membership / notes).
- Salesforce field mappings — confirm against a live org. Standard-objects-only
  (Account/Contact/Note/Task/Opportunity/Campaign via SOQL); access tokens expire
  with the Salesforce session, so a refresh story (connected-app OAuth) is open.
- Ollama verdict quality — small local models are noticeably weaker judges than
  Haiku on messy CRM data; worth a calibration pass and a recommended-models list.
- `watch` notification channel — Slack DM, macOS notification, or email? (The
  Slack signing-secret infra from `valentine slack` is reusable here.)
- ~~npm name~~ — resolved: published as `valentine-agent`.
- ~~Domain~~ — resolved: `tryvalentine.com`.
