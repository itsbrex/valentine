// Per-user config at ~/.valentine/config.json. Secrets may also come from env
// (VALENTINE_ATTIO_KEY, VALENTINE_AFFINITY_KEY, ANTHROPIC_API_KEY).
// VALENTINE_MODEL overrides the model.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const DIR = join(homedir(), ".valentine");
const FILE = join(DIR, "config.json");

export interface Config {
  crm: "attio" | "affinity";
  attioKey?: string;
  affinityKey?: string;
  provider: "anthropic";
  model: string;
  authMethod: "api_key" | "subscription";
  anthropicKey?: string;
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
  base.anthropicKey ??= process.env.ANTHROPIC_API_KEY;
  if (process.env.VALENTINE_MODEL) base.model = process.env.VALENTINE_MODEL;
  return base;
}

export function saveConfig(cfg: Config) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2));
}
