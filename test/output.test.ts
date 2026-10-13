// The machine contract: --json shape and the exit-code mapping every caller
// branches on (0 clean · 10 prior contact · 20 ambiguous; 1 = error is the
// CLI's top-level catch). Plus the submit_verdict → Verdict mapping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { exitCodeFor, toJson } from "../src/output.js";
import { toVerdict } from "../src/tools.js";
import type { Verdict } from "../src/connectors/types.js";

const verdict = (v: Verdict["verdict"]): Verdict => ({ verdict: v, summary: "s", citations: [] });

test("exit codes: 0 clean · 10 prior contact · 20 ambiguous", () => {
  assert.equal(exitCodeFor(verdict("clean")), 0);
  assert.equal(exitCodeFor(verdict("prior_contact")), 10);
  assert.equal(exitCodeFor(verdict("ambiguous")), 20);
});

test("--json emits the documented object shape", () => {
  const full: Verdict = {
    verdict: "prior_contact",
    summary: "Sarah emailed Acme's founder 3 weeks ago.",
    owner: "Sarah Lee",
    lastTouch: "2026-05-12",
    status: "passed, too early",
    citations: ["rec_abc", "rec_def"],
  };
  const parsed = JSON.parse(toJson(full, "acme.com"));
  assert.deepEqual(parsed, { target: "acme.com", ...full });
});

test("--json omits absent optional fields instead of emitting null", () => {
  const parsed = JSON.parse(toJson(verdict("clean"), "acme.com"));
  assert.deepEqual(Object.keys(parsed).sort(), ["citations", "summary", "target", "verdict"]);
});

test("toVerdict maps snake_case and defends against a non-array citations", () => {
  const v = toVerdict({
    verdict: "prior_contact",
    summary: "s",
    last_touch: "2026-05-12",
    citations: "rec_abc", // model misbehaving — must coerce to []
  });
  assert.equal(v.lastTouch, "2026-05-12");
  assert.deepEqual(v.citations, []);
});
