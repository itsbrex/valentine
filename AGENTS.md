# AGENTS.md — Valentine for autonomous agents

Machine-readable setup for AI agents (Claude Code, Hermes, openclaws, Cursor, …).
Valentine is **read-only**: it sweeps a VC fund's CRM and returns a pre-call
verdict. It never writes, sends, or moves anything.

## What it needs (env vars — no interactive prompts required)

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Powers the agent loop. |
| `VALENTINE_ATTIO_KEY` | one CRM key | Read-only Attio token. |
| `VALENTINE_AFFINITY_KEY` | one CRM key | Use instead of the Attio key for Affinity. |
| `VALENTINE_MODEL` | no | Defaults to `claude-haiku-4-5`. |

Set `ANTHROPIC_API_KEY` plus exactly one of the two CRM keys.

## Install + one-shot verdict (headless)

> Published to npm as [`valentine-agent`](https://www.npmjs.com/package/valentine-agent).
> Full docs: https://80x-djh.github.io/valentine/docs/

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
