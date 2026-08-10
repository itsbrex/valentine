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

/** Extra token allowance for a reasoning model's <think> block, on top of the
 *  caller's answer budget. LFM2.5 routinely spends ~500-1000 tokens thinking. */
const THINK_HEADROOM = 2048;

export class OnnxClient implements ModelClient {
  private toolSeq = 0;
  private ready?: Promise<{ tokenizer: any; model: any; opensThink: boolean }>;

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
        // Bare-specifier resolution walks up from THIS file, so the package has
        // to sit in an ancestor node_modules: global install only works when
        // valentine itself is global.
        throw new Error(
          "The ONNX provider needs @huggingface/transformers. Install it alongside " +
            "valentine: `npm i -g @huggingface/transformers` if valentine is installed " +
            "globally, otherwise `npm i @huggingface/transformers` in this project.",
        );
      }
      const tokenizer = await tf.AutoTokenizer.from_pretrained(modelId);
      const model = await tf.AutoModelForCausalLM.from_pretrained(modelId, { dtype: this.dtype });
      // Reasoning templates (LFM2.5's) end the generation prompt with an open
      // <think>, so generation starts *inside* the reasoning block and only
      // ever emits the closing tag. Detect it once; fromOnnx re-attaches the
      // opener so a truncated think block is dropped instead of leaking out
      // as the answer.
      let opensThink = false;
      try {
        const probe: string = tokenizer.apply_chat_template([{ role: "user", content: "hi" }], {
          add_generation_prompt: true,
          tokenize: false,
        });
        opensThink = /<think>\s*$/.test(probe);
      } catch {
        /* templates that reject a bare probe just opt out of the fixup */
      }
      return { tokenizer, model, opensThink };
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
      const { tokenizer, model, opensThink } = await this.load(req.model);
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
        // max_tokens budgets the answer; a reasoning model spends a separate,
        // often larger allowance thinking first. Without headroom it runs out
        // mid-thought and never answers at all.
        max_new_tokens: req.max_tokens + (opensThink ? THINK_HEADROOM : 0),
        do_sample: false,
        repetition_penalty: 1.05,
      });
      // Decode only the new tokens, keeping special tokens — the tool-call
      // markers ARE special tokens.
      const newTokens = output.slice(null, [inputs.input_ids.dims.at(-1), null]);
      const raw: string = tokenizer.batch_decode(newTokens, { skip_special_tokens: false })[0] ?? "";

      // Tool calls come out of unambiguous markers, so lift them before any
      // think-stripping can touch them; only the leftover prose is reasoning.
      const { text, calls } = parseLfmToolCalls(raw);
      const blocks: any[] = [];
      const reattached = opensThink && !text.startsWith("<think>") ? `<think>${text}` : text;
      const prose = stripThink(reattached)
        .replace(/<\|[^|]*\|>/g, "") // scrub leftover specials (<|im_end|>…)
        .trim();
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
