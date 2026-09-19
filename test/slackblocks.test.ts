// Block Kit rendering: the five card states the design spec calls for (prior
// contact in one CRM, in the other, in both with an open deal, in neither,
// and the meeting heads-up), the shapes Slack accepts (block types, url
// buttons, the 50-block cap, field/button caps), the plain-text fallback, and
// mrkdwn escaping. Fixture data mirrors real sweeps from 2026-09-17/18.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictBlocks, sweepBlocks, meetingMessage, slashMessage, targetBlocks, linkify, esc } from "../src/slackblocks.js";
import type { SweepResult, SourceVerdict } from "../src/sweep.js";
import type { Verdict } from "../src/connectors/types.js";

const SF = "https://cresa.my.salesforce.com/lightning";
const AT = "https://app.attio.com/roach-dev";

// State 1 · Salesforce contact-level match, nothing in Attio (fpbarch.com).
const sfContact: Verdict = {
  verdict: "prior_contact",
  summary: "Ted Bruenich (owner Glenn Friedrich) last touched the record on 2017-06-13 with a sent activity on the SD – Monthly Newsletter list.",
  nextStep: "Confirm Glenn Friedrich still owns this before reaching out, then log the touch.",
  owner: "Glenn Friedrich",
  lastTouch: "2017-06-13 (activity)",
  status: "Sent",
  citations: ["003C1"],
  facts: {
    matchName: "Ted Bruenich",
    matchUrl: `${SF}/r/Contact/003C1/view`,
    matchObject: "people",
    parent: { label: "FPBA", url: `${SF}/r/Account/001F/view` },
    domain: "fpbarch.com",
    matches: 1,
    ownerUrl: `${SF}/r/User/005G/view`,
    ownerActive: true,
    lastTouchUrl: `${SF}/r/Task/00T1/view`,
    stale: "9y 3m",
    views: { activity: `${SF}/r/Contact/003C1/related/ActivityHistories/view` },
    people: [],
    lists: [{ list: "SD – Monthly Newsletter", stage: "Sent", kind: "campaign", url: `${SF}/r/Campaign/7011/view`, memberUrl: `${SF}/r/CampaignMember/00v1/view` }],
    activities: [{ id: "00T1", date: "2017-06-13", kind: "email", subject: "Newsletter", url: `${SF}/r/Task/00T1/view` }],
    notes: ["Newsletter: SD – Monthly"],
    links: [
      { label: "Open in Salesforce", url: `${SF}/r/Contact/003C1/view` },
      { label: "Website", url: "https://fpbarch.com" },
      { label: "LinkedIn", url: "https://www.linkedin.com/search/results/companies/?keywords=Ted%20Bruenich" },
    ],
    actions: [
      { label: "Log call", url: `${SF}/o/Task/new?defaultFieldValues=WhoId=003C1,Subject=Call%20Ted%20Bruenich` },
      { label: "New task", url: `${SF}/o/Task/new?defaultFieldValues=WhoId=003C1,Subject=Follow%20up%20Ted%20Bruenich` },
    ],
  },
};

// State 2 · Attio company match, nothing in Salesforce (eksretirement.com).
const attioCompany: Verdict = {
  verdict: "prior_contact",
  summary: "EKS Group, LLC has been in Attio since 2023-01-02 with no owner set; last email 2024-02-13.",
  nextStep: "No owner on record in Attio — claim it, then log the touch.",
  lastTouch: "2024-02-13 (email)",
  status: "Companies - 30+ Days",
  citations: ["146103df"],
  facts: {
    matchName: "EKS Group, LLC",
    matchUrl: `${AT}/company/146103df`,
    matchObject: "companies",
    domain: "eksretirement.com",
    matches: 1,
    firstInteraction: "2023-01-02",
    lastEmail: "2024-02-13",
    lastMeeting: "2023-01-05",
    lastTouchUrl: `${AT}/company/146103df/emails`,
    stale: "2y 7m",
    views: { activity: `${AT}/company/146103df/activity`, emails: `${AT}/company/146103df/emails`, people: `${AT}/company/146103df/team` },
    people: ["Ed Strazzulla"],
    peopleLinks: [{ label: "Ed Strazzulla", url: `${AT}/person/bca8490f` }],
    lists: [{ list: "Companies - 30+ Days", kind: "list", url: `${AT}/collection/bad82dfc` }],
    notes: [],
    links: [
      { label: "Open in Attio", url: `${AT}/company/146103df` },
      { label: "Website", url: "https://eksretirement.com" },
      { label: "LinkedIn", url: "https://www.linkedin.com/search/results/companies/?keywords=EKS%20Group%2C%20LLC" },
    ],
    searchUrl: `${AT}/companies`,
  },
};

// State 3 · both CRMs, open opportunity (cyth.com).
const sfDeal: Verdict = {
  verdict: "prior_contact",
  summary: "Cyth Expansion-San Diego is in Negotiation; Brian Roach last touched the account on 2026-07-02.",
  nextStep: "Log this touch to Cyth Expansion-San Diego so the stage history stays clean.",
  owner: "Brian Roach",
  lastTouch: "2026-07-02 (activity)",
  status: "Negotiation",
  citations: ["001PF"],
  facts: {
    matchName: "Cyth Systems", matchUrl: `${SF}/r/Account/001PF/view`, matchObject: "companies", domain: "cyth.com", matches: 1,
    ownerUrl: `${SF}/r/User/005B/view`, ownerActive: true, lastTouchUrl: `${SF}/r/Task/00T9/view`, stale: "78d",
    views: { activity: `${SF}/r/Account/001PF/related/ActivityHistories/view`, people: `${SF}/r/Account/001PF/related/Contacts/view` },
    people: ["Shelby Thurston", "Joe Spinozzi"],
    peopleLinks: [{ label: "Shelby Thurston", url: `${SF}/r/Contact/003S/view` }, { label: "Joe Spinozzi", url: `${SF}/r/Contact/003J/view` }],
    lists: [{ list: "Opportunity: Cyth Expansion-San Diego", stage: "Negotiation", kind: "opportunity", id: "006C", url: `${SF}/r/Opportunity/006C/view`, open: true }],
    opportunity: { list: "Opportunity: Cyth Expansion-San Diego", stage: "Negotiation", kind: "opportunity", id: "006C", url: `${SF}/r/Opportunity/006C/view`, open: true },
    notes: [],
    links: [{ label: "Open in Salesforce", url: `${SF}/r/Account/001PF/view` }, { label: "Website", url: "https://cyth.com" }, { label: "LinkedIn", url: "https://www.linkedin.com/search/results/companies/?keywords=Cyth%20Systems" }],
    actions: [{ label: "Log call", url: `${SF}/o/Task/new?defaultFieldValues=WhatId=001PF,Subject=Call%20Cyth%20Systems` }, { label: "New task", url: `${SF}/o/Task/new?defaultFieldValues=WhatId=001PF,Subject=Follow%20up` }, { label: "Log meeting", url: `${SF}/o/Event/new?defaultFieldValues=WhatId=001PF,Subject=Meeting` }],
  },
};
const attioDeal: Verdict = {
  verdict: "prior_contact",
  summary: "Cyth Systems, Inc. shows a very strong connection with a last email on 2026-09-16.",
  nextStep: "Check with Brian Roach before reaching out, then log the touch so the next sweep sees it.",
  owner: "Brian Roach",
  lastTouch: "2026-09-16 (email)",
  citations: ["6859814e"],
  facts: {
    matchName: "Cyth Systems, Inc.", matchUrl: `${AT}/company/6859814e`, matchObject: "companies", domain: "cyth.com", matches: 1,
    connectionStrength: "Very strong", lastEmail: "2026-09-16", lastTouchUrl: `${AT}/company/6859814e/emails`, stale: "2d",
    views: { activity: `${AT}/company/6859814e/activity`, emails: `${AT}/company/6859814e/emails`, people: `${AT}/company/6859814e/team` },
    people: ["Shelby Roach", "Joe Spinozzi"],
    peopleLinks: [{ label: "Shelby Roach", url: `${AT}/person/e887d53f` }, { label: "Joe Spinozzi", url: `${AT}/person/e7acda37` }],
    lists: [], notes: [],
    links: [{ label: "Open in Attio", url: `${AT}/company/6859814e` }, { label: "Website", url: "https://cyth.com" }, { label: "LinkedIn", url: "https://www.linkedin.com/search/results/companies/?keywords=Cyth" }],
  },
};

const cleanFacts = (over: Partial<Verdict["facts"]> = {}): Verdict["facts"] => ({ matches: 0, people: [], lists: [], notes: [], links: [], ...over });
const cleanSf: Verdict = {
  verdict: "clean", summary: "No prior contact on record for nobody-here.example.", nextStep: "Clear to reach out — create the record in Salesforce so the next sweep sees it.", citations: [],
  facts: cleanFacts({ links: [{ label: "Website", url: "https://nobody-here.example" }, { label: "LinkedIn", url: "https://www.linkedin.com/search/results/companies/?keywords=nobody-here.example" }], actions: [{ label: "＋ Lead", url: `${SF}/o/Lead/new?defaultFieldValues=Company=nobody-here.example` }, { label: "＋ Account", url: `${SF}/o/Account/new?defaultFieldValues=Name=nobody-here.example` }] }),
};
const cleanAttio: Verdict = { verdict: "clean", summary: "No prior contact on record for nobody-here.example.", citations: [], facts: cleanFacts({ searchUrl: `${AT}/companies` }) };

const src = (crm: SourceVerdict["crm"], v: Verdict, extra: Partial<SourceVerdict> = {}): SourceVerdict => ({ crm, ...v, ...extra });
const sweep = (sources: SourceVerdict[], combined: Verdict = sources.find((s) => s.verdict === "prior_contact") ?? sources[0]): SweepResult => ({ sources, combined, elapsedMs: 5700 });

const types = (blocks: any[]) => blocks.map((b) => b.type);
const text = (b: any): string => b.text?.text ?? b.elements?.map((e: any) => e.text?.text ?? e.text).join(" ") ?? b.fields?.map((f: any) => f.text).join("\n") ?? "";
const buttons = (b: any): [string, string][] => b.elements.map((e: any) => [e.text.text, e.url]);
const fieldsOf = (blocks: any[]): string[] => blocks.find((b) => b.fields)?.fields.map((f: any) => f.text) ?? [];

test("state 1 · SF contact + nothing in Attio: linked headline, stale pill, 6 linked fields, SF row, Attio create row, Other", () => {
  const res = sweep([src("salesforce", sfContact), src("attio", cleanAttio)]);
  const blocks = sweepBlocks("fpbarch.com", res, "s") as any[];

  // headline: domain → Account, name → Contact, staleness pill, source
  assert.equal(text(blocks[0]), `:warning: <${SF}/r/Account/001F/view|fpbarch.com> – <${SF}/r/Contact/003C1/view|Ted Bruenich>  ·  Prior contact \`9y 3m stale\` · Salesforce`);
  // summary: every entity in the model's sentence is a link
  const summary = text(blocks[1]);
  assert.match(summary, new RegExp(`<${SF}/r/Contact/003C1/view\\|Ted Bruenich> \\(owner <${SF}/r/User/005G/view\\|Glenn Friedrich>\\)`));
  assert.match(summary, new RegExp(`<${SF}/r/Task/00T1/view\\|2017-06-13>`));
  assert.match(summary, new RegExp(`<${SF}/r/Campaign/7011/view\\|SD – Monthly Newsletter>`));
  // fields
  const fields = fieldsOf(blocks);
  assert.deepEqual(fields.map((f) => f.split("\n")[0]), ["*Contact*", "*Account*", "*Owner*", "*Last touch*", "*Campaign*", "*Stage / outcome*"]);
  assert.match(fields[3], /<[^|]+\|2017-06-13> · activity `9y 3m`/);
  assert.match(fields[5], new RegExp(`<${SF}/r/CampaignMember/00v1/view\\|Sent>`));
  // action rows: SALESFORCE · ATTIO (nothing) · OTHER
  const ctx = blocks.filter((b) => b.type === "context").map(text);
  assert.deepEqual(ctx, ["*SALESFORCE*", "*ATTIO* `nothing in Attio`", "*OTHER*"]);
  const rows = blocks.filter((b) => b.type === "actions").map(buttons);
  assert.deepEqual(rows[0].map((b) => b[0]), ["Open contact", "Account", "Activity", "Log call", "New task"]);
  assert.deepEqual(rows[1].map((b) => b[0]), ["Companies in Attio"]);
  assert.deepEqual(rows[2].map((b) => b[0]), ["Website", "LinkedIn · Ted", "LinkedIn · company"]);
  // says
  assert.match(text(blocks.at(-1)), /^> \*Valentine says\*\n> Confirm Glenn Friedrich still owns this/);
  for (const b of blocks) if (b.type === "actions") assert.ok(b.elements.every((e: any) => e.type === "button" && e.url && e.action_id));
});

test("state 2 · Attio company + nothing in SF: owner gap pill, list/people links, SF create row seeded from Attio", () => {
  const sfClean: Verdict = { ...cleanAttio, facts: cleanFacts({ actions: [{ label: "＋ Lead", url: `${SF}/o/Lead/new?defaultFieldValues=Company=EKS%20Group%2C%20LLC` }, { label: "＋ Account", url: `${SF}/o/Account/new?defaultFieldValues=Name=EKS%20Group%2C%20LLC` }] }) };
  const res = sweep([src("salesforce", sfClean), src("attio", attioCompany)]);
  const blocks = sweepBlocks("eksretirement.com", res, "s") as any[];
  assert.equal(text(blocks[0]), `:warning: <${AT}/company/146103df|eksretirement.com> – <${AT}/company/146103df|EKS Group, LLC>  ·  Prior contact \`2y 7m stale\` \`owner unset\` · Attio`);
  const fields = fieldsOf(blocks);
  assert.match(fields.find((f) => f.startsWith("*Owner*"))!, /unset `claim it`/);
  assert.match(fields.find((f) => f.startsWith("*List*"))!, new RegExp(`<${AT}/collection/bad82dfc\\|Companies - 30\\+ Days>`));
  assert.match(fields.find((f) => f.startsWith("*Known people*"))!, new RegExp(`<${AT}/person/bca8490f\\|Ed Strazzulla>`));
  const ctx = blocks.filter((b) => b.type === "context").map(text);
  assert.equal(ctx[0], "*SALESFORCE* `nothing in Salesforce`");
  assert.match(ctx[1], /^prefills from Attio → name `EKS Group, LLC` · website `eksretirement.com` · note `Attio record link` — nothing is saved/);
  const rows = blocks.filter((b) => b.type === "actions").map(buttons);
  assert.deepEqual(rows[0].map((b) => b[0]), ["＋ Lead", "＋ Account"]);
  assert.deepEqual(rows[1].map((b) => b[0]), ["Open company", "Activity", "Emails"]);
});

test("state 3 · both CRMs with an open opportunity: 🔥 Active deal, stage pill, paired fields, no create rows", () => {
  const res = sweep([src("salesforce", sfDeal), src("attio", attioDeal)]);
  const blocks = sweepBlocks("cyth.com", res, "s") as any[];
  const head = text(blocks[0]);
  assert.match(head, /^:fire: <[^|]+\|cyth\.com> – <[^|]+\|Cyth Systems> \/ <[^|]+\|Cyth Systems, Inc\.>  ·  Active deal `Negotiation` `both CRMs` · Salesforce \+ Attio$/);
  assert.ok(!/names differ/.test(head), "Inc. suffix is not a mismatch");
  assert.match(text(blocks[1]), /^\*Salesforce:\* <[^|]+\|Cyth Expansion-San Diego> is in Negotiation/);
  assert.match(text(blocks[2]), /^\*Attio:\* <[^|]+\|Cyth Systems, Inc\.> shows a very strong connection with a last email on <[^|]+emails\|2026-09-16>/);
  const fields = fieldsOf(blocks);
  assert.deepEqual(fields.map((f) => f.split("\n")[0]), ["*Record (SF / Attio)*", "*Owner (SF / Attio)*", "*Last touch (SF / Attio)*", "*Opportunity (SF)*", "*SF people*", "*Attio people*", "*Connection (Attio)*"]);
  assert.match(fields[2], /2026-07-02> `78d` \/ <[^|]+\|2026-09-16> `2d`/);
  const ctx = blocks.filter((b) => b.type === "context").map(text);
  assert.deepEqual(ctx, ["*SALESFORCE*", "*ATTIO*", "*OTHER*"]);
  const rows = blocks.filter((b) => b.type === "actions").map(buttons);
  assert.deepEqual(rows[0].map((b) => b[0]), ["Open company", "Activity", "Log call", "New task"], "Log meeting is kept for the heads-up");
  assert.ok(rows[0].length <= 5);
});

test("state 4 · nothing anywhere: green verdict, zero counts per CRM, create rows for both, no says beyond the template", () => {
  const res = sweep([src("salesforce", cleanSf), src("attio", cleanAttio)], { ...cleanSf });
  const blocks = sweepBlocks("nobody-here.example", res, "s") as any[];
  assert.equal(text(blocks[0]), ":white_check_mark: <https://nobody-here.example|nobody-here.example>  ·  No prior contact `clear to reach out` · Salesforce + Attio");
  assert.match(text(blocks[1]), /^No company, contact or list entry matches nobody-here\.example — nothing in Salesforce, nothing in Attio\.$/);
  assert.deepEqual(fieldsOf(blocks), ["*Salesforce*\n0 matching records", "*Attio*\n0 matching records", "*Domain*\n<https://nobody-here.example|nobody-here.example>"]);
  const ctx = blocks.filter((b) => b.type === "context").map(text);
  assert.deepEqual(ctx, ["*SALESFORCE* `nothing in Salesforce`", "*ATTIO* `nothing in Attio`", "*OTHER*"]);
  const rows = blocks.filter((b) => b.type === "actions").map(buttons);
  assert.deepEqual(rows[0].map((b) => b[0]), ["＋ Lead", "＋ Account"]);
  assert.deepEqual(rows[1].map((b) => b[0]), ["Companies in Attio"]);
  assert.match(text(blocks.at(-1)), /> Clear to reach out/);
});

test("an unreachable CRM is named in the headline and its row, never folded into 'clean'", () => {
  const dead = src("salesforce", { verdict: "ambiguous", summary: "Couldn't reach Salesforce: session expired", citations: [] }, { unreachable: true });
  const res = sweep([dead, src("attio", attioCompany)]);
  const blocks = sweepBlocks("eksretirement.com", res, "s") as any[];
  assert.match(text(blocks[0]), /`Salesforce unreachable` · Attio$/);
  assert.ok(blocks.some((b) => b.type === "context" && /:grey_question: Couldn&#39;t reach|:grey_question: Couldn't reach Salesforce: session expired/.test(text(b))));
  assert.ok(blocks.some((b) => b.type === "context" && text(b) === "*SALESFORCE* `unreachable`"));
  assert.ok(!blocks.some((b) => /nothing in Salesforce/.test(text(b))));
});

test("state 5 · meeting heads-up: 📅 header, timing context, one domain-named action row per target, one says block, ≤50 blocks", () => {
  const hines = sweep([src("salesforce", { ...sfDeal, owner: "Unassigned Atlanta", facts: { ...sfDeal.facts!, domain: "hines.com", matchName: "Hines Atlanta", ownerActive: false, opportunity: undefined, lists: [] } }), src("attio", { ...attioDeal, facts: { ...attioDeal.facts!, domain: "hines.com", matchName: "Hines" } })]);
  const msg = meetingMessage("Avid / Hines — Bi-Weekly", 30, [
    { target: "hines.com", res: hines },
    { target: "cyth.com", res: sweep([src("salesforce", sfDeal), src("attio", attioDeal)]) },
    { target: "broken.io", error: "boom" },
  ], { crms: "Salesforce + Attio", model: "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M", elapsedMs: 7000 });
  const b = msg.blocks as any[];
  assert.deepEqual(b[0], { type: "header", text: { type: "plain_text", text: "📅 Avid / Hines — Bi-Weekly", emoji: true } });
  assert.equal(text(b[1]), ":clock3: in *30 min*  ·  3 external domains  ·  swept Salesforce + Attio");
  assert.equal(b.filter((x) => x.type === "divider").length, 3);
  // hines: owner gap on the SF side, names differ across CRMs
  assert.match(text(b[3]), /`both CRMs` `SF owner unassigned` `names differ across CRMs`/);
  // per-domain action rows, not per-CRM rows
  const ctx = b.filter((x) => x.type === "context").map(text);
  assert.ok(ctx.includes("*HINES.COM*") && ctx.includes("*CYTH.COM*"));
  assert.ok(!ctx.some((c) => /^\*SALESFORCE\*|^\*OTHER\*/.test(c)));
  const rows = b.filter((x) => x.type === "actions").map(buttons);
  assert.deepEqual(rows[0].map((x) => x[0]), ["SF company", "Attio company", "Log meeting"]);
  // one says block, labelled per domain
  const says = b.filter((x) => x.type === "section" && /Valentine says/.test(text(x)));
  assert.equal(says.length, 1);
  assert.match(text(says[0]), /> \*hines\.com\* — .*\n> \*cyth\.com\* — Log this touch/);
  // fallback text + footer
  assert.match(msg.text, /^✦ Avid \/ Hines — Bi-Weekly in 30 min\n⚠ hines\.com — /);
  assert.match(msg.text, /❓ broken\.io — sweep failed: boom/);
  assert.equal(text(b.at(-1)), "heads-up  ·  swept Salesforce + Attio in 7.0s  ·  read-only  ·  LFM2.5-2.6B-GGUF:Q4_K_M");
  assert.ok(b.length <= 50);
});

// ─── interactive half (writes on) ────────────────────────────────────────────

const WRITES = { interactive: { writes: true } };
const els = (b: any): any[] => b.elements;
const labelsOf = (b: any): string[] => els(b).map((e) => e.text?.text ?? e.type);
const value = (b: any, label: string): any => JSON.parse(els(b).find((e) => e.text?.text === label).value);

test("interactive · state 1: the Attio row gets a green Create button carrying the SF seed + confirm; the ··· menu and a writes-on footer appear; nothing else moves", () => {
  const res = sweep([src("salesforce", sfContact), src("attio", cleanAttio)]);
  const msg = slashMessage("fpbarch.com", res, { crms: "Salesforce + Attio", writes: true }, WRITES);
  const blocks = msg.blocks as any[];
  const rows = blocks.filter((b) => b.type === "actions");
  assert.deepEqual(labelsOf(rows[0]), ["Open contact", "Account", "Activity", "Log call", "New task"], "SF row unchanged: owner is active, no write to offer");
  assert.deepEqual(labelsOf(rows[1]), ["＋ Create company + person", "Companies in Attio"]);
  const create = els(rows[1])[0];
  assert.equal(create.style, "primary");
  assert.equal(create.url, undefined);
  assert.deepEqual(JSON.parse(create.value), { op: "attio_create", domain: "fpbarch.com", name: "FPBA", person: "Ted Bruenich", from: { crm: "Salesforce", id: "003C1", url: `${SF}/r/Contact/003C1/view` } });
  assert.equal(create.confirm.title.text, "Create in Attio?");
  assert.match(create.confirm.text.text, /Company \*FPBA\* and \*Ted Bruenich\* \(fpbarch\.com\), source Salesforce 003C1\./);
  assert.equal(create.confirm.confirm.text, "Create");
  assert.match(text(blocks.find((b) => b.type === "context" && /prefills from/.test(text(b)))), /green button writes them after you confirm/);
  // ··· menu on the OTHER row
  const other = rows[2];
  assert.deepEqual(labelsOf(other), ["Website", "LinkedIn · Ted", "LinkedIn · company", "overflow"]);
  const menu = els(other).at(-1);
  assert.deepEqual(menu.options.map((o: any) => [o.text.text, o.value]), [["Re-run sweep", "rerun|fpbarch.com"], ["Copy SF ID", "copy|SF|003C1"], ["Mute domain 30d", "mute|fpbarch.com"], ["Mark handled", "handled|fpbarch.com"]]);
  assert.ok(menu.options.every((o: any) => o.value.length <= 75));
  assert.match(text(blocks.at(-1)), /writes on · every write confirmed/);
  // and without the option, the read-only card is byte-for-byte what it was
  const plain = slashMessage("fpbarch.com", res, { crms: "Salesforce + Attio" }).blocks as any[];
  assert.ok(plain.every((b) => b.type !== "actions" || els(b).every((e: any) => e.type === "button" && e.url)));
  assert.match(text(plain.at(-1)), /read-only/);
});

test("interactive · state 2: an owner gap gets Claim owner on that CRM's row; the SF create side stays the prefilled forms", () => {
  const sfClean: Verdict = { ...cleanAttio, facts: cleanFacts({ actions: [{ label: "＋ Lead", url: `${SF}/o/Lead/new?defaultFieldValues=Company=EKS` }] }) };
  const blocks = targetBlocks("eksretirement.com", sweep([src("salesforce", sfClean), src("attio", attioCompany)]), "s", WRITES).blocks as any[];
  const rows = blocks.filter((b) => b.type === "actions");
  assert.deepEqual(labelsOf(rows[0]), ["＋ Lead"], "no write button: Attio knows the company, the form is seeded from it");
  assert.ok(labelsOf(rows[1]).includes("Claim owner"));
  assert.deepEqual(value(rows[1], "Claim owner"), { op: "claim", crm: "attio", object: "companies", id: "146103df" });
  assert.equal(els(rows[1]).find((e) => e.text.text === "Claim owner").confirm.title.text, "Claim in Attio?");
});

test("interactive · state 3: both CRMs know the company and nothing links them → Link IDs (primary, confirm) on the SF row; linked records get no button", () => {
  const blocks = targetBlocks("cyth.com", sweep([src("salesforce", sfDeal), src("attio", attioDeal)]), "s", WRITES).blocks as any[];
  const rows = blocks.filter((b) => b.type === "actions");
  assert.ok(labelsOf(rows[0]).includes("Link IDs"));
  const link = els(rows[0]).find((e) => e.text.text === "Link IDs");
  assert.equal(link.style, "primary");
  assert.deepEqual(JSON.parse(link.value), { op: "crosslink", sf: { object: "companies", id: "001PF", url: sfDeal.facts!.matchUrl }, attio: { object: "companies", id: "6859814e", url: attioDeal.facts!.matchUrl } });
  assert.match(link.confirm.text.text, /Attio \*Cyth Systems, Inc\.\* ↔ Salesforce \*Cyth Systems\*/);
  // cross-linked already (a note carries the other's id) → no Link IDs
  const linkedSf: Verdict = { ...sfDeal, facts: { ...sfDeal.facts!, notes: ["Attio: 6859814e"] } };
  const again = targetBlocks("cyth.com", sweep([src("salesforce", linkedSf), src("attio", attioDeal)]), "s", WRITES).blocks as any[];
  assert.ok(!again.filter((b) => b.type === "actions").some((b) => labelsOf(b).includes("Link IDs")));
});

test("interactive · state 4: nothing anywhere → Lead in SF, Company in Attio, Both + cross-link, all confirmed; unreachable CRMs get no create", () => {
  const blocks = targetBlocks("nobody-here.example", sweep([src("salesforce", cleanSf), src("attio", cleanAttio)], { ...cleanSf }), "s", WRITES).blocks as any[];
  const rows = blocks.filter((b) => b.type === "actions");
  assert.deepEqual(labelsOf(rows[0]), ["＋ Lead in Salesforce", "＋ Lead", "＋ Account"]);
  assert.deepEqual(value(rows[0], "＋ Lead in Salesforce"), { op: "sf_create_lead", domain: "nobody-here.example" });
  assert.deepEqual(labelsOf(rows[1]), ["＋ Company in Attio", "Companies in Attio"]);
  assert.deepEqual(value(rows[1], "＋ Company in Attio"), { op: "attio_create", domain: "nobody-here.example" });
  assert.equal(labelsOf(rows[2])[0], "Both + cross-link");
  assert.deepEqual(value(rows[2], "Both + cross-link"), { op: "create_both", domain: "nobody-here.example" });
  const dead = src("salesforce", { verdict: "ambiguous", summary: "Couldn't reach Salesforce", citations: [] }, { unreachable: true });
  const rows2 = (targetBlocks("nobody-here.example", sweep([dead, src("attio", cleanAttio)]), "s", WRITES).blocks as any[]).filter((b) => b.type === "actions");
  assert.ok(!rows2.some((b) => labelsOf(b).some((l) => /Both|Lead in Salesforce/.test(l))), "a CRM we couldn't read is not 'nothing there'");
  assert.ok(rows2.some((b) => labelsOf(b).includes("＋ Company in Attio")));
});

test("interactive · state 5 meeting: Open event / Join links, Claim SF owner + Fix Attio match on a gapped/mismatched target, Log to both CRMs with the event", () => {
  const hines = sweep([
    src("salesforce", { ...sfDeal, owner: "Unassigned Atlanta", citations: ["001H"], facts: { ...sfDeal.facts!, domain: "hines.com", matchName: "Hines Atlanta", matchUrl: `${SF}/r/Account/001H/view`, ownerActive: false, opportunity: undefined, lists: [] } }),
    src("attio", { ...attioDeal, citations: ["at_lsa"], facts: { ...attioDeal.facts!, domain: "hines.com", matchName: "Language Services Associates" } }),
  ]);
  const msg = meetingMessage("Avid / Hines — Bi-Weekly", 30, [{ target: "hines.com", res: hines }], { crms: "Salesforce + Attio", elapsedMs: 7000, writes: true }, {
    meeting: { start: 1790000000000, url: "ical://ekevent/EV1?method=show&options=more", joinUrl: "https://zoom.us/j/1" },
    interactive: { writes: true },
  });
  const b = msg.blocks as any[];
  assert.deepEqual(buttons(b[2]), [["Open event", "ical://ekevent/EV1?method=show&options=more"], ["Join", "https://zoom.us/j/1"]]);
  const rows = b.filter((x) => x.type === "actions").slice(1);
  const labels = rows.flatMap(labelsOf);
  assert.deepEqual(labels, ["SF company", "Attio company", "Log meeting", "Claim SF owner", "Fix Attio match", "Log to both CRMs"]);
  assert.deepEqual(value(rows.find((r) => labelsOf(r).includes("Claim SF owner")), "Claim SF owner"), { op: "claim", crm: "salesforce", object: "companies", id: "001H" });
  assert.deepEqual(value(rows.find((r) => labelsOf(r).includes("Fix Attio match")), "Fix Attio match"), { op: "attio_rematch", domain: "hines.com", id: "at_lsa", name: "Hines Atlanta", note: `Salesforce: ${SF}/r/Account/001H/view` });
  assert.deepEqual(value(rows.find((r) => labelsOf(r).includes("Log to both CRMs")), "Log to both CRMs"), { op: "log_meeting", title: "Avid / Hines — Bi-Weekly", start: 1790000000000, targets: [{ crm: "salesforce", object: "companies", id: "001H" }, { crm: "attio", object: "companies", id: "at_lsa" }] });
  assert.ok(rows.every((r) => els(r).length <= 5));
  assert.match(text(b.at(-1)), /writes on/);
});

test("deal pills and the Next field: amount, close date and shape after the stage; the soonest scheduled activity linked with its owner", () => {
  const rich: Verdict = { ...sfDeal, facts: { ...sfDeal.facts!, opportunity: { ...sfDeal.facts!.opportunity!, amount: 1250000, closeDate: "2026-12-01", detail: "45,000 SF · Office" }, nextActivity: { kind: "call", date: "2026-10-01", subject: "Renewal call", owner: "Brian Roach", url: `${SF}/r/Task/00T9/view` } } };
  const fields = fieldsOf(sweepBlocks("cyth.com", sweep([src("salesforce", rich)]), "s") as any[]);
  const opp = fields.find((f) => f.startsWith("*Opportunity*"))!;
  assert.match(opp, /`Negotiation` `\$1\.3M` `closes 2026-12-01` `45,000 SF · Office`$/);
  assert.equal(fields.find((f) => f.startsWith("*Next*")), `*Next*\n<${SF}/r/Task/00T9/view|2026-10-01> · Renewal call · Brian Roach`);
});

test("slashMessage: card + says + footer linking each CRM swept, run id when given; one-line text fallback", () => {
  const msg = slashMessage("eksretirement.com", sweep([src("salesforce", { ...cleanAttio, facts: cleanFacts() }), src("attio", attioCompany)]), { crms: "Salesforce + Attio", elapsedMs: 4100, model: "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M", runId: "c8c8a04b", runUrl: "https://valentine-lab.localhost/?run=c8c8a04b" });
  assert.equal(msg.text, ":warning: eksretirement.com — EKS Group, LLC has been in Attio since 2023-01-02 with no owner set; last email 2024-02-13.");
  assert.equal(text(msg.blocks.at(-1)), `swept Salesforce + <${AT}/company/146103df|Attio> in 4.1s  ·  read-only  ·  LFM2.5-2.6B-GGUF:Q4_K_M  ·  run <https://valentine-lab.localhost/?run=c8c8a04b|c8c8a04b>`);
  assert.match(text(msg.blocks.at(-2)), /^> \*Valentine says\*/);
});

test("verdictBlocks keeps working for a single source", () => {
  const blocks = verdictBlocks("fpbarch.com", sfContact, "Salesforce", "t") as any[];
  assert.equal(types(blocks)[0], "section");
  assert.match(text(blocks[0]), /Prior contact `9y 3m stale` · Salesforce$/);
});

test("Slack limits: ≤10 fields, ≤5 buttons per row, button text ≤75, section text ≤3000, blocks ≤50, unique action_ids", () => {
  const many: Verdict = { ...attioCompany, facts: { ...attioCompany.facts!, people: Array.from({ length: 9 }, (_, i) => `P${i}`), lists: Array.from({ length: 9 }, (_, i) => ({ list: `L${i}`, url: `https://x/${i}` })), notes: ["n".repeat(4000)], actions: Array.from({ length: 9 }, (_, i) => ({ label: "a".repeat(120), url: `https://x/a${i}` })) } };
  const items = Array.from({ length: 12 }, (_, i) => ({ target: `t${i}.com`, res: sweep([src("salesforce", many), src("attio", many)]) }));
  const msg = meetingMessage("Big", 5, items, { crms: "Salesforce + Attio" });
  const b = msg.blocks as any[];
  assert.ok(b.length <= 50);
  assert.equal(b.at(-1).type, "context", "footer survives the cap");
  const ids = new Set<string>();
  for (const x of b) {
    if (x.fields) assert.ok(x.fields.length <= 10);
    if (x.type === "actions") {
      assert.ok(x.elements.length <= 5);
      for (const e of x.elements) {
        assert.ok(e.text.text.length <= 75);
        assert.ok(!ids.has(e.action_id), `duplicate action_id ${e.action_id}`);
        ids.add(e.action_id);
      }
    }
    if (x.text) assert.ok(x.text.text.length <= 3000);
  }
});

test("linkify links each known entity once, longest name first, and never nests links", () => {
  const v: Verdict = { ...attioDeal, owner: "Brian Roach", facts: { ...attioDeal.facts!, matchName: "Hines", ownerUrl: "https://u/brian", peopleLinks: [{ label: "Hines Atlanta", url: "https://p/atl" }] } };
  const out = linkify("Hines Atlanta and Hines both, Brian Roach owns it, last email 2026-09-16 and again 2026-09-16.", v);
  assert.equal(out, `<https://p/atl|Hines Atlanta> and <${AT}/company/6859814e|Hines> both, <https://u/brian|Brian Roach> owns it, last email <${AT}/company/6859814e/emails|2026-09-16> and again 2026-09-16.`);
  assert.equal(linkify("A & B <c>", { verdict: "clean", summary: "", citations: [] }), "A &amp; B &lt;c&gt;");
});

test("targetBlocks returns the says lines separately so multi-target messages can fold them", () => {
  const { blocks, says } = targetBlocks("cyth.com", sweep([src("salesforce", sfDeal), src("attio", attioDeal)]), "x");
  assert.equal(says.length, 2);
  assert.ok(!blocks.some((b: any) => /Valentine says/.test(text(b))));
});

test("esc escapes the mrkdwn specials only", () => {
  assert.equal(esc("A & B <c> *d*"), "A &amp; B &lt;c&gt; *d*");
});
