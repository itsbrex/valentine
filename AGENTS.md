# AGENTS.md — Valentine for autonomous agents

Machine-readable setup for AI agents (Claude Code, Hermes, openclaws, Cursor, …).
Valentine is **read-only**: it sweeps a VC fund's CRM and returns a pre-call
verdict. It never writes, sends, or moves anything.

## What it needs (env vars — no interactive prompts required)

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes* | Powers the agent loop. *Not needed with the Ollama provider. |
| `VALENTINE_ATTIO_KEY` | one CRM key | Read-only Attio token. |
| `VALENTINE_AFFINITY_KEY` | one CRM key | Use instead of the Attio key for Affinity. |
| `VALENTINE_SALESFORCE_KEY` | one CRM key | Salesforce REST access token (read-only user). |
| `VALENTINE_SALESFORCE_INSTANCE_URL` | with the SF key | e.g. `https://yourorg.my.salesforce.com`. |
| `VALENTINE_SALESFORCE_SID_COMMAND` | no | Instead of the SF key: shell command that prints a fresh access token (re-run on 401). |
| `VALENTINE_CRMS` | no | Sweep several CRMs, first is primary — e.g. `salesforce,attio` (company org + personal CRM). Needs each CRM's credentials. Multi-CRM JSON adds a `sources[]` array; exit code reflects the worst verdict. |
| `VALENTINE_MODEL` | no | Defaults to `claude-haiku-4-5`. |
| `VALENTINE_OLLAMA_HOST` | no | Ollama provider only. Wins over `OLLAMA_HOST` if both are set. |
| `OLLAMA_HOST` | no | Ollama provider only. Defaults to `http://127.0.0.1:11434`. |
| `VALENTINE_SLACK_SIGNING_SECRET` | for `valentine slack` | Slack app signing secret. Falls back to `SLACK_SIGNING_SECRET`. |
| `VALENTINE_SLACK_PORT` | no | Port for `valentine slack` (or `--port`). Defaults to `3141`. |
| `VALENTINE_SLACK_BOT_TOKEN` | for `watch --notify slack` | Bot token (scopes `chat:write` + `im:write`) for the DM notifier. |
| `VALENTINE_SLACK_DM_USER` | for `watch --notify slack` | Member ID (`U…`) the heads-up DMs go to. |

Set `ANTHROPIC_API_KEY` plus exactly one CRM key. Which CRM and which model
provider are *choices*, not secrets — they live in `~/.valentine/config.json`
and are set with headless `init` (below). To run fully local, init with
`--provider ollama` (a tool-calling model: llama3.1, qwen2.5…) — then no
Anthropic key is required and nothing leaves the machine.

## Install + one-shot verdict (headless)

> Published to npm as [`valentine-agent`](https://www.npmjs.com/package/valentine-agent).
> Full docs: https://tryvalentine.com/docs/

```bash
# No install step needed beyond npx; nothing is written until you run init.
export ANTHROPIC_API_KEY=sk-ant-...
export VALENTINE_ATTIO_KEY=...            # or VALENTINE_AFFINITY_KEY=...

npx valentine-agent --json acme.com       # prints JSON, sets an exit code
```

To persist config to `~/.valentine/config.json` without prompts:

```bash
npx valentine-agent init --non-interactive \
  --crm attio --crm-key "$VALENTINE_ATTIO_KEY" \
  --anthropic-key "$ANTHROPIC_API_KEY" --model claude-haiku-4-5

# Salesforce instead of Attio:
npx valentine-agent init -y --crm salesforce \
  --crm-key "$VALENTINE_SALESFORCE_KEY" \
  --instance-url "$VALENTINE_SALESFORCE_INSTANCE_URL" \
  --anthropic-key "$ANTHROPIC_API_KEY"

# Fully local via Ollama (no Anthropic key):
npx valentine-agent init -y --provider ollama --model llama3.1
```

`--non-interactive` is implied automatically when stdin is not a TTY, so in most
agent sandboxes you can omit it. The verdict command never prompts when `--json`
is set — it errors out with instructions instead.

## Output contract

`--json` prints one object to stdout:

```json
{
  "target": "acme.com",
  "verdict": "prior_contact",     // "clean" | "prior_contact" | "ambiguous"
  "summary": "Sarah emailed Acme's founder 3 weeks ago — logged 'passed, too early'.",
  "owner": "Sarah Lee",            // optional
  "lastTouch": "2026-05-12",       // optional
  "status": "passed, too early",   // optional
  "citations": ["rec_abc", "rec_def"]
}
```

Exit codes (use these to branch without parsing): `0` clean · `10` prior
contact · `20` ambiguous · `1` error.

## Native tool use (MCP)

For agents that speak MCP, mount the server instead of shelling out. It exposes
one tool, `valentine_verdict(target)`, returning the same JSON.

```bash
valentine mcp                          # stdio MCP server; reads the env vars above
# or with no install:
npx -y valentine-agent mcp
```

Example MCP client config (Claude Desktop / Cursor / any stdio MCP host):

```json
{
  "mcpServers": {
    "valentine": {
      "command": "npx",
      "args": ["-y", "valentine-agent", "mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "VALENTINE_ATTIO_KEY": "..."
      }
    }
  }
}
```

## Guarantees for the calling agent

- **Read-only.** No mutating method exists in the CRM connector contract.
- **Local.** Keys and data stay on the host; only the model call leaves.
- **Deterministic surface.** Same JSON shape + exit codes on every run.
