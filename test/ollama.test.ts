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
      const call = content[1] as unknown as { name: string; input: Record<string, unknown> };
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
      const call = content[1] as unknown as { name: string; input: Record<string, unknown> };
      assert.equal(call.name, "get_details");
      assert.deepEqual(call.input, { record_id: "r1" });
    },
  ));

test("think-only content with no calls yields no empty text block", () =>
  withFetch({ message: { content: "<think>nothing</think>" } }, async () => {
    const { content } = await new OllamaClient("http://localhost:11434").messages.create(req);
    assert.deepEqual(content, []);
  }));
