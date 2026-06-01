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
import { makeClient, MODELS, PROVIDERS, DEFAULT_MODEL } from "./models.js";
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
  if (crm !== "attio" && crm !== "affinity") bail(`--crm must be "attio" or "affinity"`);
  cfg.crm = crm;

  const key = getFlag(args, "crm-key") ?? getFlag(args, "key");
  if (key) {
    if (crm === "affinity") cfg.affinityKey = key;
    else cfg.attioKey = key;
  }

  const model = getFlag(args, "model");
  if (model) cfg.model = model;
  cfg.anthropicKey = getFlag(args, "anthropic-key") ?? cfg.anthropicKey;
  cfg.provider = "anthropic";
  cfg.authMethod = "api_key";

  if (!crmKey(cfg))
    bail(`No ${crm} key. Pass --crm-key or set VALENTINE_${crm.toUpperCase()}_KEY.`);
  if (!cfg.anthropicKey) bail("No Anthropic key. Pass --anthropic-key or set ANTHROPIC_API_KEY.");

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
        { value: "soon", label: "HubSpot / Salesforce", hint: "coming soon — PRs welcome" },
      ],
      initialValue: "attio",
    }),
  );
  if (crm === "soon") bail("Only Attio and Affinity are supported today.");
  cfg.crm = crm as Config["crm"];

  const crmLabel = cfg.crm === "affinity" ? "Affinity" : "Attio";
  const key = await ask(
    p.password({
      message: `${crmLabel} API key (read-only is fine)`,
      validate: (v) => (v.length < 10 ? "That doesn't look like a key" : undefined),
    }),
  );
  if (cfg.crm === "affinity") cfg.affinityKey = key;
  else cfg.attioKey = key;

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
      initialValue: "anthropic",
    }),
  );
  if (!PROVIDERS.find((pr) => pr.id === provider)?.enabled) bail("Only the Anthropic API is supported today.");
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
        { value: "subscription", label: "Claude Pro/Max subscription", hint: "not yet allowed for third-party tools" },
      ],
      initialValue: "api_key",
    }),
  );
  if (auth === "subscription") {
    p.log.warn(
      "Anthropic doesn't permit third-party tools to use Pro/Max subscriptions yet — using an API key instead.",
    );
  }
  cfg.authMethod = "api_key";

  cfg.anthropicKey = await ask(p.password({ message: "Anthropic API key" }));

  saveConfig(cfg);
  p.outro(pc.dim("Ready. Try:  ") + pc.cyan("valentine acme.com"));
}

async function runLookup(cfg: Config, target: string, json: boolean): Promise<void> {
  if (!crmKey(cfg) || !cfg.anthropicKey) {
    // Don't launch an interactive wizard at an agent or a pipe — fail loud.
    if (json || isHeadless(process.argv.slice(2)))
      bail(
        "Not configured. Set VALENTINE_ATTIO_KEY (or VALENTINE_AFFINITY_KEY) and " +
          "ANTHROPIC_API_KEY, or run `valentine init`.",
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
      `  ${pc.cyan("valentine watch")}             pre-meeting heads-up (coming soon)\n\n` +
      "Flags:\n" +
      "  --json              machine-readable verdict\n" +
      "  --non-interactive   never prompt — for agents & scripts (alias -y)\n" +
      "  --crm <attio|affinity> --crm-key <k> --anthropic-key <k> --model <m>\n" +
      "                      headless `init` inputs (or use env vars below)\n" +
      "  --version           print version\n" +
      "  --help              this help\n\n" +
      pc.dim(
        "Env: VALENTINE_ATTIO_KEY · VALENTINE_AFFINITY_KEY · ANTHROPIC_API_KEY · VALENTINE_MODEL\n" +
          "Agents: see AGENTS.md, or run the MCP server with `valentine-mcp`.\n" +
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
  if (cmd === "watch") return watch();
  if (!cmd) return printHelp();

  await runLookup(cfg, cmd, json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
