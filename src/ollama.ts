// Local models via Ollama — an adapter that speaks the same tiny "messages"
// surface as the Anthropic client (ModelClient), translated to Ollama's native
// /api/chat. Requires a tool-calling model — LFM2.5 (default), llama3.1,
// qwen2.5…. Everything stays on your machine — CRM data never leaves localhost.
//
// Two request shapes:
//   messages.create — the agent loop (tools, multi-turn).
//   structured      — the fast path: one turn in, one JSON object out. Uses
//                     Ollama's `format` grammar on models that answer directly,
//                     and a think-skipping prefill on reasoning models (LFM2.5's
//                     template always opens a <think> block; the grammar and
//                     the prefill can't be combined, so it's one or the other).
//
// Tunables (env): VALENTINE_OLLAMA_KEEP_ALIVE (default 24h — keep the model
// resident so a pre-meeting sweep never pays the load), VALENTINE_OLLAMA_NUM_CTX
// (default 8192 — a sweep needs ~1.5k tokens; a small KV cache loads faster and
// leaves memory for everything else).

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, StructuredRequest } from "./models.js";
import { stripThink, parseLfmToolCalls } from "./lfm.js";
import { parseJsonLoose } from "./brief.js";

const KEEP_ALIVE = process.env.VALENTINE_OLLAMA_KEEP_ALIVE ?? "24h";
const NUM_CTX = Number(process.env.VALENTINE_OLLAMA_NUM_CTX ?? 8192);

export class OllamaClient implements ModelClient {
  /** Ollama doesn't issue tool-call ids; mint stable local ones. */
  private toolSeq = 0;
  /** Per model: does the chat template force a <think> block open? */
  private thinkTemplate = new Map<string, Promise<boolean>>();

  constructor(private host: string) {
    this.host = host.replace(/\/+$/, "");
  }

  private async chat(body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream: false, keep_alive: KEEP_ALIVE, ...body }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Ollama ${res.status} at ${this.host}: ${text.slice(0, 200)} — ` +
          "is `ollama serve` running and the model pulled?",
      );
    }
    return res.json();
  }

  messages = {
    create: async (req: {
      model: string;
      max_tokens: number;
      system: string;
      tools: unknown;
      messages: Anthropic.MessageParam[];
    }): Promise<{ content: Anthropic.ContentBlock[] }> => {
      // Thinking models (LFM2.5…) occasionally burn a turn on reasoning alone:
      // `thinking` set, content empty, no tool_calls. One retry recovers it.
      for (let attempt = 0; ; attempt++) {
        const data = await this.chat({
          model: req.model,
          options: { num_predict: req.max_tokens, num_ctx: NUM_CTX },
          tools: (req.tools as any[]).map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
          messages: toOllama(req.system, req.messages),
        });
        const content = this.fromOllama(data?.message);
        if (content.length === 0 && data?.message?.thinking && attempt === 0) continue;
        return { content };
      }
    },
  };

  /** One structured turn. See the file header for the grammar/prefill split. */
  structured = async (req: StructuredRequest): Promise<Record<string, unknown> | undefined> => {
    const prefill = await this.forcesThink(req.model);
    const messages: any[] = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];
    // An assistant turn at the end is continued, not answered — so an empty
    // think block skips the reasoning phase entirely (10× fewer tokens).
    if (prefill) messages.push({ role: "assistant", content: "<think>\n</think>\n" });
    const data = await this.chat({
      model: req.model,
      options: { num_predict: req.max_tokens, num_ctx: NUM_CTX, temperature: 0 },
      ...(prefill ? {} : { format: req.schema }),
      messages,
    });
    return parseJsonLoose(String(data?.message?.content ?? ""));
  };

  /** True when the model's chat template opens `<think>` in the generation
   *  prompt (LFM2.5 does) — those models reason unconditionally and Ollama's
   *  `think: false` is a no-op for them. Cached per model; unknown → false. */
  private forcesThink(model: string): Promise<boolean> {
    let p = this.thinkTemplate.get(model);
    if (!p) {
      p = fetch(`${this.host}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      })
        .then((r) => (r.ok ? r.json() : {}))
        .then((d: any) => /add_generation_prompt[\s\S]{0,200}<think>/.test(String(d?.template ?? "")))
        .catch(() => false);
      this.thinkTemplate.set(model, p);
    }
    return p;
  }

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
}

/** Anthropic-shaped history → Ollama chat messages. */
function toOllama(system: string, messages: Anthropic.MessageParam[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
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
        .map((b) => ({ function: { name: b.name, arguments: b.input ?? {} } }));
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
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

const parseArgs = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
