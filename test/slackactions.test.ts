// The interactivity endpoint's logic without HTTP: payload parsing, the
// write gate, the local-only ··· menu (mutes on disk), signature checks with
// one or several secrets, and the calendar link helpers the meeting card uses.

import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseActionValue, handleCardAction, handleMenu } from "../src/slackactions.js";
import { verifySignature, handleInteraction } from "../src/slack.js";
import { loadMutes, isQuiet, mute, markHandled } from "../src/mutes.js";
import { joinUrlOf, eventUrl } from "../src/calendar/macos.js";
import type { Config } from "../src/config.js";
import type { ModelClient } from "../src/models.js";

const cfg = (over: Partial<Config> = {}): Config => ({ crm: "attio", provider: "anthropic", model: "m", authMethod: "api_key", ...over });
const noModel: ModelClient = { messages: { create: async () => ({ content: [] }) } };

beforeEach(() => {
  process.env.VALENTINE_MUTES_FILE = join(mkdtempSync(join(tmpdir(), "valentine-mutes-")), "mutes.json");
});
afterEach(() => {
  delete process.env.VALENTINE_MUTES_FILE;
  delete process.env.VALENTINE_WRITES;
});

test("parseActionValue: JSON with an op is a card action, `op|arg` is a menu op, anything else is nothing", () => {
  assert.deepEqual(parseActionValue('{"op":"claim","crm":"attio","object":"companies","id":"c1"}'), { op: "claim", crm: "attio", object: "companies", id: "c1" });
  assert.deepEqual(parseActionValue("mute|acme.com"), { menu: "mute", args: ["acme.com"] });
  assert.deepEqual(parseActionValue("copy|SF|001A"), { menu: "copy", args: ["SF", "001A"] });
  assert.equal(parseActionValue('{"nope":1}'), undefined);
  assert.equal(parseActionValue("delete|everything"), undefined);
  assert.equal(parseActionValue("{broken"), undefined);
  assert.equal(parseActionValue(undefined), undefined);
});

test("handleCardAction: refused when writes are off — no writer is even built", async () => {
  const r = await handleCardAction(cfg({ attioKey: "k" }), { op: "claim", crm: "attio", object: "companies", id: "c1" });
  assert.match(r.text, /^⛔ Writes are off/);
  process.env.VALENTINE_WRITES = "false";
  const r2 = await handleCardAction(cfg({ attioKey: "k", writes: true }), { op: "claim", crm: "attio", object: "companies", id: "c1" });
  assert.match(r2.text, /^⛔ Writes are off/);
});

test("handleCardAction: with writes on, a CRM without credentials is a clear refusal, and bad payloads never reach a writer", async () => {
  const c = cfg({ writes: true, attioKey: "k" });
  assert.match((await handleCardAction(c, { op: "claim", crm: "salesforce", object: "companies", id: "001A" })).text, /Salesforce is not configured for writes/);
  assert.match((await handleCardAction(c, { op: "claim", crm: "attio", object: "companies", id: "" })).text, /Bad claim payload/);
  assert.match((await handleCardAction(c, { op: "crosslink", sf: { object: "companies", id: "" }, attio: { object: "companies", id: "c" } })).text, /Bad cross-link payload/);
  assert.match((await handleCardAction(c, { op: "attio_create" } as any)).text, /Nothing to create/);
  assert.match((await handleCardAction(c, { op: "nope" } as any)).text, /Unknown action/);
});

test("menu: mute and handled land in the mutes file and make the target quiet for the watch loop", async () => {
  const r = await handleMenu(cfg(), noModel, "mute", ["Acme.com"]);
  assert.match(r.text, /acme\.com muted for 30 days/);
  const m = loadMutes();
  assert.ok(m.muted["acme.com"] > Date.now() + 29 * 24 * 3600 * 1000);
  assert.ok(isQuiet("ACME.com", m));
  assert.ok(!isQuiet("other.com", m));
  await handleMenu(cfg(), noModel, "handled", ["Jane Doe"]);
  assert.ok(isQuiet("jane doe"));
  assert.match((await handleMenu(cfg(), noModel, "copy", ["SF", "001A"])).text, /SF id: `001A`/);
  assert.match((await handleMenu(cfg(), noModel, "mute", [])).text, /No domain/);
});

test("mutes: expired mutes and day-old handled marks are dropped on load", () => {
  const file = process.env.VALENTINE_MUTES_FILE!;
  mute("gone.com", -1, file);
  markHandled("fresh.com", file);
  const m = loadMutes(file);
  assert.deepEqual(Object.keys(m.muted), []);
  assert.deepEqual(Object.keys(m.handled), ["fresh.com"]);
});

test("handleInteraction: only block_actions; an overflow selection routes to the menu, a button to the card handler", async () => {
  assert.match((await handleInteraction(cfg(), noModel, { type: "view_submission" })).text, /Unsupported/);
  const r = await handleInteraction(cfg(), noModel, { type: "block_actions", user: { username: "brian" }, actions: [{ type: "overflow", selected_option: { value: "copy|Attio|rec_1" } }] });
  assert.match(r.text, /Attio id: `rec_1`/);
  const w = await handleInteraction(cfg({ attioKey: "k" }), noModel, { type: "block_actions", actions: [{ type: "button", value: '{"op":"claim","crm":"attio","object":"companies","id":"c1"}' }] });
  assert.match(w.text, /Writes are off/);
  assert.match((await handleInteraction(cfg(), noModel, { type: "block_actions", actions: [{ type: "button", value: "???" }] })).text, /nothing Valentine understands/);
});

test("verifySignature: v0 HMAC over ts+body, replay window, and any one of several comma-separated secrets", () => {
  const raw = "text=acme.com&response_url=https%3A%2F%2Fhooks";
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = (secret: string) => "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex");
  const req = (sig: string, t = ts) => ({ headers: { "x-slack-request-timestamp": t, "x-slack-signature": sig } });
  assert.ok(verifySignature("s1", req(sign("s1")), raw));
  assert.ok(!verifySignature("s1", req(sign("s2")), raw));
  assert.ok(verifySignature("s1, s2", req(sign("s2")), raw));
  assert.ok(!verifySignature("s1", req(sign("s1"), String(Number(ts) - 600)), raw));
  assert.ok(!verifySignature("s1", { headers: {} }, raw));
});

test("calendar links: the conferencing URL is pulled from the URL field, location or notes; the event link opens Calendar.app", () => {
  assert.equal(joinUrlOf({ link: "https://us02web.zoom.us/j/123?pwd=abc" }), "https://us02web.zoom.us/j/123?pwd=abc");
  assert.equal(joinUrlOf({ location: "Room 4 — https://meet.google.com/abc-defg-hij." }), "https://meet.google.com/abc-defg-hij");
  assert.equal(joinUrlOf({ notes: "Join: <https://teams.microsoft.com/l/meetup-join/19%3ameeting_x>" }), "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x");
  assert.equal(joinUrlOf({ link: "https://example.com/agenda", notes: "no call link" }), undefined);
  assert.equal(eventUrl("ABC-123:xyz"), "ical://ekevent/ABC-123%3Axyz?method=show&options=more");
});

// ─── w09: the Add-note modal and the shared brief ───────────────────────────

test("add_note opens a modal instead of writing — it carries the target and the card's response_url", async () => {
  process.env.VALENTINE_WRITES = "1";
  const r = await handleCardAction(cfg(), { op: "add_note", target: "acme.com", name: "Acme" }, { responseUrl: "https://hooks.slack.test/r/1" });
  assert.ok(r.openModal, "a modal, not a write");
  const v: any = r.openModal;
  assert.equal(v.callback_id, "valentine_note");
  assert.deepEqual(JSON.parse(v.private_metadata), { target: "acme.com", ru: "https://hooks.slack.test/r/1" });
  assert.equal(v.blocks[1].element.action_id, "text");
  assert.ok(v.blocks[1].element.multiline);
});

test("add_note is refused outright when writes are off — no modal is opened", async () => {
  const r = await handleCardAction(cfg(), { op: "add_note", target: "acme.com" });
  assert.equal(r.openModal, undefined);
  assert.match(r.text, /Writes are off/);
});

test("the modal's submission is routed to the note path and answers on the card's response_url", async () => {
  process.env.VALENTINE_WRITES = "1";
  const payload = {
    type: "view_submission",
    user: { username: "brian" },
    view: {
      callback_id: "valentine_note",
      private_metadata: JSON.stringify({ target: "acme.com", ru: "https://hooks.slack.test/r/1" }),
      state: { values: { note: { text: { value: "  Met Jane at SaaStr — warm.  " } } } },
    },
  };
  // No CRM key on this config, so the sweep finds nothing and the note path
  // says so — what matters here is the routing and where the answer goes.
  const r = await handleInteraction(cfg(), noModel, payload);
  assert.equal(r.postTo, "https://hooks.slack.test/r/1", "a view_submission carries no response_url of its own");
  assert.ok(r.text.length > 0);
});

test("an empty note writes nothing, and an unknown modal is not answered", async () => {
  process.env.VALENTINE_WRITES = "1";
  const view = { callback_id: "valentine_note", private_metadata: JSON.stringify({ target: "acme.com" }), state: { values: { note: { text: { value: "   " } } } } };
  const r = await handleInteraction(cfg(), noModel, { type: "view_submission", view });
  assert.match(r.text, /Empty note/);

  const other = await handleInteraction(cfg(), noModel, { type: "view_submission", view: { callback_id: "something_else" } });
  assert.match(other.text, /Unsupported modal/);
});

test("the ··· menu's Prep brief posts in channel and appends the Lab replay link", async () => {
  const render = (t: string) => ({ text: `card for ${t}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: t } }] });
  const r = await handleMenu(cfg(), noModel, "brief", ["acme.com", "https://lab.test/?run=abc"], render as any);
  assert.equal(r.inChannel, true, "the point is that the channel sees it");
  assert.equal(r.replace, undefined, "it adds a message, it does not replace the card");
  assert.match(JSON.stringify(r.blocks!.at(-1)), /Replay this sweep in the Lab/);

  // …and without a run link it is just the card, shared.
  const bare = await handleMenu(cfg(), noModel, "brief", ["acme.com", ""], render as any);
  assert.equal(bare.blocks!.length, 1);
});
