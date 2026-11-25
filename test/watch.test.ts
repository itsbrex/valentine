// The watch trigger's pure logic: which targets a meeting produces, and the
// notification line per verdict. Calendar/notification side effects live in
// src/calendar/macos.ts and src/notify.ts and are exercised manually.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepTargets, verdictLine, FREEMAIL } from "../src/watch.js";
import type { Meeting } from "../src/calendar/types.js";

const meeting = (attendees: Meeting["attendees"]): Meeting => ({
  id: "ev1",
  title: "Intro call",
  start: Date.now() + 25 * 60 * 1000,
  attendees,
});

test("external domains are swept; your own side is excluded via the self attendee", () => {
  const m = meeting([
    { email: "me@fund.vc", self: true },
    { email: "partner@fund.vc" },
    { email: "jane@acme.com" },
    { email: "cto@acme.com" }, // same domain → deduped
    { email: "advisor@other.io" },
  ]);
  assert.deepEqual(sweepTargets(m).sort(), ["acme.com", "other.io"]);
});

test("freemail attendees fall back to a name sweep, or are skipped without one", () => {
  const m = meeting([
    { email: "me@fund.vc", self: true },
    { email: "founder@gmail.com", name: "Jane Founder" },
    { email: "anon@yahoo.com" }, // no name → nothing to sweep
  ]);
  assert.deepEqual(sweepTargets(m), ["Jane Founder"]);
  assert.ok(FREEMAIL.has("gmail.com"));
});

test("extra own-domains are honored and case-insensitive", () => {
  const m = meeting([{ email: "Jane@ACME.com" }, { email: "bob@fund.vc" }]);
  assert.deepEqual(sweepTargets(m, ["acme.com"]), ["fund.vc"]);
});

test("meetings with no attendees or only your own side produce no targets", () => {
  assert.deepEqual(sweepTargets(meeting([])), []);
  assert.deepEqual(
    sweepTargets(meeting([{ email: "me@fund.vc", self: true }, { email: "partner@fund.vc" }])),
    [],
  );
});

test("verdict lines carry the right mark per verdict", () => {
  const base = { summary: "s", citations: [] as string[] };
  assert.equal(verdictLine("acme.com", { verdict: "prior_contact", ...base }), "⚠ acme.com — s");
  assert.equal(verdictLine("acme.com", { verdict: "clean", ...base }), "✅ acme.com — s");
  assert.equal(verdictLine("acme.com", { verdict: "ambiguous", ...base }), "❓ acme.com — s");
});
