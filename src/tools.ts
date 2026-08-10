// The TOOLS the agent may call. ALL READ-ONLY (plus submit_verdict, which captures
// the structured result and ends the run). The agent loop decides which to call.

import type { CRMConnector, Verdict } from "./connectors/types.js";

export const toolSchemas = [
  {
    name: "search_crm",
    description:
      "Search the fund's CRM for a company or person by domain or name. Returns matching " +
      "records with owner and last-touch. Use this first to find prior contact.",
    input_schema: {
      type: "object",
      properties: {
        object: { type: "string", enum: ["companies", "people"] },
        domain: { type: "string", description: "Company domain, e.g. acme.com" },
        name: { type: "string", description: "Company or person name" },
      },
      required: ["object"],
    },
  },
  {
    name: "get_context",
    description:
      "Look across everything else attached to a record: notes (outcomes like " +
      "'passed, too early'), list memberships (e.g. a 'Passed' or 'Portfolio' list, " +
      "with deal stage), and linked people. Call on a promising match from search_crm.",
    input_schema: {
      type: "object",
      properties: {
        object: { type: "string", enum: ["companies", "people"] },
        record_id: { type: "string" },
      },
      required: ["object", "record_id"],
    },
  },
  {
    name: "submit_verdict",
    description:
      "Submit the final verdict. Call this EXACTLY ONCE when done. Ends the run.",
    input_schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["prior_contact", "clean", "ambiguous"] },
        summary: { type: "string", description: "One line a partner reads in 2 seconds" },
        owner: { type: "string" },
        last_touch: { type: "string" },
        status: { type: "string", description: "Outcome from notes, e.g. 'passed, too early'" },
        citations: { type: "array", items: { type: "string" }, description: "Record IDs used" },
      },
      required: ["verdict", "summary", "citations"],
    },
  },
] as const;

export const SUBMIT_VERDICT = "submit_verdict";

/** Run a read tool against the connector. submit_verdict is handled by the loop. */
export async function runTool(
  name: string,
  input: any,
  crm: CRMConnector,
): Promise<unknown> {
  switch (name) {
    case "search_crm":
      return crm.search({ object: input.object, domain: input.domain, name: input.name });
    case "get_context":
      return crm.getContext(input.object, input.record_id);
    default:
      return { error: `unknown tool: ${name}` };
  }
}

/** Map the model's submit_verdict input into our Verdict shape. */
/** Small models fill optional fields with placeholder words rather than
 *  omitting them; "Owner: null" reads as a bug to whoever's about to walk into
 *  the meeting. Treat those as absent. */
const EMPTY_FIELD = /^(null|none|n\/a|na|unknown|undefined|-|)$/i;
const field = (v: unknown): string | undefined =>
  typeof v === "string" && !EMPTY_FIELD.test(v.trim()) ? v : undefined;

export function toVerdict(input: any): Verdict {
  return {
    verdict: input.verdict,
    summary: input.summary,
    owner: field(input.owner),
    lastTouch: field(input.last_touch),
    status: field(input.status),
    citations: Array.isArray(input.citations) ? input.citations : [],
  };
}
