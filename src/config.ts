// Per-user config at ~/.valentine/config.json. Secrets may also come from env
// (VALENTINE_ATTIO_KEY, VALENTINE_AFFINITY_KEY, VALENTINE_SALESFORCE_KEY +
// VALENTINE_SALESFORCE_INSTANCE_URL, ANTHROPIC_API_KEY, OLLAMA_HOST,
// VALENTINE_SLACK_SIGNING_SECRET). VALENTINE_MODEL overrides the model.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const DIR = join(homedir(), ".valentine");
const FILE = join(DIR, "config.json");

export interface Config {
  crm: "attio" | "affinity" | "salesforce";
  attioKey?: string;
  affinityKey?: string;
  salesforceKey?: string;
  salesforceInstanceUrl?: string;
  provider: "anthropic" | "ollama";
  model: string;
  authMethod: "api_key" | "subscription";
  anthropicKey?: string;
  ollamaHost?: string;
  slackSigningSecret?: string;
}

export function loadConfig(): Config {
  const base: Config = {
    crm: "attio",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    authMethod: "api_key",
  };
  if (existsSync(FILE)) Object.assign(base, JSON.parse(readFileSync(FILE, "utf8")));
  base.attioKey ??= process.env.VALENTINE_ATTIO_KEY;
  base.affinityKey ??= process.env.VALENTINE_AFFINITY_KEY;
  base.salesforceKey ??= process.env.VALENTINE_SALESFORCE_KEY;
  base.salesforceInstanceUrl ??= process.env.VALENTINE_SALESFORCE_INSTANCE_URL;
  base.anthropicKey ??= process.env.ANTHROPIC_API_KEY;
  base.ollamaHost ??= process.env.VALENTINE_OLLAMA_HOST ?? process.env.OLLAMA_HOST;
  base.slackSigningSecret ??=
    process.env.VALENTINE_SLACK_SIGNING_SECRET ?? process.env.SLACK_SIGNING_SECRET;
  if (process.env.VALENTINE_MODEL) base.model = process.env.VALENTINE_MODEL;
  return base;
}

export function saveConfig(cfg: Config) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2));
}
