// The slack DM channel against a mocked fetch — the only notify channel with
// network I/O. macos/fullscreen shell out to osascript and are exercised
// manually; stdout is trivial.

import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/notify.js";

const realFetch = globalThis.fetch;
let calls: { url: string; body: any }[] = [];
const ENV = ["VALENTINE_SLACK_BOT_TOKEN", "VALENTINE_SLACK_DM_USER"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  calls = [];
  for (const k of ENV) saved[k] = process.env[k];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function mockSlack(responses: Record<string, unknown>) {
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const method = String(url).split("/api/")[1];
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(responses[method] ?? { ok: false, error: "unknown_method" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

test("slack: missing env produces a clear setup error, no network call", async () => {
  delete process.env.VALENTINE_SLACK_BOT_TOKEN;
  delete process.env.VALENTINE_SLACK_DM_USER;
  await assert.rejects(() => notify("slack", "t", "b"), /VALENTINE_SLACK_BOT_TOKEN/);
  assert.equal(calls.length, 0);
});

test("slack: opens the DM conversation, then posts the verdict text", async () => {
  process.env.VALENTINE_SLACK_BOT_TOKEN = "xoxb-test";
  process.env.VALENTINE_SLACK_DM_USER = "U0FOUNDER";
  mockSlack({
    "conversations.open": { ok: true, channel: { id: "D42" } },
    "chat.postMessage": { ok: true },
  });

  await notify("slack", "Intro call in 28 min", "⚠ acme.com — Sarah emailed 3 weeks ago");

  assert.deepEqual(calls.map((c) => c.url.split("/api/")[1]), ["conversations.open", "chat.postMessage"]);
  assert.deepEqual(calls[0].body, { users: "U0FOUNDER" });
  assert.equal(calls[1].body.channel, "D42");
  assert.match(calls[1].body.text, /^✦ Intro call in 28 min\n⚠ acme\.com/);
});

test("slack: API-level errors surface with the Slack error code", async () => {
  process.env.VALENTINE_SLACK_BOT_TOKEN = "xoxb-test";
  process.env.VALENTINE_SLACK_DM_USER = "U0FOUNDER";
  mockSlack({ "conversations.open": { ok: false, error: "missing_scope" } });
  await assert.rejects(() => notify("slack", "t", "b"), /conversations\.open: missing_scope/);
});
