# Local LLM support via LFM2.5-2.6B — design

**Date:** 2026-08-10
**Status:** Approved (interactive session, design approved before spec)
**Goal:** Run valentine sweeps with no Anthropic API key, using LiquidAI's
LFM2.5-2.6B — a free, open-weights, 2.6B-parameter agentic model with native
tool calling — through two local runtimes: the existing Ollama provider
(GGUF build) and a new in-process ONNX provider (the
[LiquidAI/LFM2.5-2.6B-ONNX](https://huggingface.co/LiquidAI/LFM2.5-2.6B-ONNX)
repo, via transformers.js).

## Background

valentine's agent loop talks to a `ModelClient` interface (`src/models.ts`) —
a sliver of the Anthropic Messages surface: `messages.create({model,
max_tokens, system, tools, messages}) → {content: ContentBlock[]}`. The
Anthropic SDK satisfies it structurally; `OllamaClient` (`src/ollama.ts`)
already adapts Ollama's `/api/chat` to it, including tool calls. So a keyless
local path exists today — this work makes LFM2.5 the recommended local model,
hardens the Ollama adapter for LFM2.5's output format, and adds a second,
zero-server local provider that runs the ONNX build in-process.

LFM2.5-2.6B specifics that drive the design:

- It is a reasoning model: output starts with `<think>…</think>` blocks that
  must be stripped before text reaches verdicts or conversation history.
- Tool calls are Pythonic — `func(arg="value", n=2)` — wrapped in
  `<|tool_call_start|>` / `<|tool_call_end|>` special tokens.
- Ollama's LFM template handling is flaky (ollama/ollama#15953): structured
  `tool_calls` sometimes don't come back and the raw markers appear in
  `message.content` instead.
- Published builds: GGUF (`LiquidAI/LFM2.5-2.6B-GGUF`, Q4_K_M ≈ 1.7 GB) and
  ONNX (q4 ≈ 1.9 GB, q4f16, fp16, q8), both open weights.

## Components

### 1. `src/lfm.ts` — shared LFM output plumbing (new)

One small module both local providers use:

- `stripThink(text: string): string` — removes `<think>…</think>` spans,
  including an unclosed leading `<think>` (truncated generations).
- `parseLfmToolCalls(text: string): {text: string, calls: {name: string,
  input: Record<string, unknown>}[]}` — extracts every
  `<|tool_call_start|>…<|tool_call_end|>` span. Each span is parsed as JSON
  first (some variants emit `{"name": …, "arguments": …}`), then as a
  Pythonic call: identifier + argument list with double- or single-quoted
  strings (with escapes), numbers, `true/false/True/False`, `null/None`.
  Unparseable spans degrade to `{}` input rather than throwing. Returns the
  remaining prose with spans removed.

### 2. Ollama route hardening (`src/ollama.ts`, `src/models.ts`)

- `DEFAULT_OLLAMA_MODEL` becomes `"hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M"`.
  Any other tool-calling model still works — this is only the default and the
  init suggestion. Setup is one command: `ollama pull
  hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M`.
- `OllamaClient.fromOllama()`:
  - strips think tags from `message.content`;
  - when Ollama returns no structured `tool_calls` but the content contains
    `<|tool_call_start|>`, runs `parseLfmToolCalls` and emits the recovered
    calls as `tool_use` blocks (the Ollama template-bug fallback).
- Init hint text updated to name LFM2.5 and the pull command.

### 3. `src/onnx.ts` — in-process ONNX provider (new)

- New provider id `"onnx"` (`Config.provider` union grows; `PROVIDERS` gains
  `{id: "onnx", label: "Local / ONNX (LFM2.5, in-process)", enabled: true}`).
- `OnnxClient implements ModelClient`. No server, no key, nothing leaves the
  machine.
- `@huggingface/transformers` is loaded with a lazy dynamic `import()` and is
  **not** a package dependency — valentine keeps its 4-dependency footprint
  and nobody downloads a ~100 MB onnxruntime binary they don't use. If the
  import fails, the error says exactly what to run:
  `npm i -g @huggingface/transformers` (global installs resolve because Node
  walks ancestor `node_modules`; local installs resolve normally).
- Defaults: model `LiquidAI/LFM2.5-2.6B-ONNX`, dtype `q4` (≈1.9 GB,
  auto-downloaded to the Hugging Face cache on first run). `Config` gains
  `onnxDtype?: "q4" | "q4f16" | "fp16" | "q8"`.
- Request path: Anthropic-shaped history → HF chat messages (system / user /
  assistant / tool roles, tool results serialized as tool-role messages) →
  `tokenizer.apply_chat_template(messages, {tools, add_generation_prompt:
  true})` (LFM2.5's chat template renders tool schemas natively) → generate
  with `max_new_tokens = req.max_tokens` and LiquidAI's recommended sampling
  (temperature 0.1, top-k 50, repeat penalty 1.05) → `stripThink` +
  `parseLfmToolCalls` → Anthropic-shaped content blocks.
- The tokenizer/model pipeline is created once and cached on the client
  instance — the CLI is one-shot, but the MCP server and `valentine watch`
  are long-lived and must not reload 1.9 GB per sweep.

### 4. CLI init (`src/cli.ts`)

- Interactive: provider select shows the ONNX option; choosing it prompts for
  model (default `LiquidAI/LFM2.5-2.6B-ONNX`) and dtype, and warns about the
  first-run download size and the `@huggingface/transformers` install.
- Headless: `--provider onnx` accepted; new `--onnx-dtype` flag; the existing
  "claude-* model makes no sense locally" swap applies to both local
  providers (each swapping in its own default).
- Ollama branch keeps its flow; only default model + hint text change.

### 5. Error handling

- ONNX import failure, model-download failure, and Ollama connection failure
  all surface actionable one-line errors. No provider ever silently falls
  back to Anthropic — a keyless setup must never produce surprise API calls.

### 6. Tests

- `lfm.ts` unit tests: think stripping (closed, unclosed, multiple), Pythonic
  arg parsing (strings with escapes, numbers, booleans, None), JSON-form
  calls, multiple calls in one message, unparseable span → `{}`.
- `OllamaClient` fallback: mocked `fetch` returning marker-laden content with
  no `tool_calls` → recovered `tool_use` blocks; think tags stripped.
- `OnnxClient`: message conversion and output parsing against a fake
  pipeline object (no model download in CI).
- Config/headless-init coverage for the new provider and flag.

### 7. Docs + operator config

- README gains a "run it free / no API key" section covering both paths.
- After merge: flip the operator's `~/.valentine/config.json` to a local
  provider (Ollama if installed, ONNX otherwise) and live-sweep hut8.com
  keyless — closing the ship-report row blocked on the placeholder
  `ANTHROPIC_API_KEY`.

## Out of scope

- Bedrock (still listed, still disabled), MLX build, WebGPU, any other local
  model families beyond documenting that Ollama accepts them.
- Streaming — the agent loop is non-streaming today; local providers match.

## Success criteria

- `valentine <domain>` completes a real multi-tool sweep with
  `provider: ollama` and with `provider: onnx`, no `ANTHROPIC_API_KEY` set.
- Full test suite green; no new runtime dependencies in `package.json`.
