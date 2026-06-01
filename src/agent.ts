// THE AGENT LOOP. model thinks -> calls a read tool -> we run it -> feed result
// back -> repeat, until it calls submit_verdict. Hand-rolled on the Anthropic
// Messages API so it stays tiny, auditable, and model-swappable.

import type Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";
import { toolSchemas, runTool, toVerdict, SUBMIT_VERDICT } from "./tools.js";
import type { CRMConnector, Verdict } from "./connectors/types.js";

/** Given a target, sweep the CRM and return a structured verdict. */
export async function lookup(
  client: Anthropic,
  model: string,
  crm: CRMConnector,
  target: string,
): Promise<Verdict> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Before a meeting. Target: "${target}". ` +
        "Has anyone at the fund touched this company or founder before? " +
        "Use your tools, then call submit_verdict.",
    },
  ];

  for (let turn = 0; turn < 10; turn++) {
    const res = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: toolSchemas as any,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // The model finished early without a verdict — treat its text as ambiguous.
    if (toolUses.length === 0) {
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      return { verdict: "ambiguous", summary: text || "No verdict produced.", citations: [] };
    }

    // If the model submitted its verdict, capture and finish.
    const verdictCall = toolUses.find((t) => t.name === SUBMIT_VERDICT);
    if (verdictCall) return toVerdict(verdictCall.input);

    // Otherwise run the read tools and feed results back.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const out = await runTool(tu.name, tu.input, crm);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }

  return { verdict: "ambiguous", summary: "Couldn't reach a verdict within the step limit.", citations: [] };
}
