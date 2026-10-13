// The agent loop, driven by a scripted ModelClient — no network, no model.
// Covers: tool round-trips ending in a verdict, the early-exit-without-verdict
// path, and the 10-turn cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lookup } from "../src/agent.js";
import type { ModelClient } from "../src/models.js";
import type { CRMConnector, CRMMatch, CRMContext } from "../src/connectors/types.js";

/** A connector that records calls and returns canned data. */
function fakeCrm() {
  const calls: { search: unknown[]; getContext: unknown[] } = { search: [], getContext: [] };
  const match: CRMMatch = { recordId: "rec_1", object: "companies", name: "Acme" };
  const context: CRMContext = { notes: ["passed, too early"], lists: [], people: [] };
  const crm: CRMConnector = {
    name: "Fake",
    whoami: async () => ({ workspace: "test" }),
    search: async (q) => {
      calls.search.push(q);
      return [match];
    },
    getContext: async (object, id) => {
      calls.getContext.push([object, id]);
      return context;
    },
  };
  return { crm, calls, match, context };
}

/** A ModelClient that replays scripted turns and records every request. */
function scriptedClient(turns: unknown[][]) {
  const requests: { messages: unknown[] }[] = [];
  let i = 0;
  const client: ModelClient = {
    messages: {
      create: async (req) => {
        requests.push({ messages: [...req.messages] });
        const content = turns[Math.min(i, turns.length - 1)];
        i++;
        return { content: content as never };
      },
    },
  };
  return { client, requests };
}

const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
});

test("runs read tools, feeds results back, captures the verdict", async () => {
  const { crm, calls, match } = fakeCrm();
  const { client, requests } = scriptedClient([
    [toolUse("t1", "search_crm", { object: "companies", domain: "acme.com" })],
    [
      toolUse("t2", "submit_verdict", {
        verdict: "prior_contact",
        summary: "Sarah emailed Acme 3 weeks ago.",
        owner: "Sarah Lee",
        last_touch: "2026-05-12",
        citations: ["rec_1"],
      }),
    ],
  ]);

  const v = await lookup(client, "test-model", crm, "acme.com");

  assert.equal(v.verdict, "prior_contact");
  assert.equal(v.summary, "Sarah emailed Acme 3 weeks ago.");
  assert.equal(v.owner, "Sarah Lee");
  assert.equal(v.lastTouch, "2026-05-12"); // snake_case input → camelCase verdict
  assert.deepEqual(v.citations, ["rec_1"]);

  assert.deepEqual(calls.search, [{ object: "companies", domain: "acme.com", name: undefined }]);

  // Second request must carry the tool result of the first turn back to the model.
  assert.equal(requests.length, 2);
  const lastMsg = requests[1].messages.at(-1) as { role: string; content: { type: string; tool_use_id: string; content: string }[] };
  assert.equal(lastMsg.role, "user");
  assert.equal(lastMsg.content[0].type, "tool_result");
  assert.equal(lastMsg.content[0].tool_use_id, "t1");
  assert.deepEqual(JSON.parse(lastMsg.content[0].content), [match]);
});

// Small local models write "null"/"N/A" into optional fields instead of
// omitting them; rendering "Owner: null" reads as a bug to the user.
test("placeholder words in optional fields are treated as absent", async () => {
  const { crm } = fakeCrm();
  const { client } = scriptedClient([
    [
      toolUse("t1", "submit_verdict", {
        verdict: "clean",
        summary: "Nothing on file.",
        owner: "null",
        last_touch: "N/A",
        status: "  ",
        citations: [],
      }),
    ],
  ]);

  const v = await lookup(client, "test-model", crm, "acme.com");

  assert.equal(v.owner, undefined);
  assert.equal(v.lastTouch, undefined);
  assert.equal(v.status, undefined);
  assert.equal(v.summary, "Nothing on file."); // real values still pass through
});

test("text-only response → ambiguous, with the text as summary", async () => {
  const { crm } = fakeCrm();
  const { client, requests } = scriptedClient([
    [{ type: "text", text: "I could not find anything conclusive." }],
  ]);

  const v = await lookup(client, "test-model", crm, "acme.com");

  assert.equal(v.verdict, "ambiguous");
  assert.equal(v.summary, "I could not find anything conclusive.");
  assert.deepEqual(v.citations, []);
  assert.equal(requests.length, 1);
});

test("empty text-only response still yields a summary", async () => {
  const { crm } = fakeCrm();
  const { client } = scriptedClient([[{ type: "text", text: "  " }]]);
  const v = await lookup(client, "test-model", crm, "acme.com");
  assert.equal(v.verdict, "ambiguous");
  assert.equal(v.summary, "No verdict produced.");
});

test("never submitting a verdict hits the 10-turn cap", async () => {
  const { crm, calls } = fakeCrm();
  // Same tool call forever — the loop must bail after 10 turns.
  const { client, requests } = scriptedClient([
    [toolUse("t", "search_crm", { object: "companies", name: "Acme" })],
  ]);

  const v = await lookup(client, "test-model", crm, "acme.com");

  assert.equal(v.verdict, "ambiguous");
  assert.match(v.summary, /step limit/);
  assert.equal(requests.length, 10);
  assert.equal(calls.search.length, 10);
});

test("unknown tool names come back as an error result, not a crash", async () => {
  const { crm } = fakeCrm();
  const { client, requests } = scriptedClient([
    [toolUse("t1", "delete_everything", {})],
    [toolUse("t2", "submit_verdict", { verdict: "clean", summary: "ok", citations: [] })],
  ]);

  const v = await lookup(client, "test-model", crm, "acme.com");

  assert.equal(v.verdict, "clean");
  const lastMsg = requests[1].messages.at(-1) as { content: { content: string }[] };
  assert.deepEqual(JSON.parse(lastMsg.content[0].content), { error: "unknown tool: delete_everything" });
});
