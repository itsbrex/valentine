# Keyless Local LLM (LFM2.5-2.6B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run valentine sweeps with no Anthropic API key using LiquidAI's LFM2.5-2.6B, through the existing Ollama provider (GGUF) and a new in-process ONNX provider.

**Architecture:** A shared `src/lfm.ts` module parses LFM2.5's output format (`<think>` reasoning, `<|tool_call_start|>` Pythonic tool calls). The Ollama adapter gains a fallback parse for Ollama's LFM template bug; a new `OnnxClient` runs `LiquidAI/LFM2.5-2.6B-ONNX` in-process via a lazily-imported `@huggingface/transformers`, satisfying the same `ModelClient` interface the agent loop already uses.

**Tech Stack:** TypeScript ESM, Node ≥18, `node:test` via `npx tsx --test`, `@huggingface/transformers` (lazy, NOT a package dependency).

**Spec:** `docs/superpowers/specs/2026-08-10-local-llm-lfm25-design.md`

## Global Constraints

- No new entries in `package.json` `dependencies` — `@huggingface/transformers` is loaded with dynamic `import()` only.
- No provider ever silently falls back to Anthropic; errors must be actionable one-liners.
- All source files are ESM with `.js` import specifiers (`import … from "./lfm.js"`).
- Run tests with `npx tsx --test test/<file>.test.ts` (full suite: `npm test`).
- Existing behavior for `provider: "anthropic"` must stay byte-identical.
- Comments follow the codebase style: short header block saying what/why, sparse inline comments only for non-obvious constraints.

---

### Task 1: `src/lfm.ts` — LFM2.5 output parser

**Files:**
- Create: `src/lfm.ts`
- Test: `test/lfm.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (Tasks 2 & 3 rely on these exact signatures):
  - `export interface LfmToolCall { name: string; input: Record<string, unknown> }`
  - `export function stripThink(text: string): string`
  - `export function parseLfmToolCalls(text: string): { text: string; calls: LfmToolCall[] }`

- [ ] **Step 1: Write the failing tests**

Create `test/lfm.test.ts`:

```typescript
// LFM2.5 output plumbing: <think> stripping and
// <|tool_call_start|>…<|tool_call_end|> tool-call parsing (Pythonic + JSON).

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripThink, parseLfmToolCalls } from "../src/lfm.js";

test("stripThink removes closed spans", () => {
  assert.equal(stripThink("<think>hmm</think>Hello"), "Hello");
  assert.equal(stripThink("a<think>x</think>b<think>y</think>c"), "abc");
});

test("stripThink removes an unclosed trailing span (truncated generation)", () => {
  assert.equal(stripThink("Hello<think>never closed"), "Hello");
});

test("stripThink leaves plain text alone", () => {
  assert.equal(stripThink("no tags here"), "no tags here");
});

test("parses a Pythonic call with string args", () => {
  const { text, calls } = parseLfmToolCalls(
    'Looking…<|tool_call_start|>search_crm(object="companies", domain="acme.com")<|tool_call_end|>',
  );
  assert.equal(text, "Looking…");
  assert.deepEqual(calls, [
    { name: "search_crm", input: { object: "companies", domain: "acme.com" } },
  ]);
});

test("parses numbers, booleans (both casings), and None/null", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>f(n=3, x=2.5, a=True, b=false, c=None, d=null)<|tool_call_end|>',
  );
  assert.deepEqual(calls[0].input, { n: 3, x: 2.5, a: true, b: false, c: null, d: null });
});

test("parses escaped quotes and single-quoted strings", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>f(s="he said \\"hi\\"", t=\'ok\')<|tool_call_end|>',
  );
  assert.deepEqual(calls[0].input, { s: 'he said "hi"', t: "ok" });
});

test("parses list and dict arguments", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>submit_verdict(verdict="clean", citations=["a", "b"], meta={"k": 1})<|tool_call_end|>',
  );
  assert.deepEqual(calls[0].input, {
    verdict: "clean",
    citations: ["a", "b"],
    meta: { k: 1 },
  });
});

test("parses the JSON call form", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>{"name": "search_crm", "arguments": {"domain": "acme.com"}}<|tool_call_end|>',
  );
  assert.deepEqual(calls, [{ name: "search_crm", input: { domain: "acme.com" } }]);
});

test("multiple calls in one message, prose preserved around them", () => {
  const { text, calls } = parseLfmToolCalls(
    'a <|tool_call_start|>f(x=1)<|tool_call_end|> b <|tool_call_start|>g(y=2)<|tool_call_end|>',
  );
  assert.equal(text, "a  b");
  assert.deepEqual(calls.map((c) => c.name), ["f", "g"]);
});

test("unparseable span degrades to empty input, not a throw", () => {
  const { calls } = parseLfmToolCalls("<|tool_call_start|>???<|tool_call_end|>");
  assert.deepEqual(calls, []);
});

test("no markers → text untouched, no calls", () => {
  const { text, calls } = parseLfmToolCalls("plain prose");
  assert.equal(text, "plain prose");
  assert.deepEqual(calls, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/lfm.test.ts`
Expected: FAIL — `Cannot find module '../src/lfm.js'`

- [ ] **Step 3: Implement `src/lfm.ts`**

```typescript
// LFM2.5 output plumbing, shared by the local providers (Ollama fallback +
// ONNX). The model reasons inside <think>…</think> and emits Pythonic tool
// calls — func(arg="value") — between <|tool_call_start|>/<|tool_call_end|>
// special tokens. Some variants emit the JSON form {"name":…, "arguments":…}
// instead, so that is tried first.

export interface LfmToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Remove <think> spans, including an unclosed trailing one (truncation). */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}

const CALL_RE = /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g;

/** Extract every tool-call span; returns remaining prose + parsed calls. */
export function parseLfmToolCalls(text: string): { text: string; calls: LfmToolCall[] } {
  const calls: LfmToolCall[] = [];
  const rest = text.replace(CALL_RE, (_, body: string) => {
    const call = parseCall(body.trim());
    if (call) calls.push(call);
    return "";
  });
  return { text: rest.trim(), calls };
}

function parseCall(body: string): LfmToolCall | null {
  try {
    const j = JSON.parse(body);
    if (j && typeof j.name === "string")
      return { name: j.name, input: (j.arguments ?? j.parameters ?? {}) as Record<string, unknown> };
  } catch {
    /* not the JSON form — try Pythonic */
  }
  const m = /^([A-Za-z_][\w.]*)\s*\(([\s\S]*)\)$/.exec(body);
  if (!m) return null;
  return { name: m[1], input: parseArgs(m[2]) };
}

/** Parse `key=value, …` with quoted strings, numbers, bools, None, [] / {}. */
function parseArgs(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  while (i < src.length) {
    skipWs();
    const key = /^[A-Za-z_]\w*/.exec(src.slice(i))?.[0];
    if (!key) break;
    i += key.length;
    skipWs();
    if (src[i] !== "=") break;
    i++;
    skipWs();
    const [value, next] = parseValue(src, i);
    out[key] = value;
    i = next;
    skipWs();
    if (src[i] === ",") i++;
  }
  return out;
}

function parseValue(src: string, i: number): [unknown, number] {
  const c = src[i];
  if (c === '"' || c === "'") {
    let s = "";
    let j = i + 1;
    while (j < src.length && src[j] !== c) {
      if (src[j] === "\\" && j + 1 < src.length) {
        s += src[j + 1];
        j += 2;
      } else s += src[j++];
    }
    return [s, j + 1];
  }
  if (c === "[" || c === "{") {
    // Take the balanced fragment, then JSON-parse (with Pythonic fixups).
    let depth = 0;
    let inStr: string | null = null;
    let j = i;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") {
        if (--depth === 0) {
          j++;
          break;
        }
      }
    }
    const frag = src.slice(i, j);
    try {
      return [JSON.parse(frag), j];
    } catch {
      try {
        return [JSON.parse(pythonToJson(frag)), j];
      } catch {
        return [frag, j];
      }
    }
  }
  let j = i;
  while (j < src.length && !/[,)\s]/.test(src[j])) j++;
  const tok = src.slice(i, j);
  if (tok === "true" || tok === "True") return [true, j];
  if (tok === "false" || tok === "False") return [false, j];
  if (tok === "null" || tok === "None") return [null, j];
  const num = Number(tok);
  return [Number.isNaN(num) ? tok : num, j];
}

/** Best-effort Python-literal → JSON: quotes, True/False/None. */
const pythonToJson = (s: string) =>
  s
    .replace(/'/g, '"')
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/lfm.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lfm.ts test/lfm.test.ts
git commit -m "feat: LFM2.5 output parser — think stripping + Pythonic/JSON tool calls"
```

---

### Task 2: Ollama route hardening

**Files:**
- Modify: `src/models.ts:36-38` (default model constant + comment)
- Modify: `src/ollama.ts` (`fromOllama`, header comment)
- Test: `test/ollama.test.ts` (create)

**Interfaces:**
- Consumes: `stripThink`, `parseLfmToolCalls` from `./lfm.js` (Task 1).
- Produces: `DEFAULT_OLLAMA_MODEL = "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M"` (Task 4's CLI uses it); `OllamaClient` behavior unchanged in shape.

- [ ] **Step 1: Write the failing tests**

Create `test/ollama.test.ts`:

```typescript
// OllamaClient against a stubbed fetch — no server. Covers the LFM2.5
// fallback: think-tag stripping and raw <|tool_call_start|> markers arriving
// in content when Ollama's template fails to emit structured tool_calls
// (ollama/ollama#15953).

import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaClient } from "../src/ollama.js";

function withFetch(payload: unknown, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

const req = {
  model: "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M",
  max_tokens: 300,
  system: "sys",
  tools: [] as never[],
  messages: [{ role: "user" as const, content: "check acme.com" }],
};

test("strips <think> and recovers marker-form tool calls from content", () =>
  withFetch(
    {
      message: {
        content:
          '<think>where to look…</think>Searching. <|tool_call_start|>search_crm(object="companies", domain="acme.com")<|tool_call_end|>',
      },
    },
    async () => {
      const { content } = await new OllamaClient("http://localhost:11434").messages.create(req);
      assert.deepEqual(
        content.map((b: { type: string }) => b.type),
        ["text", "tool_use"],
      );
      assert.equal((content[0] as { text: string }).text, "Searching.");
      const call = content[1] as { name: string; input: Record<string, unknown> };
      assert.equal(call.name, "search_crm");
      assert.deepEqual(call.input, { object: "companies", domain: "acme.com" });
    },
  ));

test("structured tool_calls still work, think stripped from prose", () =>
  withFetch(
    {
      message: {
        content: "<think>ok</think>Found it.",
        tool_calls: [{ function: { name: "get_details", arguments: { record_id: "r1" } } }],
      },
    },
    async () => {
      const { content } = await new OllamaClient("http://localhost:11434").messages.create(req);
      assert.equal((content[0] as { text: string }).text, "Found it.");
      const call = content[1] as { name: string; input: Record<string, unknown> };
      assert.equal(call.name, "get_details");
      assert.deepEqual(call.input, { record_id: "r1" });
    },
  ));

test("think-only content with no calls yields no empty text block", () =>
  withFetch({ message: { content: "<think>nothing</think>" } }, async () => {
    const { content } = await new OllamaClient("http://localhost:11434").messages.create(req);
    assert.deepEqual(content, []);
  }));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/ollama.test.ts`
Expected: FAIL — first test's `text` is the raw string with think tags/markers, third test gets a non-empty content array.

- [ ] **Step 3: Update `src/ollama.ts`**

Add the import at the top (after the existing imports):

```typescript
import { stripThink, parseLfmToolCalls } from "./lfm.js";
```

Replace the whole `fromOllama` method with:

```typescript
  /** Ollama response message → Anthropic-shaped content blocks. LFM2.5 emits
   *  <think> reasoning and sometimes raw <|tool_call_start|> markers in the
   *  content when Ollama's template drops structured tool_calls
   *  (ollama/ollama#15953) — strip the former, recover the latter. */
  private fromOllama(msg: any): Anthropic.ContentBlock[] {
    const blocks: any[] = [];
    const { text, calls } = parseLfmToolCalls(stripThink(String(msg?.content ?? "")));
    if (text) blocks.push({ type: "text", text, citations: null });
    for (const c of calls)
      blocks.push({ type: "tool_use", id: `ollama_call_${++this.toolSeq}`, name: c.name, input: c.input });
    for (const c of msg?.tool_calls ?? []) {
      const fn = c?.function ?? {};
      const input = typeof fn.arguments === "string" ? parseArgs(fn.arguments) : (fn.arguments ?? {});
      blocks.push({ type: "tool_use", id: `ollama_call_${++this.toolSeq}`, name: fn.name, input });
    }
    return blocks as Anthropic.ContentBlock[];
  }
```

Update the file's header comment first line list of models: replace
`Requires a tool-calling model: llama3.1, qwen2.5, mistral-nemo….` with
`Requires a tool-calling model — LFM2.5 (default), llama3.1, qwen2.5….`

- [ ] **Step 4: Update `src/models.ts` default**

Replace lines 36-38:

```typescript
export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
/** Any tool-calling model works (llama3.1, qwen2.5, mistral-nemo…). */
export const DEFAULT_OLLAMA_MODEL = "llama3.1";
```

with:

```typescript
export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
/** LFM2.5-2.6B: free, open-weights, best-in-class tool calling at 2.6B.
 *  One-time setup: `ollama pull hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M`.
 *  Any other tool-calling model works too (llama3.1, qwen2.5…). */
export const DEFAULT_OLLAMA_MODEL = "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M";
```

- [ ] **Step 5: Run the new tests, then the full suite**

Run: `npx tsx --test test/ollama.test.ts` — Expected: PASS (3 tests)
Run: `npm test` — Expected: all green (existing 39 + new)

- [ ] **Step 6: Commit**

```bash
git add src/ollama.ts src/models.ts test/ollama.test.ts
git commit -m "feat: LFM2.5 as Ollama default — think stripping + marker-form tool-call fallback"
```

---

### Task 3: `src/onnx.ts` — in-process ONNX client

**Files:**
- Create: `src/onnx.ts`
- Modify: `src/config.ts:31` (provider union), `src/config.ts:36` area (new field)
- Test: `test/onnx.test.ts`

**Interfaces:**
- Consumes: `stripThink`, `parseLfmToolCalls` from `./lfm.js` (Task 1); `ModelClient` from `./models.js`.
- Produces (Task 4 relies on):
  - `export class OnnxClient implements ModelClient` with
    `constructor(dtype: OnnxDtype, loader?: () => Promise<any>)`
  - `config.ts`: `Config.provider: "anthropic" | "ollama" | "onnx"`,
    `Config.onnxDtype?: OnnxDtype`, `export type OnnxDtype = "q4" | "q4f16" | "fp16" | "q8"`

- [ ] **Step 1: Update `src/config.ts` types**

Add above the `Config` interface (after the `CRM_IDS` export):

```typescript
/** Quantizations published in LiquidAI/LFM2.5-2.6B-ONNX. */
export type OnnxDtype = "q4" | "q4f16" | "fp16" | "q8";
```

Change the provider line inside `Config` from

```typescript
  provider: "anthropic" | "ollama";
```

to

```typescript
  provider: "anthropic" | "ollama" | "onnx";
```

and add after `ollamaHost?: string;`:

```typescript
  /** ONNX quantization — q4 (~1.9 GB) unless overridden. */
  onnxDtype?: OnnxDtype;
```

- [ ] **Step 2: Write the failing tests**

Create `test/onnx.test.ts`:

```typescript
// OnnxClient against a fake @huggingface/transformers module — no download,
// no native onnxruntime. Covers: chat-template invocation with tools, LFM
// output parsing, history round-trip (tool calls re-rendered as markers,
// tool results as tool-role messages), one-time model load, and the
// missing-dependency error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OnnxClient } from "../src/onnx.js";

function fakeTransformers(reply: string) {
  const seen = {
    chats: [] as { chat: unknown[]; opts: Record<string, unknown> }[],
    genOpts: [] as Record<string, unknown>[],
    loads: 0,
  };
  const tensor = (dims: number[]) => ({
    dims,
    slice: () => tensor(dims),
  });
  const tokenizer = {
    apply_chat_template: (chat: unknown[], opts: Record<string, unknown>) => {
      seen.chats.push({ chat, opts });
      return { input_ids: tensor([1, 7]), attention_mask: tensor([1, 7]) };
    },
    batch_decode: () => [reply],
  };
  const model = {
    generate: async (opts: Record<string, unknown>) => {
      seen.genOpts.push(opts);
      return tensor([1, 20]);
    },
  };
  const tf = {
    AutoTokenizer: {
      from_pretrained: async () => {
        seen.loads++;
        return tokenizer;
      },
    },
    AutoModelForCausalLM: { from_pretrained: async () => model },
  };
  return { seen, loader: async () => tf };
}

const baseReq = {
  model: "LiquidAI/LFM2.5-2.6B-ONNX",
  max_tokens: 300,
  system: "sys",
  tools: [
    { name: "search_crm", description: "search", input_schema: { type: "object" } },
  ] as never[],
  messages: [{ role: "user" as const, content: "check acme.com" }],
};

test("parses think + marker output into text and tool_use blocks", async () => {
  const { seen, loader } = fakeTransformers(
    '<think>hm</think>Searching. <|tool_call_start|>search_crm(domain="acme.com")<|tool_call_end|><|im_end|>',
  );
  const client = new OnnxClient("q4", loader);
  const { content } = await client.messages.create(baseReq);

  assert.deepEqual(content.map((b: { type: string }) => b.type), ["text", "tool_use"]);
  assert.equal((content[0] as { text: string }).text, "Searching.");
  const call = content[1] as { name: string; input: Record<string, unknown> };
  assert.equal(call.name, "search_crm");
  assert.deepEqual(call.input, { domain: "acme.com" });

  // Chat template got system + user + tools and a generation prompt.
  const { chat, opts } = seen.chats[0];
  assert.deepEqual((chat as { role: string }[]).map((m) => m.role), ["system", "user"]);
  assert.equal(opts.add_generation_prompt, true);
  assert.equal((opts.tools as unknown[]).length, 1);
  assert.equal(seen.genOpts[0].max_new_tokens, 300);
});

test("history round-trip: tool_use re-rendered as markers, results as tool role", async () => {
  const { seen, loader } = fakeTransformers("done<|im_end|>");
  const client = new OnnxClient("q4", loader);
  await client.messages.create({
    ...baseReq,
    messages: [
      { role: "user", content: "check acme.com" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          { type: "tool_use", id: "t1", name: "search_crm", input: { domain: "acme.com" } },
        ] as never,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: '[{"name":"Acme"}]' }] as never,
      },
    ],
  });
  const chat = seen.chats[0].chat as { role: string; content: string }[];
  assert.deepEqual(chat.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.match(chat[2].content, /<\|tool_call_start\|>search_crm\(/);
  assert.equal(chat[3].content, '[{"name":"Acme"}]');
});

test("model loads once across calls", async () => {
  const { seen, loader } = fakeTransformers("ok");
  const client = new OnnxClient("q4", loader);
  await client.messages.create(baseReq);
  await client.messages.create(baseReq);
  assert.equal(seen.loads, 1);
});

test("missing @huggingface/transformers → actionable error", async () => {
  const client = new OnnxClient("q4", async () => {
    throw new Error("Cannot find module");
  });
  await assert.rejects(
    () => client.messages.create(baseReq),
    /npm i -g @huggingface\/transformers/,
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test test/onnx.test.ts`
Expected: FAIL — `Cannot find module '../src/onnx.js'`

- [ ] **Step 4: Implement `src/onnx.ts`**

```typescript
// LFM2.5 in-process via ONNX — no server, no API key, nothing leaves the
// machine. Speaks the same tiny ModelClient surface as the Anthropic client.
// @huggingface/transformers is loaded lazily and is deliberately NOT a
// package dependency: it drags a ~100 MB onnxruntime binary that only ONNX
// users need. The model itself (~1.9 GB at q4) downloads to the Hugging Face
// cache on first run.

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./models.js";
import type { OnnxDtype } from "./config.js";
import { stripThink, parseLfmToolCalls } from "./lfm.js";

export class OnnxClient implements ModelClient {
  private toolSeq = 0;
  private ready?: Promise<{ tokenizer: any; model: any }>;

  constructor(
    private dtype: OnnxDtype,
    /** Injectable for tests — production always imports the real module. */
    private loader: () => Promise<any> = () => import("@huggingface/transformers" as string),
  ) {}

  /** Load tokenizer + model once per process — watch/MCP are long-lived. */
  private load(modelId: string) {
    this.ready ??= (async () => {
      let tf: any;
      try {
        tf = await this.loader();
      } catch {
        throw new Error(
          "The ONNX provider needs @huggingface/transformers — run " +
            "`npm i -g @huggingface/transformers` (or install it next to valentine) and retry.",
        );
      }
      const tokenizer = await tf.AutoTokenizer.from_pretrained(modelId);
      const model = await tf.AutoModelForCausalLM.from_pretrained(modelId, { dtype: this.dtype });
      return { tokenizer, model };
    })();
    return this.ready;
  }

  messages = {
    create: async (req: {
      model: string;
      max_tokens: number;
      system: string;
      tools: unknown;
      messages: Anthropic.MessageParam[];
    }): Promise<{ content: Anthropic.ContentBlock[] }> => {
      const { tokenizer, model } = await this.load(req.model);
      const inputs = tokenizer.apply_chat_template(toChat(req.system, req.messages), {
        tools: (req.tools as any[]).map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
        add_generation_prompt: true,
        return_dict: true,
      });
      const output = await model.generate({
        ...inputs,
        max_new_tokens: req.max_tokens,
        do_sample: false,
        repetition_penalty: 1.05,
      });
      // Decode only the new tokens, keeping special tokens — the tool-call
      // markers ARE special tokens.
      const newTokens = output.slice(null, [inputs.input_ids.dims.at(-1), null]);
      const raw: string = tokenizer.batch_decode(newTokens, { skip_special_tokens: false })[0] ?? "";

      const { text, calls } = parseLfmToolCalls(stripThink(raw));
      const blocks: any[] = [];
      const prose = text.replace(/<\|[^|]*\|>/g, "").trim(); // scrub leftover specials (<|im_end|>…)
      if (prose) blocks.push({ type: "text", text: prose, citations: null });
      for (const c of calls)
        blocks.push({ type: "tool_use", id: `onnx_call_${++this.toolSeq}`, name: c.name, input: c.input });
      return { content: blocks as Anthropic.ContentBlock[] };
    },
  };
}

/** Anthropic-shaped history → HF chat messages. Assistant tool calls are
 *  re-rendered in LFM's own marker syntax so the template sees the same
 *  format the model emits; tool results become tool-role messages. */
function toChat(system: string, messages: Anthropic.MessageParam[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const blocks = m.content as any[];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => pyCall(b.name, b.input ?? {}));
      out.push({ role: "assistant", content: [text, ...calls].filter(Boolean).join("\n") });
    } else {
      for (const b of m.content as any[]) {
        if (b.type === "tool_result")
          out.push({
            role: "tool",
            content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
          });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

const pyCall = (name: string, input: Record<string, unknown>) =>
  `<|tool_call_start|>${name}(${Object.entries(input)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ")})<|tool_call_end|>`;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test test/onnx.test.ts` — Expected: PASS (4 tests)
Run: `npm test` — Expected: all green

- [ ] **Step 6: Commit**

```bash
git add src/onnx.ts src/config.ts test/onnx.test.ts
git commit -m "feat: in-process ONNX provider — LFM2.5-2.6B via lazy @huggingface/transformers"
```

---

### Task 4: Provider registry wiring

**Files:**
- Modify: `src/models.ts` (constants, `PROVIDERS`, `makeClient`)

**Interfaces:**
- Consumes: `OnnxClient` (Task 3), `OnnxDtype` from `./config.js`.
- Produces (Task 5's CLI uses): `DEFAULT_ONNX_MODEL = "LiquidAI/LFM2.5-2.6B-ONNX"`, `DEFAULT_ONNX_DTYPE: OnnxDtype = "q4"`, `ONNX_DTYPES: readonly OnnxDtype[]`, `PROVIDERS` with an enabled `onnx` entry, `makeClient` returning `OnnxClient` for `provider === "onnx"`.

- [ ] **Step 1: Update `src/models.ts`**

Add the import:

```typescript
import { OnnxClient } from "./onnx.js";
import type { Config, OnnxDtype } from "./config.js";
```

(replacing the existing `import type { Config } from "./config.js";`)

After the `DEFAULT_OLLAMA_MODEL` block, add:

```typescript
/** In-process ONNX build of the same model — zero servers, zero keys.
 *  Needs `npm i -g @huggingface/transformers`; ~1.9 GB download on first run. */
export const DEFAULT_ONNX_MODEL = "LiquidAI/LFM2.5-2.6B-ONNX";
export const ONNX_DTYPES: readonly OnnxDtype[] = ["q4", "q4f16", "fp16", "q8"];
export const DEFAULT_ONNX_DTYPE: OnnxDtype = "q4";
```

Update `PROVIDERS`:

```typescript
export const PROVIDERS: ProviderOption[] = [
  { id: "anthropic", label: "Anthropic API", enabled: true },
  { id: "ollama", label: "Local / Ollama (LFM2.5 default)", enabled: true },
  { id: "onnx", label: "Local / ONNX — LFM2.5 in-process, no server", enabled: true },
  { id: "bedrock", label: "AWS Bedrock", enabled: false },
];
```

Update `makeClient`:

```typescript
export function makeClient(cfg: Config): ModelClient {
  if (cfg.provider === "ollama") return new OllamaClient(cfg.ollamaHost ?? DEFAULT_OLLAMA_HOST);
  if (cfg.provider === "onnx") return new OnnxClient(cfg.onnxDtype ?? DEFAULT_ONNX_DTYPE);
  const { apiKey } = resolveAuth(cfg);
  return new Anthropic({ apiKey });
}
```

Also update the file's header comment (line 1-2) to:

```typescript
// Model + provider registry and the client factory. The Anthropic API,
// local Ollama, and in-process ONNX are wired; Bedrock is listed but disabled.
```

- [ ] **Step 2: Type-check and run the suite**

Run: `npx tsc --noEmit` — Expected: clean
Run: `npm test` — Expected: all green

- [ ] **Step 3: Commit**

```bash
git add src/models.ts
git commit -m "feat: register onnx provider in the model registry"
```

---

### Task 5: CLI init — headless + interactive

**Files:**
- Modify: `src/cli.ts:81-94` (headless), `src/cli.ts:216-248` (interactive)
- Test: `test/cli-init.test.ts` (create)

**Interfaces:**
- Consumes: `DEFAULT_ONNX_MODEL`, `DEFAULT_ONNX_DTYPE`, `ONNX_DTYPES`, `DEFAULT_OLLAMA_MODEL` from `./models.js`; `OnnxDtype` from `./config.js`.
- Produces: `valentine init --provider onnx [--onnx-dtype q4|q4f16|fp16|q8]` headless path; interactive ONNX branch.

- [ ] **Step 1: Write the failing test**

Create `test/cli-init.test.ts`:

```typescript
// Headless `valentine init --provider onnx` end-to-end via a subprocess with
// HOME pointed at a temp dir (config lands in $HOME/.valentine/config.json).
// stdin is not a TTY under execFileSync, so init is headless automatically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("init --provider onnx writes provider, default model, and dtype", () => {
  const home = mkdtempSync(join(tmpdir(), "valentine-test-"));
  execFileSync(
    "npx",
    [
      "tsx", "src/cli.ts", "init",
      "--provider", "onnx",
      "--onnx-dtype", "q4f16",
      "--crm", "attio",
      "--crm-key", "test-key-0123456789",
    ],
    { env: { ...process.env, HOME: home }, stdio: "pipe" },
  );
  const cfg = JSON.parse(readFileSync(join(home, ".valentine", "config.json"), "utf8"));
  assert.equal(cfg.provider, "onnx");
  assert.equal(cfg.model, "LiquidAI/LFM2.5-2.6B-ONNX");
  assert.equal(cfg.onnxDtype, "q4f16");
});

test("init --provider onnx rejects a bad dtype", () => {
  const home = mkdtempSync(join(tmpdir(), "valentine-test-"));
  assert.throws(() =>
    execFileSync(
      "npx",
      ["tsx", "src/cli.ts", "init", "--provider", "onnx", "--onnx-dtype", "q2",
       "--crm", "attio", "--crm-key", "test-key-0123456789"],
      { env: { ...process.env, HOME: home }, stdio: "pipe" },
    ),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/cli-init.test.ts`
Expected: FAIL — `--provider must be "anthropic" or "ollama"` in the subprocess stderr.

- [ ] **Step 3: Update the headless path in `src/cli.ts`**

Extend the imports from `./models.js` to include the new constants:

```typescript
import {
  makeClient, MODELS, DEFAULT_MODEL, PROVIDERS,
  DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_MODEL,
  DEFAULT_ONNX_MODEL, DEFAULT_ONNX_DTYPE, ONNX_DTYPES,
} from "./models.js";
```

(match the file's existing import statement shape — extend it, don't duplicate.)
Also add `OnnxDtype` to the type imports from `./config.js`.

Replace `src/cli.ts:81-94` (provider block through the ollama claude-swap) with:

```typescript
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
```

- [ ] **Step 4: Update the interactive path**

In `runInit`, after the existing `if (provider === "ollama") { … }` block (which needs one text tweak — change the model prompt message to `"Ollama model (needs tool calling — LFM2.5 default, llama3.1, qwen2.5…)"` and its `initialValue` claude-swap already handles the new default), add the ONNX branch before the `cfg.provider = "anthropic";` line:

```typescript
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
        initialValue: cfg.onnxDtype ?? DEFAULT_ONNX_DTYPE,
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
```

Also update the Ollama interactive branch's model prompt hint as described, and add a matching `p.note` there:

```typescript
    p.note(
      "One-time model pull:\n  ollama pull hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M",
      "Heads up",
    );
```

(insert it just before that branch's `saveConfig(cfg);`.)

- [ ] **Step 5: Run tests**

Run: `npx tsx --test test/cli-init.test.ts` — Expected: PASS (2 tests)
Run: `npm test` — Expected: all green
Run: `npx tsc --noEmit` — Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli-init.test.ts
git commit -m "feat: onnx provider in init — headless flags + interactive flow"
```

---

### Task 6: Docs

**Files:**
- Modify: `README.md:69-76` ("Your keys, your data"), `README.md:45-48` (agent bullet)
- Modify: `src/config.ts:1-6` (header comment env list)

**Interfaces:** none — prose only.

- [ ] **Step 1: Update README**

In the "How it works" agent bullet (README.md:45-48), replace
`Runs on Anthropic models or a local Ollama model (then nothing leaves your machine at all).`
with
`Runs on Anthropic models or fully local ones — Ollama or in-process ONNX (then nothing leaves your machine at all).`

Replace the last two sentences of "Your keys, your data" (README.md:74-76) with:

```markdown
Prefer a local model — and no Anthropic key at all? Two ways, both defaulting
to [LFM2.5-2.6B](https://huggingface.co/LiquidAI/LFM2.5-2.6B), a free
open-weights 2.6B model with best-in-class tool calling:

- **Ollama** — `ollama pull hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M` (~1.7 GB),
  then pick the Ollama provider in `valentine init`.
- **In-process ONNX** — no server at all: `npm i -g @huggingface/transformers`,
  then pick the ONNX provider in `valentine init` (~1.9 GB download on first
  run, cached by Hugging Face).

See [`.env.example`](./.env.example) for the full env-var list.
```

- [ ] **Step 2: Update the `src/config.ts` header comment**

No new env vars were added, but the comment lists providers implicitly — leave the env list as is. Verify `.env.example` needs no change (no new secrets). If `.env.example` mentions providers, add a line: `# Local providers (ollama / onnx) need no API key at all — see README.`

- [ ] **Step 3: Full suite + typecheck**

Run: `npm test && npx tsc --noEmit` — Expected: green/clean

- [ ] **Step 4: Commit**

```bash
git add README.md .env.example
git commit -m "docs: keyless local-model paths — Ollama GGUF + in-process ONNX (LFM2.5)"
```

---

### Task 7: Live verification + operator cutover (manual, this machine)

**Files:** none in-repo (operator's `~/.valentine/config.json`)

**Interfaces:** consumes the finished CLI.

- [ ] **Step 1: Pick the runtime present on this machine**

Run: `command -v ollama && ollama --version`
If Ollama exists → `ollama pull hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M`, then
`valentine init --provider ollama --crm <as currently configured>` (headless flags preserve existing CRM config — re-run with the current values from `~/.valentine/config.json`).
If not → `npm i -g @huggingface/transformers`, then `valentine init --provider onnx …`.

- [ ] **Step 2: Live keyless sweep**

Run: `env -u ANTHROPIC_API_KEY npx tsx src/cli.ts hut8.com`
Expected: a real multi-CRM verdict with no Anthropic key in the environment. This closes the ship-report row blocked on the placeholder `ANTHROPIC_API_KEY`.

- [ ] **Step 3: Update ship report / TODO**

Mark the blocked row resolved (local model path), commit as `docs: ship-report — keyless local sweep verified`.
