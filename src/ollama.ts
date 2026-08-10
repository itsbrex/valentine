// Local models via Ollama — an adapter that speaks the same tiny "messages"
// surface as the Anthropic client (ModelClient), translated to Ollama's native
// /api/chat. Requires a tool-calling model — LFM2.5 (default), llama3.1,
// qwen2.5…. Everything stays on your machine — CRM data never leaves localhost.

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./models.js";
import { stripThink, parseLfmToolCalls } from "./lfm.js";

export class OllamaClient implements ModelClient {
  /** Ollama doesn't issue tool-call ids; mint stable local ones. */
  private toolSeq = 0;

  constructor(private host: string) {
    this.host = host.replace(/\/+$/, "");
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
        const res = await fetch(`${this.host}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: req.model,
            stream: false,
            options: { num_predict: req.max_tokens },
            tools: (req.tools as any[]).map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.input_schema },
            })),
            messages: toOllama(req.system, req.messages),
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            `Ollama ${res.status} at ${this.host}: ${text.slice(0, 200)} — ` +
              "is `ollama serve` running and the model pulled?",
          );
        }
        const data: any = await res.json();
        const content = this.fromOllama(data?.message);
        if (content.length === 0 && data?.message?.thinking && attempt === 0) continue;
        return { content };
      }
    },
  };

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
