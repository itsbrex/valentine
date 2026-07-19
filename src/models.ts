// Model + provider registry and the client factory. The Anthropic API and
// local Ollama are wired; Bedrock is listed but disabled until implemented.

import Anthropic from "@anthropic-ai/sdk";
import { resolveAuth } from "./auth.js";
import { OllamaClient } from "./ollama.js";
import type { Config } from "./config.js";

/**
 * The sliver of the Anthropic Messages surface the agent loop actually uses.
 * Any provider that can produce text + tool_use blocks can implement it —
 * the Anthropic client satisfies it structurally, OllamaClient adapts to it.
 */
export interface ModelClient {
  messages: {
    create(req: {
      model: string;
      max_tokens: number;
      system: string;
      tools: Anthropic.Messages.ToolUnion[];
      messages: Anthropic.MessageParam[];
    }): Promise<{ content: Anthropic.ContentBlock[] }>;
  };
}

export interface ModelOption {
  id: string;
  label: string;
}
export const DEFAULT_MODEL = "claude-haiku-4-5";
export const MODELS: ModelOption[] = [
  { id: "claude-haiku-4-5", label: "Haiku — fast & cheap (recommended)" },
  { id: "claude-sonnet-4-6", label: "Sonnet — sharper, ~10× the cost" },
];

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
/** Any tool-calling model works (llama3.1, qwen2.5, mistral-nemo…). */
export const DEFAULT_OLLAMA_MODEL = "llama3.1";

export interface ProviderOption {
  id: string;
  label: string;
  enabled: boolean;
}
export const PROVIDERS: ProviderOption[] = [
  { id: "anthropic", label: "Anthropic API", enabled: true },
  { id: "ollama", label: "Local / Ollama", enabled: true },
  { id: "bedrock", label: "AWS Bedrock", enabled: false },
];

export function makeClient(cfg: Config): ModelClient {
  if (cfg.provider === "ollama") return new OllamaClient(cfg.ollamaHost ?? DEFAULT_OLLAMA_HOST);
  const { apiKey } = resolveAuth(cfg);
  return new Anthropic({ apiKey });
}
