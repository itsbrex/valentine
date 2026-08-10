#!/usr/bin/env node
// Valentine CLI.
//   valentine <domain|name>   sweep before a call
//   valentine init            connect CRM + choose model/auth
//   valentine watch           pre-meeting heads-up (roadmap)
//   valentine --json <target> machine-readable verdict
// Exit codes: 0 clean · 10 prior contact · 20 ambiguous · 1 error.

import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  loadConfig,
  saveConfig,
  parseCrms,
  activeCrms,
  CRM_IDS,
  type Config,
  type OnnxDtype,
} from "./config.js";
import { makeConnector, crmKey, missingCrmCreds } from "./connectors/index.js";
import { sweepAll, CRM_LABELS } from "./sweep.js";
import {
  makeClient,
  MODELS,
  PROVIDERS,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_ONNX_MODEL,
  DEFAULT_ONNX_DTYPE,
  ONNX_DTYPES,
} from "./models.js";
import { exitCodeFor, renderSweep, sweepToJson } from "./output.js";
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

  // --crms salesforce,attio → sweep several CRMs, first is primary.
  const crmsFlag = getFlag(args, "crms");
  if (crmsFlag) {
    const list = parseCrms(crmsFlag);
    if (!list.length) bail(`--crms must be a comma list of: ${CRM_IDS.join(", ")}`);
    cfg.crms = list;
    cfg.crm = list[0];
  }

  const key = getFlag(args, "crm-key") ?? getFlag(args, "key");
  if (key) {
    if (cfg.crm === "affinity") cfg.affinityKey = key;
    else if (cfg.crm === "salesforce") cfg.salesforceKey = key;
    else cfg.attioKey = key;
  }
  cfg.salesforceInstanceUrl = getFlag(args, "instance-url") ?? cfg.salesforceInstanceUrl;
  cfg.salesforceSidCommand = getFlag(args, "sid-command") ?? cfg.salesforceSidCommand;

  const provider = (getFlag(args, "provider") as Config["provider"]) || cfg.provider;
  if (provider !== "anthropic" && provider !== "ollama" && provider !== "onnx")
    bail(`--provider must be "anthropic", "ollama", or "onnx"`);
  cfg.provider = provider;
  cfg.authMethod = "api_key";

  const model = getFlag(args, "model");
  if (model) cfg.model = model;
  cfg.anthropicKey = getFlag(args, "anthropic-key") ?? cfg.anthropicKey;
  if (provider === "ollama") {
    cfg.ollamaHost = getFlag(args, "ollama-host") ?? cfg.ollamaHost ?? DEFAULT_OLLAMA_HOST;
    // A claude-* model id makes no sense against a local provider — swap in the default.
    if (!model && cfg.model.startsWith("claude-")) cfg.model = DEFAULT_OLLAMA_MODEL;
  }
  if (provider === "onnx") {
    const dtype = getFlag(args, "onnx-dtype");
    if (dtype) {
      if (!(ONNX_DTYPES as readonly string[]).includes(dtype))
        bail(`--onnx-dtype must be one of: ${ONNX_DTYPES.join(", ")}`);
      cfg.onnxDtype = dtype as OnnxDtype;
    }
    if (!model && cfg.model.startsWith("claude-")) cfg.model = DEFAULT_ONNX_MODEL;
  }

  const missing = missingCrmCreds(cfg);
  if (missing.length)
    bail(
      `Missing credentials for: ${missing.join(", ")}. Pass --crm-key / set the VALENTINE_*_KEY ` +
        "env vars (Salesforce: --instance-url plus a key or --sid-command).",
    );
  if (provider === "anthropic" && !cfg.anthropicKey)
    bail("No Anthropic key. Pass --anthropic-key or set ANTHROPIC_API_KEY.");

  saveConfig(cfg);
  console.log(
    `valentine: configured (${activeCrms(cfg).join(" + ")} · ${cfg.model}). Try: valentine acme.com`,
  );
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
  if (cfg.crm === "salesforce") {
    cfg.salesforceInstanceUrl = await ask(
      p.text({
        message: "Salesforce instance URL",
        placeholder: "https://yourorg.my.salesforce.com",
        initialValue: cfg.salesforceInstanceUrl ?? "",
        validate: (v) => (v.startsWith("https://") ? undefined : "Must be an https:// URL"),
      }),
    );
    const sfAuth = await ask(
      p.select({
        message: "Salesforce auth",
        options: [
          {
            value: "browser",
            label: "Browser session (macOS)",
            hint: "self-refreshing — a command mints tokens from your logged-in browser",
          },
          {
            value: "token",
            label: "Access token",
            hint: "`sf org display --json` · expires with the session",
          },
        ],
        initialValue: cfg.salesforceSidCommand ? "browser" : "token",
      }),
    );
    if (sfAuth === "browser") {
      // Stored as a command, not a secret — no token ever lands in config.json.
      cfg.salesforceSidCommand = await ask(
        p.text({
          message: "Command that prints a fresh access token (see backlog.md for a working one-liner)",
          initialValue: cfg.salesforceSidCommand ?? "",
          validate: (v) => (v.trim() ? undefined : "Enter a command — e.g. the salesforce-mcp-auto-auth-chrome one-liner"),
        }),
      );
      cfg.salesforceKey = undefined;
    } else {
      cfg.salesforceKey = await ask(
        p.password({
          message: "Salesforce access token (a read-only user's is fine — try `sf org display --json`)",
          validate: (v) => (v.length < 10 ? "That doesn't look like a key" : undefined),
        }),
      );
    }
  } else {
    const key = await ask(
      p.password({
        message: `${crmLabel} API key (read-only is fine)`,
        validate: (v) => (v.length < 10 ? "That doesn't look like a key" : undefined),
      }),
    );
    if (cfg.crm === "affinity") cfg.affinityKey = key;
    else cfg.attioKey = key;
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

  // Optional extra CRMs — e.g. company Salesforce primary with personal Attio
  // underneath. Only CRMs whose credentials already resolve (env/config) are
  // offered; configure others headlessly with --crms + env vars.
  const others = CRM_IDS.filter(
    (c) => c !== cfg.crm && crmKey(cfg, c) && (c !== "salesforce" || cfg.salesforceInstanceUrl),
  );
  if (others.length) {
    const extras = await ask(
      p.multiselect({
        message: "Also sweep these CRMs? (results show under the primary — optional)",
        options: others.map((c) => ({ value: c, label: CRM_LABELS[c] })),
        required: false,
      }),
    );
    cfg.crms = [cfg.crm, ...(extras as Config["crm"][])];
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
        message: "Ollama model (needs tool calling — LFM2.5 default, llama3.1, qwen2.5…)",
        initialValue: cfg.model.startsWith("claude-") ? DEFAULT_OLLAMA_MODEL : cfg.model,
      }),
    );
    p.note(
      "One-time model pull:\n  ollama pull hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M",
      "Heads up",
    );
    saveConfig(cfg);
    p.outro(pc.dim("Ready. Try:  ") + pc.cyan("valentine acme.com"));
    return;
  }
  if (provider === "onnx") {
    cfg.provider = "onnx";
    cfg.authMethod = "api_key"; // n/a for local — kept for config shape
    cfg.model = await ask(
      p.text({
        message: "ONNX model (Hugging Face repo)",
        initialValue: cfg.model.startsWith("claude-") ? DEFAULT_ONNX_MODEL : cfg.model,
      }),
    );
    cfg.onnxDtype = (await ask(
      p.select({
        message: "Quantization",
        options: [
          { value: "q4", label: "q4 — ~1.9 GB (recommended)" },
          { value: "q4f16", label: "q4f16 — ~1.5 GB" },
          { value: "fp16", label: "fp16 — ~2.1 GB" },
          { value: "q8", label: "q8 — ~2.1 GB" },
        ],
        initialValue: (cfg.onnxDtype ?? DEFAULT_ONNX_DTYPE) as string,
      }),
    )) as OnnxDtype;
    p.note(
      "First run downloads the model to the Hugging Face cache and needs\n" +
        "`npm i -g @huggingface/transformers` installed once.",
      "Heads up",
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
  const missing = missingCrmCreds(cfg);
  if (missing.length || (cfg.provider === "anthropic" && !cfg.anthropicKey)) {
    // Don't launch an interactive wizard at an agent or a pipe — fail loud.
    if (json || isHeadless(process.argv.slice(2)))
      bail(
        missing.length
          ? `Missing credentials for: ${missing.join(", ")}. Set the VALENTINE_*_KEY env vars ` +
              "(Salesforce: also _INSTANCE_URL, or a sid command), or run `valentine init`."
          : "No Anthropic key. Set ANTHROPIC_API_KEY or run `valentine init`.",
      );
    await runInit(cfg);
  }

  const client = makeClient(cfg);
  const crmNames = activeCrms(cfg).map((c) => CRM_LABELS[c]).join(" + ");

  if (json) {
    const res = await sweepAll(client, cfg, target);
    console.log(sweepToJson(res, target));
    process.exit(exitCodeFor(res.combined));
  }

  p.intro(pc.magenta(pc.bold("✦ Valentine")));
  const s = p.spinner();
  s.start(pc.dim(`sweeping ${crmNames} for ${pc.bold(target)} — records · notes · last touch…`));
  let res;
  try {
    res = await sweepAll(client, cfg, target);
  } catch (e: any) {
    s.stop(pc.red("Sweep failed"));
    bail(e.message);
  }
  s.stop(pc.green("done"));
  p.note(renderSweep(res!), pc.bold(target));
  p.outro(pc.dim("read-only — nothing was touched."));
  process.exit(exitCodeFor(res!.combined));
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
      `  ${pc.cyan("valentine watch")}             pre-meeting heads-up (macOS Calendar, incl. Outlook)\n\n` +
      "Flags:\n" +
      "  --json              machine-readable verdict\n" +
      "  --non-interactive   never prompt — for agents & scripts (alias -y)\n" +
      "  --crm <attio|affinity|salesforce> --crm-key <k> --instance-url <url>\n" +
      "  --crms <a,b>        sweep several CRMs, first is primary (e.g. salesforce,attio)\n" +
      "  --sid-command <cmd> Salesforce: command that prints a fresh token (self-refreshing)\n" +
      "  --provider <anthropic|ollama> --ollama-host <url> --anthropic-key <k> --model <m>\n" +
      "                      headless `init` inputs (or use env vars below)\n" +
      "  --port <n>          `slack` server port (default 3141)\n" +
      "  --once --lead <min> --interval <min> --notify <macos|fullscreen|stdout|slack>\n" +
      "                      `watch` options (defaults: 30 min lead, 5 min poll, macos)\n" +
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
  if (cmd === "watch") return watch(cfg, args);
  if (!cmd) return printHelp();

  await runLookup(cfg, cmd, json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
