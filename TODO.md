# TODO — Salesforce from Claude Desktop

Exported from the 2026-08-10 working session. Context: the self-refreshing
Salesforce auth (`salesforceSidCommand`) and the MCP server are both built and
live-verified; what remains is wiring Valentine into Claude Desktop and making
one configuration decision.

## How the Salesforce check works

**Auth layer (live-verified).** `salesforceSidCommand` is any shell line that
prints a fresh access token. Ours runs
[salesforce-mcp-auto-auth-chrome](https://github.com/kugamon/salesforce-mcp-auto-auth-chrome),
which decrypts the browser cookie store via macOS Keychain and pulls the `sid`
cookie for `cresa.my.salesforce.com` — that cookie literally *is* a Salesforce
session token the REST API accepts as a Bearer. Valentine runs the command
lazily on first query, caches the token, and on a 401 re-runs it once and
retries. Net effect: as long as any browser tab stays logged into the org,
auth never goes stale and no secret is stored anywhere.

**Sweep layer.** The model (Haiku by default) drives a read-only loop with two
tools against SOQL:

- `search_crm` — companies hit `Account` (`Website LIKE '%domain%'` or
  `Name LIKE`), returning name, relationship owner (`Owner.Name`),
  `LastActivityDate`, linked-contact count. People hit `Contact` by name or
  email-domain (`Email LIKE '%@hut8.com'`).
- `get_context` — on a promising match: `Note` bodies + `Task`
  subjects/descriptions (logged calls/emails — where "passed, too early"
  lives), `Opportunity` + stage for companies, campaigns for people, linked
  contacts.

The model reads all that and calls `submit_verdict` →
`{verdict: clean|prior_contact|ambiguous, summary, owner, lastTouch, status,
citations}`. Restricted objects degrade to empty rather than crash, and the
connector contract has no write methods — it cannot touch the CRM.

## Using it from Claude Desktop

`valentine mcp` is a stdio MCP server exposing one tool,
`valentine_verdict(target)`. Two things to know first:

1. **npm's `valentine-agent` is still 0.1.0** (owner hasn't cut 0.2.0) — no
   Salesforce there. Claude Desktop must point at the local checkout.
2. **Config is single-CRM.** The server reads `~/.valentine/config.json`
   fresh on every call; the CRM choice lives there, not in env. Setting
   `crm=salesforce` flips **all** surfaces — including the launchd watch
   agent, which currently sweeps Attio.

### Steps

- [ ] **Decide the CRM question**: switch everything to Salesforce, or keep
      Attio for `watch` and use Salesforce ad hoc from the CLI only.
- [ ] If switching, persist the config (writes `~/.valentine/config.json`,
      0600; the sid command is stored, never a token):

  ```bash
  cd ~/github/valentine && set -a; source .env; set +a
  npm run dev -- init -y --crm salesforce \
    --instance-url https://cresa.my.salesforce.com \
    --sid-command '<the one-liner from backlog.md § browser-session auth>' \
    --anthropic-key "$ANTHROPIC_API_KEY"
  ```

- [ ] Add the server to
      `~/Library/Application Support/Claude/claude_desktop_config.json`
      (back it up first):

  ```json
  "valentine": {
    "command": "/Users/hack/.local/share/mise/shims/node",
    "args": [
      "/Users/hack/github/valentine/node_modules/.bin/tsx",
      "/Users/hack/github/valentine/src/mcp.ts"
    ]
  }
  ```

- [ ] Restart Claude Desktop (full ⌘Q) and ask:
      *"valentine, any prior contact with hut8.com?"*
- [ ] First call may pop one Keychain prompt ("Chrome Safe Storage") for the
      Desktop-spawned process — click **Always Allow**.
