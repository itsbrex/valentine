# ✦ Valentine

**Know before you walk in.** The open-source agent that remembers every founder
your fund has ever talked to — and reads your CRM the moment it matters.

```bash
npx valentine-agent init        # connect your CRM (read-only token)
npx valentine-agent acme.com    # one verdict before the call
```

> 📖 Full documentation: **https://80x-djh.github.io/valentine/**

You're about to take a founder call. You run `valentine acme.com`. Two seconds
later: *"⚠ Sarah emailed Acme's founder 3 weeks ago — logged 'passed, too early.'"*
Or a clean ✅. Then you walk in.

## Use it inside Claude (or Cursor, or any MCP host)

Valentine ships as an [MCP](https://modelcontextprotocol.io) server, so your AI
app can check the CRM for you mid-conversation — *"anything on acme.com before my
call?"* Add it to Claude Desktop's config (`~/Library/Application Support/Claude/
claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "valentine": { "command": "npx", "args": ["-y", "valentine-agent", "mcp"] }
  }
}
```

Restart Claude, set your keys once with `valentine init`, and ask away. Read-only,
on your machine — see [`AGENTS.md`](./AGENTS.md) for Cursor, Claude Code, etc.

## It reads. It never writes.

Valentine surfaces and warns — it never touches your data, sends a message, or
moves a deal. There are no write tools in the codebase, by design.

## How it works — three moving parts

1. **A connector** (`src/connectors/`) — read-only CRM access behind a small
   `CRMConnector` interface. Attio and Affinity out of the box; HubSpot /
   Salesforce are one new file away.
2. **An agent** (`src/agent.ts`) — the loop: model thinks → calls a read tool →
   gets the result → repeats → calls `submit_verdict`. ~40 lines, hand-rolled on
   the Anthropic API so you can read every line.
3. **A trigger** (`src/cli.ts`) — CLI today; `valentine watch` (calendar) and a
   Slack command on the roadmap.

The rules it runs by live in `src/prompt.ts`. Full design in [`SPEC.md`](./SPEC.md).

## Hand it to your agent

Valentine is built to be driven by other agents, not just typed by hand.

- **Headless CLI** — set the env vars and run `npx valentine-agent --json acme.com`.
  It never prompts under `--json` or a non-TTY, and exit codes encode the verdict
  (`0` clean · `10` prior contact · `20` ambiguous).
- **MCP server** — `valentine mcp` exposes one read-only tool,
  `valentine_verdict(target)`, for any MCP host (Claude Desktop, Cursor, Hermes,
  openclaws…).
- Full instructions for agents live in [`AGENTS.md`](./AGENTS.md).

## Your keys, your data

Runs with your CRM token, on your machine. Nothing leaves the fund. Keys are
stored locally at `~/.valentine/config.json` (or via env: `VALENTINE_ATTIO_KEY`,
`VALENTINE_AFFINITY_KEY`, `ANTHROPIC_API_KEY`).

## Develop

```bash
npm install
npm run dev -- acme.com
```

## License

MIT — clone it, read every line, fork it. No black box between you and your founders.
