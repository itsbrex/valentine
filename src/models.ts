// Model + provider registry and the client factory. Only the Anthropic API is
// wired today; Bedrock/Ollama are listed but disabled until implemented.

import Anthropic from "@anthropic-ai/sdk";
import { resolveAuth } from "./auth.js";
import type { Config } from "./config.js";

export interface ModelOption {
  id: string;
  label: string;
}
export const DEFAULT_MODEL = "claude-haiku-4-5";
export const MODELS: ModelOption[] = [
  { id: "claude-haiku-4-5", label: "Haiku — fast & cheap (recommended)" },
  { id: "claude-sonnet-4-6", label: "Sonnet — sharper, ~10× the cost" },
];

export interface ProviderOption {
  id: string;
  label: string;
  enabled: boolean;
}
export const PROVIDERS: ProviderOption[] = [
  { id: "anthropic", label: "Anthropic API", enabled: true },
  { id: "bedrock", label: "AWS Bedrock", enabled: false },
  { id: "ollama", label: "Local / Ollama", enabled: false },
];

export function makeClient(cfg: Config): Anthropic {
  const { apiKey } = resolveAuth(cfg);
  return new Anthropic({ apiKey });
}
