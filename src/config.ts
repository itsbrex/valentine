// Per-user config at ~/.valentine/config.json. Secrets may also come from env
// (VALENTINE_ATTIO_KEY, VALENTINE_AFFINITY_KEY, VALENTINE_SALESFORCE_KEY +
// VALENTINE_SALESFORCE_INSTANCE_URL, ANTHROPIC_API_KEY, OLLAMA_HOST,
// VALENTINE_SLACK_SIGNING_SECRET). VALENTINE_MODEL overrides the model.
// Env-sourced values are never written back to disk, and the file itself is
// kept at 0600 inside a 0700 directory — it holds live credentials.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const DIR = join(homedir(), ".valentine");
const FILE = join(DIR, "config.json");

export type CrmId = "attio" | "affinity" | "salesforce";
export const CRM_IDS: readonly CrmId[] = ["attio", "affinity", "salesforce"];

/** Quantizations published in LiquidAI/LFM2.5-2.6B-ONNX. */
export type OnnxDtype = "q4" | "q4f16" | "fp16" | "q8";

export interface Config {
  crm: CrmId;
  /** Ordered list of CRMs to sweep — first is primary. Absent → just `crm`.
   *  Lets one run check the company org AND a personal CRM (e.g. Salesforce
   *  company-wide with personal Attio results underneath). */
  crms?: CrmId[];
  attioKey?: string;
  affinityKey?: string;
  salesforceKey?: string;
  salesforceInstanceUrl?: string;
  /** Shell command that prints a fresh Salesforce access token (e.g. a browser
   *  sid extractor). Used instead of a static key; re-run on 401. Not a secret. */
  salesforceSidCommand?: string;
  provider: "anthropic" | "ollama" | "onnx";
  model: string;
  authMethod: "api_key" | "subscription";
  anthropicKey?: string;
  ollamaHost?: string;
  /** ONNX quantization — q4 (~1.9 GB) unless overridden. */
  onnxDtype?: OnnxDtype;
  slackSigningSecret?: string;
}

// Values that came from the environment at load time, per config object.
// saveConfig() skips them so `valentine init` never copies env secrets into
// the file — a user who keeps keys in the environment stays file-clean.
const envSourced = new WeakMap<Config, Partial<Record<keyof Config, string>>>();

export function loadConfig(): Config {
  const base: Config = {
    crm: "attio",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    authMethod: "api_key",
  };
  if (existsSync(FILE)) Object.assign(base, JSON.parse(readFileSync(FILE, "utf8")));

  const fromEnv: Partial<Record<keyof Config, string>> = {};
  const fill = (key: keyof Config, value: string | undefined) => {
    if (base[key] == null && value != null) {
      (base as Record<keyof Config, unknown>)[key] = value;
      fromEnv[key] = value;
    }
  };
  fill("attioKey", process.env.VALENTINE_ATTIO_KEY);
  fill("affinityKey", process.env.VALENTINE_AFFINITY_KEY);
  fill("salesforceKey", process.env.VALENTINE_SALESFORCE_KEY);
  fill("salesforceInstanceUrl", process.env.VALENTINE_SALESFORCE_INSTANCE_URL);
  fill("salesforceSidCommand", process.env.VALENTINE_SALESFORCE_SID_COMMAND);
  fill("anthropicKey", process.env.ANTHROPIC_API_KEY);
  fill("ollamaHost", process.env.VALENTINE_OLLAMA_HOST ?? process.env.OLLAMA_HOST);
  fill(
    "slackSigningSecret",
    process.env.VALENTINE_SLACK_SIGNING_SECRET ?? process.env.SLACK_SIGNING_SECRET,
  );
  if (process.env.VALENTINE_MODEL) base.model = process.env.VALENTINE_MODEL;
  // VALENTINE_CRMS="salesforce,attio" — ordered, first is primary. The one
  // choice that's env-overridable, so an MCP host (Claude Desktop…) can run
  // multi-CRM with no config file at all.
  if (process.env.VALENTINE_CRMS) {
    const list = parseCrms(process.env.VALENTINE_CRMS);
    if (list.length) {
      base.crms = list;
      base.crm = list[0];
    }
  }

  envSourced.set(base, fromEnv);
  return base;
}

/** Parse a comma-separated CRM list, dropping unknowns and duplicates. */
export function parseCrms(raw: string): CrmId[] {
  const out: CrmId[] = [];
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase())) {
    if ((CRM_IDS as readonly string[]).includes(part) && !out.includes(part as CrmId))
      out.push(part as CrmId);
  }
  return out;
}

/** The CRMs a sweep runs against, in order — primary first, deduped. */
export function activeCrms(cfg: Config): CrmId[] {
  const list = cfg.crms?.length ? cfg.crms : [cfg.crm];
  return [...new Set(list)];
}

export function saveConfig(cfg: Config) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const fromEnv = envSourced.get(cfg) ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (value === undefined) continue;
    // Still the untouched env value → leave it in the environment. An explicit
    // value entered in init (even if identical-by-coincidence keys differ) persists.
    if (fromEnv[key as keyof Config] === value) continue;
    out[key] = value;
  }
  writeFileSync(FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
  // mode above only applies on create — repair perms for pre-existing installs.
  chmodSync(FILE, 0o600);
  chmodSync(DIR, 0o700);
}
