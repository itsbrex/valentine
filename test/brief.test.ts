// The fast path: target parsing, match ranking, the rule-based verdict, the
// template summary, and brief() against a fake CRM + fake model — including
// the promises that make it safe for an unattended watch daemon: a model that
// hangs, throws, or returns junk can never change the verdict or lose the line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTarget, rankMatches, hasSignal, gather } from "../src/gather.js";
import { judge, templateSummary, templateNextStep, brief, parseJsonLoose, acceptSummary, structured, staleness, cleanName, money, listLine } from "../src/brief.js";
import type { CRMConnector, CRMMatch, CRMContext } from "../src/connectors/types.js";
import type { ModelClient } from "../src/models.js";

const match = (over: Partial<CRMMatch> = {}): CRMMatch => ({
  recordId: "rec_1",
  object: "companies",
  name: "Acme",
  domain: "acme.com",
  ...over,
});

function fakeCrm(matches: CRMMatch[], ctx: CRMContext = { notes: [], lists: [], people: [] }) {
  const calls: unknown[] = [];
  const crm: CRMConnector = {
    name: "Fake",
    whoami: async () => ({ workspace: "t" }),
    search: async (q) => {
      calls.push(q);
      return q.name || q.object === "companies" ? matches : [];
    },
    getContext: async () => ctx,
  };
  return { crm, calls };
}

const noModel: ModelClient = {
  messages: { create: async () => ({ content: [] }) },
};

test("parseTarget: domains from bare, URL, and email forms; else a name", () => {
  assert.deepEqual(parseTarget("Acme.com").kind, "domain");
  assert.equal(parseTarget("https://www.Acme.com/about?x=1").value, "acme.com");
  assert.equal(parseTarget("jane@acme.com").value, "acme.com");
  assert.deepEqual(parseTarget("Jane Founder"), { kind: "name", value: "Jane Founder", raw: "Jane Founder" });
});

test("rankMatches: the record that IS the target beats a lookalike sharing its website", () => {
  const sub = match({ recordId: "sub", name: "Urban Oaks Builders", owner: "X", lastInteraction: "activity · 2018-02-07" });
  const hq = match({ recordId: "hq", name: "Hines", domain: "hines.com", lastInteraction: "activity · 2026-01-01" });
  const ranked = rankMatches([sub, { ...hq, domain: "hines.com" }], parseTarget("hines.com"));
  assert.equal(ranked[0].recordId, "hq");
});

test("rankMatches: ties break on recency", () => {
  const old = match({ recordId: "old", lastEmail: "2020-01-01" });
  const fresh = match({ recordId: "fresh", lastEmail: "2026-05-01" });
  assert.equal(rankMatches([old, fresh], parseTarget("acme.com"))[0].recordId, "fresh");
});

test("hasSignal: any interaction/owner/linked-person or context counts; a bare record does not", () => {
  assert.equal(hasSignal(match()), false);
  assert.equal(hasSignal(match({ owner: "Sarah" })), true);
  assert.equal(hasSignal(match({ linkedPeople: 2 })), true);
  assert.equal(hasSignal(match(), { notes: ["passed"], lists: [], people: [] }), true);
});

test("judge: signal → prior_contact with owner, last touch, stage, links; no signal → clean", async () => {
  const { crm } = fakeCrm(
    [match({ owner: "JP Roach", lastEmail: "2026-08-17", lastMeeting: "2026-09-15", connectionStrength: "Very strong", url: "https://app.attio.com/x/company/rec_1" })],
    { notes: ["Intro call — passed, too early"], lists: [{ list: "Pipeline", stage: "Negotiation" }], people: ["Drew", "Amy"] },
  );
  const j = judge(await gather(crm, "acme.com"), "Attio");
  assert.equal(j.verdict, "prior_contact");
  assert.equal(j.owner, "JP Roach");
  assert.equal(j.lastTouch, "2026-09-15 (meeting)");
  assert.equal(j.status, "Negotiation");
  assert.deepEqual(j.citations, ["rec_1"]);
  assert.deepEqual(j.facts.people, ["Drew", "Amy"]);
  assert.deepEqual(
    j.facts.links.map((l) => l.label),
    ["Open in Attio", "Website", "LinkedIn"],
  );
  assert.equal(j.facts.links[0].url, "https://app.attio.com/x/company/rec_1");

  const clean = judge(await gather(fakeCrm([]).crm, "nobody.io"), "Attio");
  assert.equal(clean.verdict, "clean");
  assert.deepEqual(clean.citations, []);
});

test("judge: an outcome-shaped note becomes the status when there is no stage", async () => {
  const { crm } = fakeCrm([match({ owner: "Sarah" })], { notes: ["Chatted at demo day", "Passed — too early, revisit Q3"], lists: [], people: [] });
  const j = judge(await gather(crm, "acme.com"), "Attio");
  assert.equal(j.status, "Passed — too early, revisit Q3");
});

test("judge: many weak name matches → ambiguous", async () => {
  const many = Array.from({ length: 5 }, (_, i) => match({ recordId: `r${i}`, name: `Acme ${i}` }));
  const j = judge(await gather(fakeCrm(many).crm, "Acme"), "Attio");
  assert.equal(j.verdict, "ambiguous");
});

test("templateSummary reads like the partner line, from facts only", async () => {
  const { crm } = fakeCrm([match({ owner: "JP Roach", lastMeeting: "2026-09-15", connectionStrength: "Very strong" })], {
    notes: [], lists: [{ list: "Pipeline", stage: "Negotiation" }], people: [],
  });
  const j = judge(await gather(crm, "acme.com"), "Attio");
  assert.equal(templateSummary(j, "acme.com"), "Acme: JP Roach owns the relationship · last meeting 2026-09-15 · Negotiation · very strong connection.");
  const clean = judge(await gather(fakeCrm([]).crm, "nobody.io"), "Attio");
  assert.equal(templateSummary(clean, "nobody.io"), "No prior contact on record for nobody.io.");
});

test("gather: a domain searches companies first, people only when nothing matched", async () => {
  const hit = fakeCrm([match()]);
  await gather(hit.crm, "acme.com");
  assert.deepEqual(hit.calls, [{ object: "companies", domain: "acme.com" }]);

  const miss = fakeCrm([]);
  await gather(miss.crm, "acme.com");
  assert.deepEqual(miss.calls.map((c: any) => c.object), ["companies", "people"]);

  // A personal-mail domain never identifies a company: people only.
  const free = fakeCrm([]);
  await gather(free.crm, "someone@gmail.com");
  assert.deepEqual(free.calls, [{ object: "people", domain: "gmail.com" }]);
});

test("brief: clean verdicts never call the model", async () => {
  let called = 0;
  const client: ModelClient = { messages: { create: async () => ({ content: [] }) }, structured: async () => (called++, { summary: "x" }) };
  const v = await brief(client, "m", fakeCrm([]).crm, "nobody.io");
  assert.equal(v.verdict, "clean");
  assert.equal(called, 0);
  assert.ok(typeof v.elapsedMs === "number");
});

test("brief: the model's one-liner is used when plausible, the template otherwise", async () => {
  const { crm } = fakeCrm([match({ owner: "JP" })]);
  const good: ModelClient = { ...noModel, structured: async () => ({ summary: "JP owns Acme, last touched in May." }) };
  assert.equal((await brief(good, "m", crm, "acme.com")).summary, "JP owns Acme, last touched in May.");

  const junk: ModelClient = { ...noModel, structured: async () => ({ summary: "{" }) };
  assert.equal((await brief(junk, "m", crm, "acme.com")).summary, "Acme: JP owns the relationship.");

  const throws: ModelClient = { ...noModel, structured: async () => { throw new Error("Ollama 500"); } };
  const v = await brief(throws, "m", crm, "acme.com");
  assert.equal(v.verdict, "prior_contact", "a model failure never touches the verdict");
  assert.equal(v.summary, "Acme: JP owns the relationship.");
});

test("brief: a hung model is abandoned after timeoutMs, verdict intact", async () => {
  const { crm } = fakeCrm([match({ owner: "JP" })]);
  const hung: ModelClient = { ...noModel, structured: () => new Promise(() => {}) };
  const t0 = Date.now();
  const v = await brief(hung, "m", crm, "acme.com", { timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(v.verdict, "prior_contact");
  assert.equal(v.summary, "Acme: JP owns the relationship.");
});

test("brief: noModel skips the call entirely", async () => {
  const { crm } = fakeCrm([match({ owner: "JP" })]);
  let called = 0;
  const client: ModelClient = { ...noModel, structured: async () => (called++, { summary: "no" }) };
  await brief(client, "m", crm, "acme.com", { noModel: true });
  assert.equal(called, 0);
});

test("structured: clients without a fast path get one forced tool call", async () => {
  let req: any;
  const client: ModelClient = {
    messages: {
      create: async (r) => {
        req = r;
        return { content: [{ type: "tool_use", id: "t", name: "write_brief", input: { summary: "ok" } } as never] };
      },
    },
  };
  const out = await structured(client, { model: "m", system: "s", user: "u", schema: { type: "object" }, max_tokens: 50 });
  assert.deepEqual(out, { summary: "ok" });
  assert.deepEqual(req.tool_choice, { type: "tool", name: "write_brief" });
  assert.equal(req.tools[0].name, "write_brief");
});

test("parseJsonLoose tolerates think blocks, fences, and prose around the object", () => {
  assert.deepEqual(parseJsonLoose('<think>\n</think>\n```json\n{"summary":"a"}\n```'), { summary: "a" });
  assert.deepEqual(parseJsonLoose('Sure: {"summary":"b"} done'), { summary: "b" });
  assert.equal(parseJsonLoose("nope"), undefined);
});

test("acceptSummary rejects non-strings, stubs, and walls of text", () => {
  assert.equal(acceptSummary("JP owns it, last touched May 5."), "JP owns it, last touched May 5.");
  assert.equal(acceptSummary(42), undefined);
  assert.equal(acceptSummary("null"), undefined);
  assert.equal(acceptSummary("x".repeat(300)), undefined);
});

test("acceptSummary grounds claims in the facts: no invented owner, no invented dates", async () => {
  const { crm } = fakeCrm([match({ lastEmail: "2024-02-13" })], { notes: [], lists: [], people: ["Ed Strazzulla"] });
  const j = judge(await gather(crm, "acme.com"), "Attio");
  // A contact promoted to owner — the classic small-model slip.
  assert.equal(acceptSummary("Relationship owned by Ed Strazzulla, last email 2024-02-13.", j), undefined);
  assert.equal(acceptSummary("Ed Strazzulla handling the relationship since 2024.", j), undefined);
  // A date that appears nowhere in the evidence.
  assert.equal(acceptSummary("Last email 2024-02-13, last meeting 2023-01-05.", j), undefined);
  // Facts only → accepted.
  assert.equal(acceptSummary("Last email 2024-02-13; Ed Strazzulla is a known contact.", j), "Last email 2024-02-13; Ed Strazzulla is a known contact.");
});

// ─── the desired-card additions: staleness, name cleaning, next step, act links ───

test("staleness: years+months, months, days, today; never negative", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  assert.equal(staleness("2017-06-13", now), "9y 3m");
  assert.equal(staleness("2024-02-13", now), "2y 7m");
  assert.equal(staleness("2026-04-15", now), "5mo");
  assert.equal(staleness("2026-07-02", now), "78d");
  assert.equal(staleness("2026-09-16", now), "2d");
  assert.equal(staleness("2026-09-18", now), "today");
  assert.equal(staleness("2027-01-01", now), undefined);
  assert.equal(staleness(undefined, now), undefined);
});

test("cleanName: shouty surnames and credential suffixes go, real suffixes stay", () => {
  assert.equal(cleanName("Ed STRAZZULLA"), "Ed Strazzulla");
  assert.equal(cleanName("Maria Jacobson, DCT"), "Maria Jacobson");
  assert.equal(cleanName("Tobin Sloane, MCP, CCIM"), "Tobin Sloane");
  assert.equal(cleanName("Martin Luther King, Jr."), "Martin Luther King, Jr.");
  assert.equal(cleanName("JP Roach"), "JP Roach");
});

test("judge: facts carry the deep links the card needs — parent, owner, last touch, tabs, people, lists, act links", async () => {
  const crmLike: CRMConnector = {
    ...fakeCrm([]).crm,
    name: "Salesforce",
    search: async (q) =>
      q.object === "companies" ? [] : [match({
        recordId: "003C1", object: "people", name: "Ted Bruenich", domain: "fpbarch.com",
        owner: "Glenn Friedrich", ownerId: "005G", ownerUrl: "https://sf/User/005G", ownerActive: true,
        lastInteraction: "activity · 2017-06-13", url: "https://sf/Contact/003C1",
        parent: { id: "001F", label: "FPBA", url: "https://sf/Account/001F" },
        views: { activity: "https://sf/Contact/003C1/related/ActivityHistories/view" },
      })],
    getContext: async () => ({
      notes: [], people: ["Maria Jacobson, DCT"], peopleLinks: [{ label: "Maria Jacobson, DCT", url: "https://sf/Contact/1" }],
      lists: [{ list: "SD – Monthly Newsletter", stage: "Sent", kind: "campaign", url: "https://sf/Campaign/1", memberUrl: "https://sf/CampaignMember/1" }],
      activities: [{ id: "00T1", date: "2017-06-13", kind: "email", url: "https://sf/Task/00T1" }],
    }),
    webUrls: { create: (kind, p) => `https://sf/new/${kind}/${p.recordId}` },
  };
  const j = judge(await gather(crmLike, "fpbarch.com"), crmLike);
  assert.equal(j.verdict, "prior_contact");
  assert.equal(j.facts.matchUrl, "https://sf/Contact/003C1");
  assert.equal(j.facts.matchObject, "people");
  assert.deepEqual(j.facts.parent, { label: "FPBA", url: "https://sf/Account/001F" });
  assert.equal(j.facts.ownerUrl, "https://sf/User/005G");
  assert.equal(j.facts.lastTouchUrl, "https://sf/Task/00T1", "the Task behind the last touch, not the tab");
  assert.match(j.facts.stale!, /^\d+y \d+m$/);
  assert.deepEqual(j.facts.people, ["Maria Jacobson"]);
  assert.deepEqual(j.facts.peopleLinks, [{ label: "Maria Jacobson", url: "https://sf/Contact/1" }]);
  assert.equal(j.facts.lists[0].memberUrl, "https://sf/CampaignMember/1");
  assert.deepEqual(j.facts.actions, [{ label: "Log call", url: "https://sf/new/call/003C1" }, { label: "New task", url: "https://sf/new/task/003C1" }]);
  assert.ok(!("opportunity" in j.facts));
  // a plain string crm name still works (older callers)
  assert.equal(judge(await gather(crmLike, "fpbarch.com"), "Salesforce").facts.actions, undefined);
});

test("judge: an open Opportunity becomes facts.opportunity; a closed one does not win over an open one", async () => {
  const { crm } = fakeCrm([match({ owner: "Brian" })], {
    notes: [], people: [],
    lists: [
      { list: "Opportunity: Old", stage: "Closed Lost", kind: "opportunity", open: false },
      { list: "Opportunity: Cyth Expansion", stage: "Negotiation", kind: "opportunity", open: true },
    ],
  });
  const j = judge(await gather(crm, "cyth.com"), "Salesforce");
  assert.equal(j.facts.opportunity?.list, "Opportunity: Cyth Expansion");
  assert.equal(templateNextStep(j, "Salesforce"), "Log this touch to Cyth Expansion so the stage history stays clean.");
});

test("templateNextStep: one imperative line per situation, facts only", async () => {
  const clean = judge(await gather(fakeCrm([]).crm, "nobody.io"), "Attio");
  assert.equal(templateNextStep(clean, "Attio"), "Clear to reach out — create the record in Attio so the next sweep sees it.");
  const unowned = judge(await gather(fakeCrm([match({ lastEmail: "2024-02-13" })]).crm, "acme.com"), "Attio");
  assert.equal(templateNextStep(unowned, "Attio"), "No owner on record in Attio — claim it, then log the touch.");
  const placeholder = judge(await gather(fakeCrm([match({ owner: "Unassigned Atlanta", ownerActive: false, lastEmail: "2026-09-15" })]).crm, "hines.com"), "Salesforce");
  assert.equal(templateNextStep(placeholder, "Salesforce"), "Unassigned Atlanta is a placeholder owner in Salesforce — claim the record before reaching out.");
  const cold = judge(await gather(fakeCrm([match({ owner: "Glenn", lastInteraction: "activity · 2017-06-13" })]).crm, "fpbarch.com"), "Salesforce");
  assert.match(templateNextStep(cold, "Salesforce"), /^Cold for \d+y \d+m — confirm Glenn still owns this before reaching out, then log the touch\.$/);
  const warm = judge(await gather(fakeCrm([match({ owner: "JP", lastEmail: "2026-09-16" })]).crm, "acme.com"), "Attio");
  assert.equal(templateNextStep(warm, "Attio"), "Check with JP before reaching out, then log the touch so the next sweep sees it.");
  // Something already on the calendar in the CRM beats every other line.
  const booked = judge(await gather(fakeCrm([match({ owner: "JP", lastEmail: "2026-09-16" })], { notes: [], lists: [], people: [], upcoming: [{ kind: "call", date: "2026-10-01", subject: "Renewal call", owner: "Glenn", url: "https://x/00T9" }] }).crm, "acme.com"), "Salesforce");
  assert.equal(templateNextStep(booked, "Salesforce"), "Glenn already has a call scheduled for 2026-10-01 (Renewal call) — coordinate before reaching out.");
  assert.deepEqual(booked.facts.nextActivity, { kind: "call", date: "2026-10-01", subject: "Renewal call", owner: "Glenn", url: "https://x/00T9" });
});

test("money / listLine: deal size, close date and shape ride along with the stage", () => {
  assert.equal(money(1250000), "$1.3M");
  assert.equal(money(1000000), "$1M");
  assert.equal(money(450000), "$450K");
  assert.equal(money(900), "$900");
  assert.equal(listLine({ list: "Opportunity: HQ", stage: "Negotiation", amount: 1250000, closeDate: "2026-12-01", detail: "45,000 SF · Office", owner: "Brian" }), "Opportunity: HQ — Negotiation ($1.3M, closes 2026-12-01, 45,000 SF · Office, owner Brian)");
  assert.equal(listLine({ list: "Passed" }), "Passed");
});

test("brief: the model's next_step rides the same grounding gate as the summary", async () => {
  const { crm } = fakeCrm([match({ owner: "JP", lastEmail: "2026-09-16" })]);
  const good: ModelClient = { ...noModel, structured: async () => ({ summary: "JP owns Acme, last email 2026-09-16.", next_step: "Ask JP for the thread before the call." }) };
  const v = await brief(good, "m", crm, "acme.com");
  assert.equal(v.nextStep, "Ask JP for the thread before the call.");
  // An invented date in the next step → template next step, summary untouched.
  const liar: ModelClient = { ...noModel, structured: async () => ({ summary: "JP owns Acme, last email 2026-09-16.", next_step: "Reference the 2025-01-01 meeting." }) };
  const w = await brief(liar, "m", crm, "acme.com");
  assert.equal(w.summary, "JP owns Acme, last email 2026-09-16.");
  assert.equal(w.nextStep, "Check with JP before reaching out, then log the touch so the next sweep sees it.");
  // Clean: template next step, no model call.
  const c = await brief(good, "m", fakeCrm([]).crm, "nobody.io");
  assert.equal(c.nextStep, "Clear to reach out — create the record in Fake so the next sweep sees it.");
});
