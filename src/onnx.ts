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
