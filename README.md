# ✦ Valentine

**Know before you walk in.** The open-source agent that remembers every founder
your fund has ever talked to — and reads your CRM the moment it matters.

```bash
npx valentine-agent init        # connect your CRM (read-only token)
npx valentine-agent acme.com    # one verdict before the call
```

> 📖 Full documentation: **https://tryvalentine.com/docs/**

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
   `CRMConnector` interface. Attio, Affinity, and Salesforce out of the box;
   HubSpot is one new file away.
2. **A brief** (`src/gather.ts` + `src/brief.ts`) — the default sweep. For a
   domain the reads are always the same, so Valentine does them itself:
   search → rank → context on the top matches. The verdict is a rule over that
   evidence (any real signal = prior contact), so it never depends on a model
   getting it right. The model makes exactly **one** call — the one-line
   summary — with a timeout, a template fallback, and a fact-check (an owner or
   a date the CRM didn't give us gets the line thrown out). Two CRMs on a local
   LFM2.5-2.6B: **5–7 s**, down from ~90 s. The original tool-calling loop
   (`src/agent.ts`) is still there behind `--strategy agent` for when you want
   the model to steer. Runs on Anthropic models or fully local ones — Ollama or
   in-process ONNX (then nothing leaves your machine at all).
3. **A trigger** (`src/cli.ts`) — the CLI, the MCP server, `valentine slack`
   (a `/valentine` slash command), and `valentine watch` — a pre-meeting
   heads-up that reads the macOS Calendar (including Outlook/M365 accounts
   added via Internet Accounts) and notifies you 30 minutes before external
   meetings.

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

## What you get back

Every surface renders the same structured brief — verdict, one line, the facts,
and click-to-act links (open the CRM record · website · LinkedIn):

- **CLI** — colored block, facts, links as real hyperlinks in terminals that
  support them (iTerm2, Terminal.app, WezTerm, kitty, VS Code). Add
  `--notify slack` to also DM yourself the brief.
- **`--json` / MCP** — `facts` (people, lists, notes, connection, dates) and
  `facts.links` next to the verdict, so agents can act without parsing prose.
- **Slack** — Block Kit for both the `/valentine` slash command and the
  `valentine watch --notify slack` heads-up: a header per meeting, a verdict
  line per attendee company, the summary, a field grid (owner · last touch ·
  stage · connection · known contacts), the latest note, and link buttons.
  Clean sources fold into one quiet line so the message stays short.

## Your keys, your data

Runs with your CRM token, on your machine. Nothing leaves the fund. Keys are
stored locally at `~/.valentine/config.json` (or via env: `VALENTINE_ATTIO_KEY`,
`VALENTINE_AFFINITY_KEY`, `VALENTINE_SALESFORCE_KEY` +
`VALENTINE_SALESFORCE_INSTANCE_URL`, `ANTHROPIC_API_KEY`).

Prefer a local model — and no Anthropic key at all? Two ways, both defaulting
to [LFM2.5-2.6B](https://huggingface.co/LiquidAI/LFM2.5-2.6B), a free
open-weights 2.6B model with best-in-class tool calling. Because the default
sweep asks the model for one sentence and nothing else, smaller Liquid models
work too — measured on the brief task with `node scripts/bench-models.mjs`
(M1 Max, one CRM):

| Ollama model | per call | size | notes |
|---|---|---|---|
| `hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M` (default) | ~1–2 s | 1.7 GB | best writing |
| `hf.co/LiquidAI/LFM2.5-8B-A1B-GGUF:Q4_K_M` | ~1 s | 5.2 GB | MoE (1B active); most faithful to the facts, drier prose |
| `hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q8_0` | ~0.5 s | 1.2 GB | reads fine, no `<think>` phase |
| `hf.co/LiquidAI/LFM2.5-350M-GGUF:Q8_0` | ~0.25 s | 380 MB | terse |

If `ollama pull hf.co/…` stalls, fetch the GGUF with the Hugging Face CLI and
register it: `hf download LiquidAI/LFM2.5-8B-A1B-GGUF LFM2.5-8B-A1B-Q4_K_M.gguf
--local-dir ~/models/lfm`, then a one-line Modelfile (`FROM ./LFM2.5-8B-A1B-Q4_K_M.gguf`)
and `ollama create lfm2.5-8b-a1b:q4 -f Modelfile`. Valentine detects on first
use whether a model reasons unconditionally (both LFM2.5 sizes do, one by
template, one by habit) and skips that phase with a prefill — cached in
`~/.valentine/model-traits.json`.

The verdict, owner, last touch, stage and links come from the CRM either way.
The model stays resident between sweeps (`VALENTINE_OLLAMA_KEEP_ALIVE`, default
24h) so a pre-meeting heads-up never waits on a load.

- **Ollama** (recommended) — `ollama pull hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M`
  (~1.7 GB), then pick the Ollama provider in `valentine init`. Needs Ollama
  ≥0.14 — older builds reject tool calling for this model.
- **In-process ONNX** — no server at all. Install the runtime next to valentine
  (`npm i -g @huggingface/transformers` if valentine is global, otherwise
  `npm i @huggingface/transformers` in your project), then pick the ONNX
  provider in `valentine init`. First run downloads ~1.9 GB to the Hugging Face
  cache. Simplest to set up, but noticeably slower per step than Ollama, which
  gets Metal/GPU acceleration — prefer Ollama if you have it.

See [`.env.example`](./.env.example) for the full env-var list.

## Develop

```bash
npm install
npm run dev -- acme.com
```

## License

MIT — clone it, read every line, fork it. No black box between you and your founders.
