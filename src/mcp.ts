#!/usr/bin/env node
// Valentine as an MCP server — the universal adapter. Any MCP-capable agent
// runtime (Hermes, openclaws, Claude Code/Desktop, Cursor…) can mount this and
// get one read-only tool: `valentine_verdict(target)`. The host agent sees a
// single tool call; the inner CRM-sweep loop stays hidden in `lookup`.
//
// Config comes from the same place the CLI uses: ~/.valentine/config.json or
// the env vars (VALENTINE_ATTIO_KEY / VALENTINE_AFFINITY_KEY / ANTHROPIC_API_KEY).
// Run it standalone with `valentine-mcp`. Still read-only: there is no write tool.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import { makeConnector, crmKey } from "./connectors/index.js";
import { makeClient } from "./models.js";
import { lookup } from "./agent.js";
import { toJson } from "./output.js";
import { VERSION } from "./version.js";

const TOOL = {
  name: "valentine_verdict",
  description:
    "Before a founder/company call, sweep the fund's CRM (read-only) and return a " +
    "verdict on whether anyone at the fund has touched this company or founder " +
    "before. Returns JSON: { target, verdict: 'clean'|'prior_contact'|'ambiguous', " +
    "summary, owner?, lastTouch?, status?, citations[] }. Never writes to the CRM.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Company domain (e.g. acme.com) or company/founder name.",
      },
    },
    required: ["target"],
  },
} as const;

const server = new Server(
  { name: "valentine", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL.name) throw new Error(`Unknown tool: ${req.params.name}`);

  const target = String((req.params.arguments as any)?.target ?? "").trim();
  if (!target) throw new Error("`target` is required (a domain or a name).");

  const cfg = loadConfig();
  if (!crmKey(cfg) || (cfg.provider === "anthropic" && !cfg.anthropicKey))
    throw new Error(
      "Valentine is not configured. Set a CRM key (VALENTINE_ATTIO_KEY / VALENTINE_AFFINITY_KEY / " +
        "VALENTINE_SALESFORCE_KEY + _INSTANCE_URL) and ANTHROPIC_API_KEY (or provider ollama) " +
        "in the server environment, or run `valentine init`.",
    );

  const verdict = await lookup(makeClient(cfg), cfg.model, makeConnector(cfg), target);
  const isError = verdict.verdict === "ambiguous";
  return {
    isError,
    content: [{ type: "text", text: toJson(verdict, target) }],
  };
});

/** Start the stdio MCP server. Used by the `valentine-mcp` bin and `valentine mcp`. */
export async function runMcpServer(): Promise<void> {
  await server.connect(new StdioServerTransport());
  // stderr only — stdout is the JSON-RPC channel and must stay clean.
  process.stderr.write(`valentine-mcp ${VERSION} ready (read-only)\n`);
}

// Auto-run only when invoked directly as the `valentine-mcp` bin, not on import.
const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  runMcpServer().catch((e) => {
    process.stderr.write(`valentine-mcp fatal: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
