#!/usr/bin/env node
// Compare local models on Valentine's one model call: facts in, one-line
// brief out. Runs each case through the same OllamaClient.structured() the
// CLI uses, so what you measure is what you ship. No CRM access needed.
//
//   node scripts/bench-models.mjs                      # default candidates
//   node scripts/bench-models.mjs model-a model-b …    # your own list
//   OLLAMA_HOST=http://host:11434 node scripts/bench-models.mjs
//
// Prints per-model: median latency, JSON validity, and every summary so you
// can judge the writing yourself — a 350M model is fast but terse, a 2.6B
// model reads better; pick what your meetings deserve.

import { OllamaClient } from "../dist/ollama.js";
import { BRIEF_SYSTEM, BRIEF_SCHEMA, briefUserPrompt, acceptSummary } from "../dist/brief.js";

const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M", "lfm2.5-1.2b-instruct:q8", "lfm2.5-350m:q8"];

// Judged shapes as brief.ts builds them — lifted from real (anonymized-enough) sweeps.
const facts = (over) => ({ matches: 1, people: [], lists: [], notes: [], links: [], ...over });
const CASES = [
  { target: "hines.com", crm: "Attio", j: { verdict: "prior_contact", owner: "JP Roach", lastTouch: "2026-09-15 (meeting)", status: "Negotiation", citations: [], facts: facts({ matchName: "Hines", domain: "hines.com", connectionStrength: "Very strong", firstInteraction: "2025-02-26", lastEmail: "2026-08-17", lastMeeting: "2026-09-15", people: ["Drew Huffman", "Amy Higuchi", "Marquelle Sanchez"], lists: [{ list: "Pipeline", stage: "Negotiation" }], notes: ["Intro call 2025-02 — exploring HQ relocation, 40k sf. Passed for now, revisit Q3."] }) } },
  { target: "cyth.com", crm: "Salesforce", j: { verdict: "prior_contact", owner: "Brian Roach", lastTouch: "2026-07-02 (activity)", status: "Negotiation", citations: [], facts: facts({ matchName: "Cyth Systems", domain: "cyth.com", people: ["Shelby Thurston", "Joe Spinozzi"], lists: [{ list: "Opportunity: Cyth Expansion-San Diego", stage: "Negotiation" }], notes: ["Call: discussed San Diego expansion, 12k sf lab space, budget approved"] }) } },
  { target: "eksretirement.com", crm: "Attio", j: { verdict: "prior_contact", lastTouch: "2024-02-13 (email)", citations: [], facts: facts({ matchName: "EKS Group, LLC", domain: "eksretirement.com", firstInteraction: "2023-01-02", lastEmail: "2024-02-13", lastMeeting: "2023-01-05", people: ["Ed Strazzulla"] }) } },
  { target: "Jane Founder", crm: "Affinity", j: { verdict: "prior_contact", owner: undefined, lastTouch: "2026-03-03 (email)", status: "Passed — too early", citations: [], facts: facts({ matchName: "Jane Founder", lastEmail: "2026-03-03", lists: [{ list: "Passed" }], notes: ["Passed — too early, pre-revenue. Sarah to track."] }) } },
];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (const model of models) {
  const client = new OllamaClient(host);
  const times = [];
  let ok = 0;
  console.log(`\n== ${model}`);
  // Warm the model once so load time doesn't pollute the numbers.
  try {
    await client.structured({ model, system: "Reply with {\"summary\":\"ok\"}", user: "go", schema: BRIEF_SCHEMA, max_tokens: 20 });
  } catch (e) {
    console.log(`   unavailable: ${e.message.slice(0, 120)}`);
    continue;
  }
  for (const c of CASES) {
    const t0 = performance.now();
    let out;
    try {
      out = await client.structured({ model, system: BRIEF_SYSTEM, user: briefUserPrompt(c.j, c.target, c.crm), schema: BRIEF_SCHEMA, max_tokens: 160 });
    } catch (e) {
      out = { error: e.message };
    }
    const ms = Math.round(performance.now() - t0);
    times.push(ms);
    const summary = acceptSummary(out?.summary, c.j);
    if (summary) ok++;
    console.log(`   ${String(ms).padStart(5)}ms  ${c.target.padEnd(18)} ${summary ?? `✗ ${JSON.stringify(out ?? null).slice(0, 100)}`}`);
  }
  console.log(`   median ${median(times)}ms · valid ${ok}/${CASES.length}`);
}
