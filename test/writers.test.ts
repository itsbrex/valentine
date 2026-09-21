// The opt-in writers against a mocked fetch: which REST calls each write
// makes and with what body, that the factory hands out nothing unless writes
// are switched on, and that a workspace without an owner attribute says so
// instead of writing somewhere wrong.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SalesforceSession } from "../src/connectors/salesforce.js";
import { SalesforceWriter, splitName } from "../src/writers/salesforce.js";
import { AttioWriter } from "../src/writers/attio.js";
import { makeWriter } from "../src/writers/index.js";
import type { Config } from "../src/config.js";

const realFetch = globalThis.fetch;
let calls: { method: string; url: string; body?: any }[] = [];

function mockFetch(handler: (method: string, url: string, body?: any) => unknown) {
  calls = [];
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });
    const out = handler(method, String(url), body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.VALENTINE_WRITES;
});

const cfg = (over: Partial<Config> = {}): Config => ({ crm: "attio", provider: "anthropic", model: "m", authMethod: "api_key", ...over });

// ─── factory ────────────────────────────────────────────────────────────────

test("makeWriter: nothing unless writes are on; env wins over config", () => {
  const c = cfg({ attioKey: "k", salesforceKey: "t", salesforceInstanceUrl: "https://o.my.salesforce.com" });
  assert.equal(makeWriter(c, "attio"), undefined);
  assert.equal(makeWriter({ ...c, writes: true }, "attio")?.name, "Attio");
  assert.equal(makeWriter({ ...c, writes: true }, "salesforce")?.name, "Salesforce");
  assert.equal(makeWriter({ ...c, writes: true }, "affinity"), undefined);
  process.env.VALENTINE_WRITES = "0";
  assert.equal(makeWriter({ ...c, writes: true }, "attio"), undefined);
  process.env.VALENTINE_WRITES = "1";
  assert.equal(makeWriter(c, "salesforce")?.name, "Salesforce");
  assert.equal(makeWriter(cfg({ writes: true }), "salesforce"), undefined); // no SF creds
});

// ─── Salesforce ──────────────────────────────────────────────────────────────

const sf = () => new SalesforceWriter(new SalesforceSession("tok", "https://org.my.salesforce.com"));
const REST = "https://org.my.salesforce.com/services/data/v59.0";

test("splitName: first/last, single token is the (required) last name", () => {
  assert.deepEqual(splitName("Ted Bruenich"), { FirstName: "Ted", LastName: "Bruenich" });
  assert.deepEqual(splitName("Cher"), { LastName: "Cher" });
  assert.deepEqual(splitName("Mary Ann van der Berg"), { FirstName: "Mary", LastName: "Ann van der Berg" });
  assert.deepEqual(splitName(""), {});
});

test("SF claimOwner: defaults to the session user (chatter/users/me) and PATCHes OwnerId on the right sObject", async () => {
  mockFetch((m, url) => (url.endsWith("/chatter/users/me") ? { id: "005ME", name: "Brian Roach" } : m === "PATCH" ? new Response(null, { status: 204 }) : {}));
  const r = await sf().claimOwner("companies", "001ACC");
  assert.deepEqual(calls.map((c) => [c.method, c.url.replace(REST, "")]), [["GET", "/chatter/users/me"], ["PATCH", "/sobjects/Account/001ACC"]]);
  assert.deepEqual(calls[1].body, { OwnerId: "005ME" });
  assert.equal(r.url, "https://org.my.salesforce.com/lightning/r/Account/001ACC/view");
  assert.match(r.label, /owner set to Brian Roach/);
  // a Lead id → Lead, an explicit owner → no whoami
  await sf().claimOwner("people", "00QLEAD", "005X");
  assert.deepEqual(calls.at(-1)!.url.replace(REST, ""), "/sobjects/Lead/00QLEAD");
  assert.deepEqual(calls.at(-1)!.body, { OwnerId: "005X" });
});

test("SF createLead: Company/Website/name split/LeadSource=Valentine; LastName falls back to the company", async () => {
  mockFetch(() => ({ id: "00QNEW", success: true }));
  const r = await sf().createLead!({ name: "Acme", domain: "acme.com", person: "Jane Founder", email: "jane@acme.com", note: "Attio: https://app.attio.com/x/company/1" });
  assert.equal(calls[0].url, `${REST}/sobjects/Lead`);
  assert.deepEqual(calls[0].body, { Company: "Acme", Website: "https://acme.com", FirstName: "Jane", LastName: "Founder", Email: "jane@acme.com", LeadSource: "Valentine", Description: "Attio: https://app.attio.com/x/company/1" });
  assert.equal(r.url, "https://org.my.salesforce.com/lightning/r/Lead/00QNEW/view");
  await sf().createLead!({ name: "Acme" });
  assert.deepEqual(calls.at(-1)!.body, { Company: "Acme", LastName: "Acme", LeadSource: "Valentine" });
});

test("SF logActivity: a meeting is an Event (WhatId for Accounts), a call/note a completed Task (WhoId for Contacts)", async () => {
  mockFetch(() => ({ id: "00UEV" }));
  await sf().logActivity("companies", "001A", { kind: "meeting", subject: "Intro", at: "2026-10-01T15:00:00.000Z" });
  assert.equal(calls[0].url, `${REST}/sobjects/Event`);
  assert.deepEqual(calls[0].body, { Subject: "Intro", WhatId: "001A", StartDateTime: "2026-10-01T15:00:00.000Z", DurationInMinutes: 30 });
  await sf().logActivity("people", "003C", { kind: "call", subject: "Called Ted", at: "2026-10-02", note: "warm" });
  assert.equal(calls.at(-1)!.url, `${REST}/sobjects/Task`);
  assert.deepEqual(calls.at(-1)!.body, { Subject: "Called Ted", WhoId: "003C", Status: "Completed", ActivityDate: "2026-10-02", Description: "warm" });
});

test("SF crosslink: appends the other CRM's link to Description, and is idempotent", async () => {
  let desc = "existing notes";
  mockFetch((m, _url, body) => {
    if (m === "GET") return { Description: desc };
    desc = body.Description;
    return new Response(null, { status: 204 });
  });
  const w = sf();
  const r1 = await w.crosslink("companies", "001A", { crm: "Attio", id: "rec_9", url: "https://app.attio.com/x/company/rec_9" });
  assert.equal(desc, "existing notes\nAttio: https://app.attio.com/x/company/rec_9");
  assert.match(r1.label, /written/);
  const r2 = await w.crosslink("companies", "001A", { crm: "Attio", id: "rec_9", url: "https://app.attio.com/x/company/rec_9" });
  assert.match(r2.label, /already links/);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
});

test("SF: an expired session on a write is the same SalesforceAuthError the reader throws", async () => {
  mockFetch(() => new Response("Session expired or invalid", { status: 401 }));
  await assert.rejects(sf().addNote("companies", "001A", "hi"), /SALESFORCE_AUTH|session expired/i);
});

// ─── Attio ───────────────────────────────────────────────────────────────────

const ATTIO = "https://api.attio.com/v2";
const at = () => new AttioWriter("wkey");

test("Attio createCompany + createPerson: standard attributes only, person attached to the company, source note on each", async () => {
  mockFetch((_m, url, body) => {
    if (url.endsWith("/objects/companies/records")) return { data: { id: { record_id: "c_1" }, web_url: "https://app.attio.com/ws/company/c_1", values: body.data.values } };
    if (url.endsWith("/objects/people/records")) return { data: { id: { record_id: "p_1" }, web_url: "https://app.attio.com/ws/person/p_1" } };
    if (url.endsWith("/notes")) return { data: { id: { note_id: "n_1" } } };
    return {};
  });
  const w = at();
  const c = await w.createCompany({ name: "FPBA", domain: "fpbarch.com", note: "Salesforce: https://x/003C" });
  assert.deepEqual(calls[0].body, { data: { values: { name: "FPBA", domains: ["fpbarch.com"] } } });
  assert.deepEqual(calls[1].body, { data: { parent_object: "companies", parent_record_id: "c_1", title: "Source", format: "plaintext", content: "Salesforce: https://x/003C" } });
  assert.equal(c.url, "https://app.attio.com/ws/company/c_1");
  const p = await w.createPerson({ name: "Ted Bruenich", email: "ted@fpbarch.com", companyId: "c_1" });
  assert.deepEqual(calls[2].body, { data: { values: {
    name: [{ first_name: "Ted", last_name: "Bruenich", full_name: "Ted Bruenich" }],
    email_addresses: ["ted@fpbarch.com"],
    company: [{ target_object: "companies", target_record_id: "c_1" }],
  } } });
  assert.equal(p.url, "https://app.attio.com/ws/person/p_1");
  assert.ok(calls.every((c) => (c.url.startsWith(ATTIO))));
});

test("Attio claimOwner: finds the writable actor-reference 'owner' attribute and PATCHes it to the token's member; says so when there is none", async () => {
  mockFetch((m, url) => {
    if (url.endsWith("/self")) return { authorized_by_workspace_member_id: "wm_me", workspace_slug: "ws" };
    if (url.endsWith("/objects/companies/attributes")) return { data: [{ api_slug: "name", type: "text" }, { api_slug: "owner", title: "Owner", type: "actor-reference", is_writable: true }] };
    if (m === "PATCH") return { data: { web_url: "https://app.attio.com/ws/company/c_1" } };
    return {};
  });
  const r = await at().claimOwner("companies", "c_1");
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.url, `${ATTIO}/objects/companies/records/c_1`);
  assert.deepEqual(patch.body, { data: { values: { owner: [{ referenced_actor_type: "workspace-member", referenced_actor_id: "wm_me" }] } } });
  assert.equal(r.url, "https://app.attio.com/ws/company/c_1");

  mockFetch((_m, url) => (url.endsWith("/attributes") ? { data: [{ api_slug: "name", type: "text" }] } : {}));
  await assert.rejects(at().claimOwner("companies", "c_1"), /no owner attribute/);
  assert.ok(!calls.some((c) => c.method === "PATCH"));
});

test("Attio rematch: PUTs the domain off the wrong company, notes it, creates the right one owning the domain", async () => {
  mockFetch((m, url, body) => {
    if (m === "GET") return { data: { web_url: "https://app.attio.com/ws/company/wrong", values: { name: [{ value: "Language Services Associates" }], domains: [{ domain: "waremalcomb.com" }, { domain: "lsa.com" }] } } };
    if (m === "POST" && url.endsWith("/objects/companies/records")) return { data: { id: { record_id: "right" }, web_url: "https://app.attio.com/ws/company/right", values: body.data.values } };
    if (url.endsWith("/notes")) return { data: { id: { note_id: "n" } } };
    return {};
  });
  const r = await at().rematch!("waremalcomb.com", "wrong", { name: "Ware Malcomb", note: "Salesforce: https://x/001W" });
  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.url, `${ATTIO}/objects/companies/records/wrong`);
  assert.deepEqual(put.body, { data: { values: { domains: ["lsa.com"] } } });
  const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/objects/companies/records"))!;
  assert.deepEqual(create.body, { data: { values: { name: "Ware Malcomb", domains: ["waremalcomb.com"] } } });
  assert.equal(calls.filter((c) => c.url.endsWith("/notes")).length, 2);
  assert.match(r.label, /moved from "Language Services Associates" to new company Ware Malcomb/);
});

test("Attio crosslink and logActivity are notes on the record — no invented attributes", async () => {
  mockFetch(() => ({ data: { id: { note_id: "n" } } }));
  await at().crosslink("people", "p_1", { crm: "Salesforce", id: "003C", url: "https://x/003C" });
  assert.deepEqual(calls[0].body.data, { parent_object: "people", parent_record_id: "p_1", title: "Salesforce record", format: "plaintext", content: "Salesforce: https://x/003C" });
  await at().logActivity("companies", "c_1", { kind: "meeting", subject: "Bi-weekly", at: "2026-10-01T15:00:00Z" });
  assert.equal(calls[1].body.data.title, "Meeting · 2026-10-01 · Bi-weekly");
});

test("Attio claimOwner: falls back to a select 'owner' attribute, writing the member's name and email", async () => {
  // Attio ships no standard owner field. A workspace downstream of Salesforce
  // typically mirrors it as a select of rep names plus an email text field —
  // there is no actor-reference to point at, so the claim writes the name.
  mockFetch((m, url) => {
    if (url.endsWith("/self")) return { authorized_by_workspace_member_id: "wm_me", workspace_slug: "ws" };
    if (url.endsWith("/workspace_members"))
      return { data: [{ id: { workspace_member_id: "wm_me" }, first_name: "Dana", last_name: "Reed", email_address: "dana@personal.example" }] };
    if (url.endsWith("/objects/companies/attributes"))
      return {
        data: [
          { api_slug: "name", type: "text" },
          { api_slug: "account_owner", title: "Account Owner", type: "select", is_writable: true },
          { api_slug: "account_owner_s_email", title: "Account Owner's Email", type: "text", is_writable: true },
        ],
      };
    if (m === "PATCH") return { data: { web_url: "https://app.attio.com/ws/company/c_1" } };
    return {};
  });

  const r = await at().claimOwner("companies", "c_1");
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual(patch.body, { data: { values: { account_owner: "Dana Reed", account_owner_s_email: "dana@personal.example" } } });
  assert.match(r.label, /account_owner set to Dana Reed/);
});

test("Attio claimOwner: the configured identity wins over the Attio login, for a mirrored owner field", async () => {
  // The Attio login can be a personal address while the owner field mirrors a
  // work identity — that is what attioOwnerName/Email exist for.
  mockFetch((m, url) => {
    if (url.endsWith("/self")) return { authorized_by_workspace_member_id: "wm_me", workspace_slug: "ws" };
    if (url.endsWith("/workspace_members")) return { data: [{ id: { workspace_member_id: "wm_me" }, first_name: "Dana", last_name: "Reed", email_address: "dana@personal.example" }] };
    if (url.endsWith("/attributes"))
      return { data: [{ api_slug: "account_owner", title: "Account Owner", type: "select", is_writable: true }, { api_slug: "account_owner_s_email", type: "text", is_writable: true }] };
    if (m === "PATCH") return { data: {} };
    return {};
  });

  await new AttioWriter("wkey", { name: "Dana Reed", email: "dana@work.example" }).claimOwner("companies", "c_1");
  assert.deepEqual(calls.find((c) => c.method === "PATCH")!.body, {
    data: { values: { account_owner: "Dana Reed", account_owner_s_email: "dana@work.example" } },
  });
});

test("Attio claimOwner: a select option that does not exist explains itself instead of leaking a raw 400", async () => {
  // A member token cannot add select options (object_configuration is
  // read-only), so the only fix is a human adding the option in Attio.
  mockFetch((m, url) => {
    if (url.endsWith("/self")) return { authorized_by_workspace_member_id: "wm_me" };
    if (url.endsWith("/workspace_members")) return { data: [] };
    if (url.endsWith("/attributes")) return { data: [{ api_slug: "account_owner", title: "Account Owner", type: "select", is_writable: true }] };
    if (m === "PATCH") return new Response(JSON.stringify({ message: "Unknown select option" }), { status: 400 });
    return {};
  });

  await assert.rejects(
    new AttioWriter("wkey", { name: "Nobody Here" }).claimOwner("companies", "c_1"),
    /a select only accepts an option that already exists/,
  );
});

test("Attio claimOwner: an actor-reference attribute still wins over a select", async () => {
  mockFetch((m, url) => {
    if (url.endsWith("/self")) return { authorized_by_workspace_member_id: "wm_me" };
    if (url.endsWith("/workspace_members")) return { data: [] };
    if (url.endsWith("/attributes"))
      return { data: [{ api_slug: "account_owner", type: "select", is_writable: true }, { api_slug: "owner", type: "actor-reference", is_writable: true }] };
    if (m === "PATCH") return { data: {} };
    return {};
  });
  await at().claimOwner("companies", "c_1");
  assert.deepEqual(calls.find((c) => c.method === "PATCH")!.body, {
    data: { values: { owner: [{ referenced_actor_type: "workspace-member", referenced_actor_id: "wm_me" }] } },
  });
});
