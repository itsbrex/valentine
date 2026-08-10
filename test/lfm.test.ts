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

test("no markers → text untouched, no calls", () => {
  const { text, calls } = parseLfmToolCalls("plain prose");
  assert.equal(text, "plain prose");
  assert.deepEqual(calls, []);
});
