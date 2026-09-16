// Block Kit rendering: the shapes Slack accepts (block types, button urls,
// the 50-block cap), the plain-text fallback, and mrkdwn escaping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictBlocks, sweepBlocks, meetingMessage, slashMessage, esc } from "../src/slackblocks.js";
import type { SweepResult, SourceVerdict } from "../src/sweep.js";
import type { Verdict } from "../src/connectors/types.js";

const prior: Verdict = {
  verdict: "prior_contact",
  summary: "JP Roach owns it, last meeting 2026-09-15.",
  owner: "JP Roach",
  lastTouch: "2026-09-15 (meeting)",
  status: "Negotiation",
  citations: ["rec_1"],
  facts: {
    matchName: "Hines",
    domain: "hines.com",
    matches: 1,
    connectionStrength: "Very strong",
    people: ["Drew Huffman", "Amy Higuchi", "Marquelle Sanchez", "Someone Else"],
    lists: [{ list: "Pipeline", stage: "Negotiation" }],
    notes: ["Intro call <2025> & follow-up"],
    links: [
      { label: "Open in Attio", url: "https://app.attio.com/x/company/rec_1" },
      { label: "Website", url: "https://hines.com" },
    ],
  },
};
const clean: Verdict = { verdict: "clean", summary: "No prior contact on record for fpbarch.com.", citations: [], facts: { matches: 0, people: [], lists: [], notes: [], links: [] } };

const src = (crm: SourceVerdict["crm"], v: Verdict): SourceVerdict => ({ crm, ...v });
const sweep = (sources: SourceVerdict[], combined: Verdict): SweepResult => ({ sources, combined, elapsedMs: 4200 });

test("verdictBlocks: headline, summary, field grid, note, link buttons", () => {
  const blocks = verdictBlocks("hines.com", prior, "Attio", "t") as any[];
  assert.deepEqual(blocks.map((b) => b.type), ["section", "section", "section", "context", "actions"]);
  assert.match(blocks[0].text.text, /:warning: \*hines\.com\* — Hines  ·  Prior contact · Attio/);
  const fields = blocks[2].fields.map((f: any) => f.text);
  assert.ok(fields.some((t: string) => t.startsWith("*Owner*\nJP Roach")));
  assert.ok(fields.some((t: string) => t.includes("Drew Huffman, Amy Higuchi, Marquelle Sanchez +1")));
  assert.match(blocks[3].elements[0].text, /Intro call &lt;2025&gt; &amp; follow-up/);
  assert.deepEqual(
    blocks[4].elements.map((e: any) => [e.type, e.text.text, e.url]),
    [["button", "Open in Attio", "https://app.attio.com/x/company/rec_1"], ["button", "Website", "https://hines.com"]],
  );
});

test("verdictBlocks: a clean target is one quiet line, no buttons", () => {
  const blocks = verdictBlocks("fpbarch.com", clean, undefined, "t") as any[];
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text.text, /:white_check_mark: \*fpbarch\.com\*  ·  No prior contact/);
});

test("sweepBlocks: multi-CRM shows each flagged source and folds clean ones into a footer", () => {
  const res = sweep([src("salesforce", clean), src("attio", prior)], prior);
  const blocks = sweepBlocks("hines.com", res, "s") as any[];
  assert.match(blocks[0].text.text, /Prior contact · Attio/);
  assert.match(blocks.at(-1).elements[0].text, /nothing in Salesforce/);
});

test("meetingMessage: header + timing context, a divider per target, text fallback, ≤50 blocks", () => {
  const res = sweep([src("attio", prior)], prior);
  const msg = meetingMessage("Avid / Hines — Bi-Weekly", 25, [
    { target: "hines.com", res },
    { target: "broken.io", error: "boom" },
  ], { crms: "Salesforce + Attio", model: "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M", elapsedMs: 5300 });
  assert.equal((msg.blocks[0] as any).type, "header");
  assert.match((msg.blocks[1] as any).elements[0].text, /in \*25 min\*/);
  assert.equal(msg.blocks.filter((b: any) => b.type === "divider").length, 2);
  assert.match(msg.text, /^✦ Avid \/ Hines — Bi-Weekly in 25 min\n⚠ hines\.com — JP Roach/);
  assert.match(msg.text, /❓ broken\.io — sweep failed: boom/);
  assert.match((msg.blocks.at(-1) as any).elements[0].text, /LFM2\.5-2\.6B-GGUF:Q4_K_M  ·  5\.3s/);
  assert.ok(msg.blocks.length <= 50);
});

test("slashMessage: blocks plus a one-line text fallback", () => {
  const msg = slashMessage("hines.com", sweep([src("attio", prior)], prior), { crms: "Attio", elapsedMs: 1200 });
  assert.equal(msg.text, ":warning: hines.com — JP Roach owns it, last meeting 2026-09-15.");
  assert.match((msg.blocks.at(-1) as any).elements[0].text, /swept Attio in 1\.2s/);
});

test("esc escapes the mrkdwn specials only", () => {
  assert.equal(esc("A & B <c> *d*"), "A &amp; B &lt;c&gt; *d*");
});
