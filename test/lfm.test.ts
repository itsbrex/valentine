// LFM2.5 output plumbing: <think> stripping and
// <|tool_call_start|>…<|tool_call_end|> tool-call parsing (Pythonic + JSON).

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripThink, parseLfmToolCalls } from "../src/lfm.js";

test("stripThink removes closed spans", () => {
  assert.equal(stripThink("<think>hmm</think>Hello"), "Hello");
  assert.equal(stripThink("a<think>x</think>b<think>y</think>c"), "abc");
});

test("stripThink removes an unclosed trailing span (truncated generation)", () => {
  assert.equal(stripThink("Hello<think>never closed"), "Hello");
});

test("stripThink leaves plain text alone", () => {
  assert.equal(stripThink("no tags here"), "no tags here");
});

// LFM2.5's chat template pre-fills the opening <think>, so real generations
// start mid-reasoning and only ever emit the closing tag. Observed live on the
// ONNX path: reasoning leaked out as the verdict summary.
test("stripThink removes a dangling close with no opener", () => {
  assert.equal(
    stripThink("The user wants me to check acme.com. I should search.</think>Found nothing."),
    "Found nothing.",
  );
  assert.equal(stripThink("reasoning only, cut off</think>"), "");
});

test("parses a Pythonic call with string args", () => {
  const { text, calls } = parseLfmToolCalls(
    'Looking…<|tool_call_start|>search_crm(object="companies", domain="acme.com")<|tool_call_end|>',
  );
  assert.equal(text, "Looking…");
  assert.deepEqual(calls, [
    { name: "search_crm", input: { object: "companies", domain: "acme.com" } },
  ]);
});

test("parses numbers, booleans (both casings), and None/null", () => {
  const { calls } = parseLfmToolCalls(
    "<|tool_call_start|>f(n=3, x=2.5, a=True, b=false, c=None, d=null)<|tool_call_end|>",
  );
  assert.deepEqual(calls[0].input, { n: 3, x: 2.5, a: true, b: false, c: null, d: null });
});

test("parses escaped quotes and single-quoted strings", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>f(s="he said \\"hi\\"", t=\'ok\')<|tool_call_end|>',
  );
  assert.deepEqual(calls[0].input, { s: 'he said "hi"', t: "ok" });
});

test("parses list and dict arguments", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>submit_verdict(verdict="clean", citations=["a", "b"], meta={"k": 1})<|tool_call_end|>',
  );
  assert.deepEqual(calls[0].input, {
    verdict: "clean",
    citations: ["a", "b"],
    meta: { k: 1 },
  });
});

// The exact byte sequence LFM2.5-2.6B-ONNX produced on a live run — calls come
// wrapped in a Python list, and single-quoted. Guessing from docs got this wrong.
test("parses the real bracket-wrapped list form", () => {
  const { text, calls } = parseLfmToolCalls(
    "<|tool_call_start|>[search_crm(domain='acme.com')]<|tool_call_end|><|im_end|>",
  );
  assert.deepEqual(calls, [{ name: "search_crm", input: { domain: "acme.com" } }]);
  assert.equal(text, "<|im_end|>");
});

test("parses several calls in one bracketed list", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>[search_crm(domain="a.com"), get_context(object="companies", record_id="r1")]<|tool_call_end|>',
  );
  assert.deepEqual(calls, [
    { name: "search_crm", input: { domain: "a.com" } },
    { name: "get_context", input: { object: "companies", record_id: "r1" } },
  ]);
});

test("a list argument inside a call is not mistaken for a call separator", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>[submit_verdict(verdict="clean", citations=["a", "b"])]<|tool_call_end|>',
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { verdict: "clean", citations: ["a", "b"] });
});

test("parses the JSON array call form", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>[{"name": "search_crm", "arguments": {"domain": "acme.com"}}]<|tool_call_end|>',
  );
  assert.deepEqual(calls, [{ name: "search_crm", input: { domain: "acme.com" } }]);
});

test("parses the JSON call form", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>{"name": "search_crm", "arguments": {"domain": "acme.com"}}<|tool_call_end|>',
  );
  assert.deepEqual(calls, [{ name: "search_crm", input: { domain: "acme.com" } }]);
});

test("multiple calls in one message, prose preserved around them", () => {
  const { text, calls } = parseLfmToolCalls(
    "a <|tool_call_start|>f(x=1)<|tool_call_end|> b <|tool_call_start|>g(y=2)<|tool_call_end|>",
  );
  assert.equal(text, "a  b");
  assert.deepEqual(calls.map((c) => c.name), ["f", "g"]);
});

test("unparseable span degrades to no call, not a throw", () => {
  const { calls } = parseLfmToolCalls("<|tool_call_start|>???<|tool_call_end|>");
  assert.deepEqual(calls, []);
});

// A stray positional argument must not discard the keyword args that follow —
// a silently arg-less search_crm would report "no prior contact" on a company
// the CRM actually knows.
test("positional args are skipped, later keyword args still parsed", () => {
  const { calls } = parseLfmToolCalls(
    '<|tool_call_start|>search_crm("companies", domain="acme.com")<|tool_call_end|>',
  );
  assert.deepEqual(calls[0].input, { domain: "acme.com" });
});

test("malformed argument lists terminate instead of hanging", () => {
  for (const body of ["f(,,,)", "f(1, 2, 3)", "f(=)", "f(((", 'f("unterminated']) {
    const { calls } = parseLfmToolCalls(`<|tool_call_start|>${body}<|tool_call_end|>`);
    assert.ok(Array.isArray(calls));
  }
});

test("no markers → text untouched, no calls", () => {
  const { text, calls } = parseLfmToolCalls("plain prose");
  assert.equal(text, "plain prose");
  assert.deepEqual(calls, []);
});
