// Multi-CRM plumbing: config parsing/ordering and the worst-of combine rule
// that exit codes, watch, and the JSON top level all key on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCrms, activeCrms, type Config } from "../src/config.js";
import { combineVerdicts, type SourceVerdict } from "../src/sweep.js";
import { sweepToJson } from "../src/output.js";
import { exitCodeFor } from "../src/output.js";

const cfg = (over: Partial<Config>): Config => ({
  crm: "attio",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  authMethod: "api_key",
  ...over,
});

const sv = (crm: SourceVerdict["crm"], verdict: SourceVerdict["verdict"], extra: Partial<SourceVerdict> = {}): SourceVerdict => ({
  crm,
  verdict,
  summary: `${crm} says ${verdict}`,
  citations: [],
  ...extra,
});

test("parseCrms: ordered, deduped, unknowns dropped, case-insensitive", () => {
  assert.deepEqual(parseCrms("salesforce, attio"), ["salesforce", "attio"]);
  assert.deepEqual(parseCrms("Attio,attio,hubspot,salesforce"), ["attio", "salesforce"]);
  assert.deepEqual(parseCrms("nope"), []);
});

test("activeCrms: crms list wins over crm, falls back to single", () => {
  assert.deepEqual(activeCrms(cfg({})), ["attio"]);
  assert.deepEqual(activeCrms(cfg({ crm: "attio", crms: ["salesforce", "attio"] })), ["salesforce", "attio"]);
});

test("combine: single source passes through untouched (no crm tag)", () => {
  const v = combineVerdicts([sv("salesforce", "prior_contact", { owner: "Sarah" })]);
  assert.equal(v.verdict, "prior_contact");
  assert.equal(v.summary, "salesforce says prior_contact");
  assert.ok(!("crm" in v));
});

test("combine: any prior_contact wins and carries its CRM tag", () => {
  const v = combineVerdicts([sv("salesforce", "clean"), sv("attio", "prior_contact", { owner: "JP", lastTouch: "2026-05-01" })]);
  assert.equal(v.verdict, "prior_contact");
  assert.equal(v.summary, "[Attio] attio says prior_contact");
  assert.equal(v.owner, "JP"); // meta comes from the flagged source
  assert.equal(exitCodeFor(v), 10);
});

test("combine: ambiguous beats clean; both-flagged summaries join with tags", () => {
  const both = combineVerdicts([sv("salesforce", "prior_contact"), sv("attio", "prior_contact")]);
  assert.equal(both.summary, "[Salesforce] salesforce says prior_contact · [Attio] attio says prior_contact");
  const amb = combineVerdicts([sv("salesforce", "clean"), sv("attio", "ambiguous")]);
  assert.equal(amb.verdict, "ambiguous");
  assert.equal(exitCodeFor(amb), 20);
});

test("combine: all clean → primary's clean summary, citations deduped across sources", () => {
  const v = combineVerdicts([
    sv("salesforce", "clean", { citations: ["001A", "001B"] }),
    sv("attio", "clean", { citations: ["001B", "rec_1"] }),
  ]);
  assert.equal(v.verdict, "clean");
  assert.equal(v.summary, "salesforce says clean");
  assert.deepEqual(v.citations, ["001A", "001B", "rec_1"]);
  assert.equal(exitCodeFor(v), 0);
});

test("JSON: single source keeps the flat documented shape; multi adds sources[]", () => {
  const single = JSON.parse(
    sweepToJson({ combined: combineVerdicts([sv("attio", "clean")]), sources: [sv("attio", "clean")] }, "acme.com"),
  );
  assert.ok(!("sources" in single));
  assert.equal(single.target, "acme.com");

  const sources = [sv("salesforce", "prior_contact"), sv("attio", "clean")];
  const multi = JSON.parse(sweepToJson({ combined: combineVerdicts(sources), sources }, "acme.com"));
  assert.equal(multi.verdict, "prior_contact");
  assert.equal(multi.sources.length, 2);
  assert.deepEqual(multi.sources.map((s: { crm: string }) => s.crm), ["salesforce", "attio"]);
});
