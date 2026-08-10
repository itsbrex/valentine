// Model + provider registry and the client factory. The Anthropic API,
// local Ollama, and in-process ONNX are wired; Bedrock is listed but disabled.

import Anthropic from "@anthropic-ai/sdk";
import { resolveAuth } from "./auth.js";
import { OllamaClient } from "./ollama.js";
import { OnnxClient } from "./onnx.js";
import type { Config, OnnxDtype } from "./config.js";

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
/** LFM2.5-2.6B: free, open-weights, best-in-class tool calling at 2.6B.
 *  One-time setup: `ollama pull hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M`.
 *  Any other tool-calling model works too (llama3.1, qwen2.5…). */
export const DEFAULT_OLLAMA_MODEL = "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M";

/** In-process ONNX build of the same model — zero servers, zero keys.
 *  Needs `npm i -g @huggingface/transformers`; ~1.9 GB download on first run. */
export const DEFAULT_ONNX_MODEL = "LiquidAI/LFM2.5-2.6B-ONNX";
export const ONNX_DTYPES: readonly OnnxDtype[] = ["q4", "q4f16", "fp16", "q8"];
export const DEFAULT_ONNX_DTYPE: OnnxDtype = "q4";

export interface ProviderOption {
  id: string;
  label: string;
  enabled: boolean;
}
export const PROVIDERS: ProviderOption[] = [
  { id: "anthropic", label: "Anthropic API", enabled: true },
  { id: "ollama", label: "Local / Ollama (LFM2.5 default)", enabled: true },
  { id: "onnx", label: "Local / ONNX — LFM2.5 in-process, no server", enabled: true },
  { id: "bedrock", label: "AWS Bedrock", enabled: false },
];

export function makeClient(cfg: Config): ModelClient {
  if (cfg.provider === "ollama") return new OllamaClient(cfg.ollamaHost ?? DEFAULT_OLLAMA_HOST);
  if (cfg.provider === "onnx") return new OnnxClient(cfg.onnxDtype ?? DEFAULT_ONNX_DTYPE);
  const { apiKey } = resolveAuth(cfg);
  return new Anthropic({ apiKey });
}
