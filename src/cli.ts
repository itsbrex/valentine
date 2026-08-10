#!/usr/bin/env node
// Valentine CLI.
//   valentine <domain|name>   sweep before a call
//   valentine init            connect CRM + choose model/auth
//   valentine watch           pre-meeting heads-up (roadmap)
//   valentine --json <target> machine-readable verdict
// Exit codes: 0 clean · 10 prior contact · 20 ambiguous · 1 error.

import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig, saveConfig, type Config } from "./config.js";
import { makeConnector, crmKey } from "./connectors/index.js";
import {
  makeClient,
  MODELS,
  PROVIDERS,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
} from "./models.js";
import { lookup } from "./agent.js";
import { renderVerdict, exitCodeFor, toJson } from "./output.js";
import { watch } from "./watch.js";
import { VERSION } from "./version.js";

const bail = (msg: string): never => {
  p.cancel(msg);
  process.exit(1);
};

/** Read `--name value` or `--name=value` from argv; undefined if absent. */
function getFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
  return undefined;
}

/** True when there's no human at the terminal, or the caller asked for it. */
function isHeadless(args: string[]): boolean {
  return args.includes("--non-interactive") || args.includes("-y") || !process.stdin.isTTY;
}

async function ask<T>(v: Promise<T | symbol>): Promise<T> {
  const r = await v;
  if (p.isCancel(r)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return r as T;
}

// Non-interactive setup, for agents and scripts. Reads flags first, then falls
// back to the env vars loadConfig() already understands. Writes config.json and
// validates that the two required keys are present — no prompts, ever.
function runInitHeadless(cfg: Config, args: string[]): void {
  const crm = (getFlag(args, "crm") as Config["crm"]) || cfg.crm;
  if (crm !== "attio" && crm !== "affinity" && crm !== "salesforce")
    bail(`--crm must be "attio", "affinity", or "salesforce"`);
  cfg.crm = crm;

  const key = getFlag(args, "crm-key") ?? getFlag(args, "key");
  if (key) {
    if (crm === "affinity") cfg.affinityKey = key;
    else if (crm === "salesforce") cfg.salesforceKey = key;
    else cfg.attioKey = key;
  }
  cfg.salesforceInstanceUrl = getFlag(args, "instance-url") ?? cfg.salesforceInstanceUrl;

  const provider = (getFlag(args, "provider") as Config["provider"]) || cfg.provider;
  if (provider !== "anthropic" && provider !== "ollama")
    bail(`--provider must be "anthropic" or "ollama"`);
  cfg.provider = provider;
  cfg.authMethod = "api_key";

  const model = getFlag(args, "model");
  if (model) cfg.model = model;
  cfg.anthropicKey = getFlag(args, "anthropic-key") ?? cfg.anthropicKey;
  if (provider === "ollama") {
    cfg.ollamaHost = getFlag(args, "ollama-host") ?? cfg.ollamaHost ?? DEFAULT_OLLAMA_HOST;
    // A claude-* model id makes no sense against Ollama — swap in the local default.
    if (!model && cfg.model.startsWith("claude-")) cfg.model = DEFAULT_OLLAMA_MODEL;
  }

  if (!crmKey(cfg))
    bail(`No ${crm} key. Pass --crm-key or set VALENTINE_${crm.toUpperCase()}_KEY.`);
  if (crm === "salesforce" && !cfg.salesforceInstanceUrl)
    bail("Salesforce needs --instance-url or VALENTINE_SALESFORCE_INSTANCE_URL.");
  if (provider === "anthropic" && !cfg.anthropicKey)
    bail("No Anthropic key. Pass --anthropic-key or set ANTHROPIC_API_KEY.");

  saveConfig(cfg);
  console.log(`valentine: configured (${cfg.crm} · ${cfg.model}). Try: valentine acme.com`);
}

async function runInit(cfg: Config, args: string[] = []): Promise<void> {
  if (isHeadless(args)) return runInitHeadless(cfg, args);

  console.clear();
  p.intro(pc.magenta(pc.bold("✦ Valentine")) + pc.dim("  — know before you walk in"));

  const crm = await ask(
    p.select({
      message: "Which CRM?",
      options: [
        { value: "attio", label: "Attio" },
        { value: "affinity", label: "Affinity" },
        { value: "salesforce", label: "Salesforce" },
        { value: "soon", label: "HubSpot", hint: "coming soon — PRs welcome" },
      ],
      initialValue: "attio",
    }),
  );
  if (crm === "soon") bail("HubSpot isn't supported yet — Attio, Affinity, and Salesforce are.");
  cfg.crm = crm as Config["crm"];

  const crmLabel = { attio: "Attio", affinity: "Affinity", salesforce: "Salesforce" }[cfg.crm];
  const key = await ask(
    p.password({
      message:
        cfg.crm === "salesforce"
          ? "Salesforce access token (a read-only user's is fine — try `sf org display --json`)"
          : `${crmLabel} API key (read-only is fine)`,
      validate: (v) => (v.length < 10 ? "That doesn't look like a key" : undefined),
    }),
  );
  if (cfg.crm === "affinity") cfg.affinityKey = key;
  else if (cfg.crm === "salesforce") cfg.salesforceKey = key;
  else cfg.attioKey = key;

  if (cfg.crm === "salesforce") {
    cfg.salesforceInstanceUrl = await ask(
      p.text({
        message: "Salesforce instance URL",
        placeholder: "https://yourorg.my.salesforce.com",
        initialValue: cfg.salesforceInstanceUrl ?? "",
        validate: (v) => (v.startsWith("https://") ? undefined : "Must be an https:// URL"),
      }),
    );
  }

  const s = p.spinner();
  s.start(`Connecting to ${crmLabel}`);
  try {
    const who = await makeConnector(cfg).whoami();
    s.stop(pc.green(`Connected to "${who.workspace}"`));
  } catch (e: any) {
    s.stop(pc.red("Connection failed"));
    bail(e.message);
  }

  const provider = await ask(
    p.select({
      message: "Model provider",
      options: PROVIDERS.map((pr) => ({
        value: pr.id,
        label: pr.label,
        hint: pr.enabled ? undefined : "coming soon",
      })),
      initialValue: cfg.provider as string,
    }),
  );
  if (!PROVIDERS.find((pr) => pr.id === provider)?.enabled)
    bail("That provider isn't wired yet — Anthropic API and local Ollama are.");

  if (provider === "ollama") {
    cfg.provider = "ollama";
    cfg.authMethod = "api_key"; // n/a for local — kept for config shape
    cfg.ollamaHost = await ask(
      p.text({
        message: "Ollama host",
        initialValue: cfg.ollamaHost ?? DEFAULT_OLLAMA_HOST,
      }),
    );
    cfg.model = await ask(
      p.text({
        message: "Ollama model (needs tool calling — llama3.1, qwen2.5…)",
        initialValue: cfg.model.startsWith("claude-") ? DEFAULT_OLLAMA_MODEL : cfg.model,
      }),
    );
    saveConfig(cfg);
    p.outro(pc.dim("Ready. Try:  ") + pc.cyan("valentine acme.com"));
    return;
  }
  cfg.provider = "anthropic";

  cfg.model = await ask(
    p.select({
      message: "Model",
      options: MODELS.map((m) => ({ value: m.id, label: m.label })),
      initialValue: DEFAULT_MODEL,
    }),
  );

  const auth = await ask(
    p.select({
      message: "Authentication",
      options: [
        { value: "api_key", label: "Anthropic API key", hint: "~a cent per sweep" },
        { value: "subscription", label: "Claude Pro/Max subscription", hint: "not allowed for third-party tools" },
      ],
      initialValue: "api_key",
    }),
  );
  if (auth === "subscription") {
    p.log.warn(
      "Anthropic restricts Pro/Max subscriptions to its own products (enforced since early 2026) — using an API key instead.",
    );
  }
  cfg.authMethod = "api_key";

  cfg.anthropicKey = await ask(p.password({ message: "Anthropic API key" }));

  saveConfig(cfg);
  p.outro(pc.dim("Ready. Try:  ") + pc.cyan("valentine acme.com"));
}

async function runLookup(cfg: Config, target: string, json: boolean): Promise<void> {
  if (!crmKey(cfg) || (cfg.provider === "anthropic" && !cfg.anthropicKey)) {
    // Don't launch an interactive wizard at an agent or a pipe — fail loud.
    if (json || isHeadless(process.argv.slice(2)))
      bail(
        "Not configured. Set VALENTINE_ATTIO_KEY (or VALENTINE_AFFINITY_KEY / " +
          "VALENTINE_SALESFORCE_KEY) and ANTHROPIC_API_KEY, or run `valentine init`.",
      );
    await runInit(cfg);
  }

  const crm = makeConnector(cfg);
  const client = makeClient(cfg);

  if (json) {
    const v = await lookup(client, cfg.model, crm, target);
    console.log(toJson(v, target));
    process.exit(exitCodeFor(v));
  }

  p.intro(pc.magenta(pc.bold("✦ Valentine")));
  const s = p.spinner();
  s.start(pc.dim(`sweeping fund memory for ${pc.bold(target)} — records · notes · last touch…`));
  let v;
  try {
    v = await lookup(client, cfg.model, crm, target);
  } catch (e: any) {
    s.stop(pc.red("Sweep failed"));
    bail(e.message);
  }
  s.stop(pc.green("done"));
  p.note(renderVerdict(v!), pc.bold(target));
  p.outro(pc.dim("read-only — nothing was touched."));
  process.exit(exitCodeFor(v!));
}

function printHelp(): void {
  console.log(
    pc.magenta(pc.bold("✦ Valentine")) +
      pc.dim(" — know before you walk in\n\n") +
      "Usage:\n" +
      `  ${pc.cyan("valentine <domain|name>")}     sweep the fund's memory before a call\n` +
      `  ${pc.cyan("valentine init")}              connect your CRM + choose a model\n` +
      `  ${pc.cyan("valentine mcp")}               run as an MCP server (Claude, Cursor…)\n` +
      `  ${pc.cyan("valentine slack")}             serve the /valentine slash command\n` +
      `  ${pc.cyan("valentine watch")}             pre-meeting heads-up (coming soon)\n\n` +
      "Flags:\n" +
      "  --json              machine-readable verdict\n" +
      "  --non-interactive   never prompt — for agents & scripts (alias -y)\n" +
      "  --crm <attio|affinity|salesforce> --crm-key <k> --instance-url <url>\n" +
      "  --provider <anthropic|ollama> --ollama-host <url> --anthropic-key <k> --model <m>\n" +
      "                      headless `init` inputs (or use env vars below)\n" +
      "  --port <n>          `slack` server port (default 3141)\n" +
      "  --version           print version\n" +
      "  --help              this help\n\n" +
      pc.dim(
        "Env: VALENTINE_ATTIO_KEY · VALENTINE_AFFINITY_KEY · VALENTINE_SALESFORCE_KEY (+_INSTANCE_URL)\n" +
          "     ANTHROPIC_API_KEY · OLLAMA_HOST · VALENTINE_MODEL · VALENTINE_SLACK_SIGNING_SECRET\n" +
          "Agents: see AGENTS.md, or run the MCP server with `valentine mcp`.\n" +
          "Exit codes: 0 clean · 10 prior contact · 20 ambiguous · 1 error",
      ),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("-"));
  const cmd = positional[0];
  const cfg = loadConfig();

  if (args.includes("--version") || cmd === "version") return void console.log(`valentine ${VERSION}`);
  if (cmd === "help" || args.includes("--help")) return printHelp();
  if (cmd === "init") return runInit(cfg, args);
  if (cmd === "mcp") return void (await import("./mcp.js")).runMcpServer();
  if (cmd === "slack") return void (await import("./slack.js")).runSlack(cfg, args);
  if (cmd === "watch") return watch();
  if (!cmd) return printHelp();

  await runLookup(cfg, cmd, json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
