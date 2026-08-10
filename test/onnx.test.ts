// OnnxClient against a fake @huggingface/transformers module — no download,
// no native onnxruntime. Covers: chat-template invocation with tools, LFM
// output parsing, history round-trip (tool calls re-rendered as markers,
// tool results as tool-role messages), one-time model load, and the
// missing-dependency error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OnnxClient } from "../src/onnx.js";

function fakeTransformers(reply: string, opensThink = false) {
  const seen = {
    chats: [] as { chat: unknown[]; opts: Record<string, unknown> }[],
    genOpts: [] as Record<string, unknown>[],
    loads: 0,
  };
  const tensor = (dims: number[]): { dims: number[]; slice: () => unknown } => ({
    dims,
    slice: () => tensor(dims),
  });
  const tokenizer = {
    apply_chat_template: (chat: unknown[], opts: Record<string, unknown>) => {
      // tokenize:false is the probe that detects a think-opening template.
      if (opts.tokenize === false) return opensThink ? "…<|im_start|>assistant\n<think>" : "…";
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
  const call = content[1] as unknown as { name: string; input: Record<string, unknown> };
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

// Both observed live against the real LFM2.5-2.6B-ONNX weights: the template
// ends its generation prompt with an open <think>, so the model emits only the
// closing tag — and when reasoning outruns the budget, no tag at all.
test("think-opening template: reasoning before </think> is not the answer", async () => {
  const { loader } = fakeTransformers(
    "The user wants acme.com. I should search.</think>Nothing on file.<|im_end|>",
    true,
  );
  const { content } = await new OnnxClient("q4", loader).messages.create(baseReq);
  assert.equal((content[0] as { text: string }).text, "Nothing on file.");
});

test("think-opening template: truncated reasoning yields no answer, not leaked reasoning", async () => {
  const { loader } = fakeTransformers("I should check whether hut8.com... Wait, I need to", true);
  const { content } = await new OnnxClient("q4", loader).messages.create(baseReq);
  assert.deepEqual(content, []);
});

test("tool calls survive even when wrapped in an unclosed think block", async () => {
  const { loader } = fakeTransformers(
    "reasoning</think><|tool_call_start|>[search_crm(domain='acme.com')]<|tool_call_end|>",
    true,
  );
  const { content } = await new OnnxClient("q4", loader).messages.create(baseReq);
  assert.deepEqual(content.map((b: { type: string }) => b.type), ["tool_use"]);
});

test("think headroom is added on top of the caller's answer budget", async () => {
  const { seen, loader } = fakeTransformers("ok</think>done", true);
  await new OnnxClient("q4", loader).messages.create(baseReq);
  assert.ok(
    (seen.genOpts[0].max_new_tokens as number) > baseReq.max_tokens,
    "reasoning models need budget beyond the answer allowance",
  );
});

test("non-reasoning template gets no headroom and no think fixup", async () => {
  const { seen, loader } = fakeTransformers("Plain answer.", false);
  const { content } = await new OnnxClient("q4", loader).messages.create(baseReq);
  assert.equal(seen.genOpts[0].max_new_tokens, baseReq.max_tokens);
  assert.equal((content[0] as { text: string }).text, "Plain answer.");
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
