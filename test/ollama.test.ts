// OllamaClient against a stubbed fetch — no server. Covers the LFM2.5
// fallback: think-tag stripping and raw <|tool_call_start|> markers arriving
// in content when Ollama's template fails to emit structured tool_calls
// (ollama/ollama#15953).

import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaClient } from "../src/ollama.js";

function withFetch(payloads: unknown | unknown[], fn: (count: () => number) => Promise<void>) {
  const real = globalThis.fetch;
  const queue = Array.isArray(payloads) ? [...payloads] : [payloads];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const payload = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return fn(() => calls).finally(() => {
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

// LFM2.5 on Ollama ≥0.32 puts reasoning in a separate `thinking` field and
// occasionally emits a degenerate turn: thinking present, content empty, no
// tool_calls. Observed live (Salesforce sweep → "No verdict produced").
test("degenerate thinking-only turn retries once and returns the good turn", () =>
  withFetch(
    [
      { message: { thinking: "hmm, let me consider…", content: "" } },
      {
        message: {
          content: "Found it.",
          tool_calls: [{ function: { name: "search_crm", arguments: { domain: "acme.com" } } }],
        },
      },
    ],
    async (count) => {
      const { content } = await new OllamaClient("http://localhost:11434").messages.create(req);
      assert.equal(count(), 2);
      assert.deepEqual(
        content.map((b: { type: string }) => b.type),
        ["text", "tool_use"],
      );
    },
  ));

test("empty turn without thinking is NOT retried (genuine empty answer)", () =>
  withFetch({ message: { content: "" } }, async (count) => {
    const { content } = await new OllamaClient("http://localhost:11434").messages.create(req);
    assert.equal(count(), 1);
    assert.deepEqual(content, []);
  }));

// structured(): reasoning models get a think-skipping prefill and no grammar;
// models that answer directly get Ollama's `format` grammar. Whether a model
// reasons is learned once (template, else a probe) and cached on disk.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function withRoutes(routes: Record<string, (body: any) => unknown>, fn: (log: { url: string; body: any }[]) => Promise<void>) {
  const real = globalThis.fetch;
  const log: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    log.push({ url: String(url), body });
    const route = Object.keys(routes).find((k) => String(url).endsWith(k));
    return new Response(JSON.stringify(route ? routes[route](body) : {}), { status: 200 });
  }) as typeof fetch;
  return fn(log).finally(() => {
    globalThis.fetch = real;
  });
}

const sreq = { model: "m", system: "s", user: "u", schema: { type: "object" }, max_tokens: 50 };

test("structured: template that opens <think> → prefill, no format, think block stripped", async () => {
  process.env.VALENTINE_MODEL_TRAITS_FILE = join(mkdtempSync(join(tmpdir(), "vt-")), "traits.json");
  await withRoutes(
    {
      "/api/show": () => ({ template: '{%- if add_generation_prompt -%}{{- "<|im_start|>assistant\\n<think>" -}}{%- endif -%}' }),
      "/api/chat": () => ({ message: { content: '<think>\n</think>\n{"summary":"ok"}' } }),
    },
    async (log) => {
      const out = await new OllamaClient("http://localhost:11434").structured!(sreq);
      assert.deepEqual(out, { summary: "ok" });
      const chat = log.find((l) => l.url.endsWith("/api/chat"))!.body;
      assert.equal(chat.format, undefined);
      assert.deepEqual(chat.messages.at(-1), { role: "assistant", content: "<think>\n</think>\n" });
    },
  );
});

test("structured: clean template but the probe still thinks (8B-A1B) → prefill; result cached on disk", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "vt-")), "traits.json");
  process.env.VALENTINE_MODEL_TRAITS_FILE = file;
  let chats = 0;
  await withRoutes(
    {
      "/api/show": () => ({ template: '{%- if add_generation_prompt -%}{{- "<|im_start|>assistant\\n" -}}{%- endif -%}' }),
      "/api/chat": (body) => (++chats, body.think === false ? { message: { thinking: "hmm", content: "OK" } } : { message: { content: '{"summary":"ok"}' } }),
    },
    async (log) => {
      const client = new OllamaClient("http://localhost:11434");
      await client.structured!(sreq);
      const probe = log.filter((l) => l.url.endsWith("/api/chat"))[0].body;
      assert.equal(probe.think, false, "first chat is the probe");
      const real = log.filter((l) => l.url.endsWith("/api/chat"))[1].body;
      assert.equal(real.format, undefined);
      assert.equal(real.messages.at(-1).role, "assistant");
      assert.equal(JSON.parse(readFileSync(file, "utf8")).m.forcesThink, true);
    },
  );
  // A fresh client reads the cached trait: no /api/show, no probe.
  await withRoutes(
    { "/api/chat": () => ({ message: { content: '{"summary":"again"}' } }) },
    async (log) => {
      const out = await new OllamaClient("http://localhost:11434").structured!(sreq);
      assert.deepEqual(out, { summary: "again" });
      assert.equal(log.length, 1);
      assert.ok(log[0].url.endsWith("/api/chat"));
    },
  );
});

test("structured: a model that answers directly gets the format grammar, no prefill", async () => {
  process.env.VALENTINE_MODEL_TRAITS_FILE = join(mkdtempSync(join(tmpdir(), "vt-")), "traits.json");
  await withRoutes(
    {
      "/api/show": () => ({ template: "plain" }),
      "/api/chat": (body) => (body.think === false ? { message: { content: "OK" } } : { message: { content: '{"summary":"direct"}' } }),
    },
    async (log) => {
      const out = await new OllamaClient("http://localhost:11434").structured!(sreq);
      assert.deepEqual(out, { summary: "direct" });
      const real = log.filter((l) => l.url.endsWith("/api/chat")).at(-1)!.body;
      assert.deepEqual(real.format, { type: "object" });
      assert.equal(real.messages.at(-1).role, "user");
    },
  );
});
