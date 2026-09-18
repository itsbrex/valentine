// Connector request/response contracts against a mocked global fetch.
// Each block asserts (a) the request the connector actually makes and
// (b) the CRMMatch/CRMContext shapes it maps out of a canned API payload.
// Fixture payloads mirror the real API response shapes each connector parses.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttioConnector } from "../src/connectors/attio.js";
import { AffinityConnector } from "../src/connectors/affinity.js";
import { SalesforceConnector } from "../src/connectors/salesforce.js";

type Handler = (url: string, init?: RequestInit) => unknown;

const realFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

function mockFetch(handler: Handler) {
  calls = [];
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = handler(String(url), init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Attio ───────────────────────────────────────────────────────────────────

const attioCompany = {
  id: { record_id: "rec_1" },
  values: {
    name: [{ value: "Acme" }],
    domains: [{ domain: "acme.com" }],
    strongest_connection_user: [{ referenced_actor_id: "wm_1" }],
    strongest_connection_strength: [{ option: { title: "Very strong" } }],
    last_email_interaction: [{ interaction_type: "email", interacted_at: "2026-05-12T10:00:00Z" }],
    last_calendar_interaction: [{ interaction_type: "meeting", interacted_at: "2026-04-01T09:00:00Z" }],
    last_interaction: [{ interaction_type: "email", interacted_at: "2026-05-12T10:00:00Z" }],
    first_interaction: [{ interaction_type: "email", interacted_at: "2025-01-02T08:00:00Z" }],
    team: [{ target_record_id: "p_1" }, { target_record_id: "p_2" }],
  },
};

test("Attio: whoami parses the flat /self token-introspection shape (live-verified)", async () => {
  // Captured from a real workspace 2026-08: /self has NO `data` wrapper.
  mockFetch(() => ({
    active: true,
    workspace_id: "443d54fb-0000-0000-0000-000000000000",
    workspace_name: "team-roach",
    workspace_slug: "roach-dev",
  }));
  const who = await new AttioConnector("key").whoami();
  assert.deepEqual(who, { workspace: "team-roach" });
});

test("Attio: domain search filters on `domains` and maps the standard signals", async () => {
  mockFetch((url) => {
    if (url.includes("/records/query")) return { data: [attioCompany] };
    if (url.includes("/workspace_members"))
      return { data: [{ id: { workspace_member_id: "wm_1" }, first_name: "Sarah", last_name: "Lee" }] };
    return { data: [] };
  });

  const [m] = await new AttioConnector("key").search({ object: "companies", domain: "acme.com" });

  const query = calls.find((c) => c.url.includes("/records/query"))!;
  assert.equal(query.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(query.init?.body)), { filter: { domains: "acme.com" }, limit: 10 });
  assert.match(String(query.init?.headers && (query.init.headers as Record<string, string>).Authorization), /^Bearer key$/);

  assert.deepEqual(m, {
    recordId: "rec_1",
    object: "companies",
    name: "Acme",
    domain: "acme.com",
    owner: "Sarah Lee",
    ownerId: "wm_1",
    connectionStrength: "Very strong",
    lastEmail: "2026-05-12",
    lastMeeting: "2026-04-01",
    lastInteraction: "email · 2026-05-12",
    firstInteraction: "2025-01-02",
    linkedPeople: 2,
  });
});

test("Attio: name search uses $contains", async () => {
  mockFetch((url) => (url.includes("/records/query") ? { data: [] } : { data: [] }));
  await new AttioConnector("key").search({ object: "people", name: "Sarah" });
  const query = calls.find((c) => c.url.includes("/records/query"))!;
  assert.deepEqual(JSON.parse(String(query.init?.body)).filter, { name: { $contains: "Sarah" } });
});

test("Attio: API errors degrade to no matches, never a crash", async () => {
  mockFetch(() => new Response("boom", { status: 500 }));
  const out = await new AttioConnector("key").search({ object: "companies", domain: "acme.com" });
  assert.deepEqual(out, []);
});

test("Attio: getContext pulls notes, named lists with stage, and linked people", async () => {
  mockFetch((url) => {
    if (url.includes("/notes")) return { data: [{ content_plaintext: "passed, too early" }, { title: "Intro call" }] };
    if (url.endsWith("/entries"))
      return { data: [{ list_id: "l_1", entry_values: { stage: [{ option: { title: "In DD" } }] } }] };
    if (url.endsWith("/lists")) return { data: [{ id: { list_id: "l_1" }, name: "Pipeline" }] };
    if (url.includes("/objects/companies/records/rec_1"))
      return { data: { values: { team: [{ target_record_id: "p_1" }] } } };
    if (url.includes("/objects/people/records/p_1")) return { data: { values: { name: [{ full_name: "Jane Founder" }] } } };
    return { data: [] };
  });

  const ctx = await new AttioConnector("key").getContext("companies", "rec_1");

  // No web_url seen yet → no workspace slug → list/people links stay absent.
  assert.deepEqual(ctx, {
    notes: ["passed, too early", "Intro call"],
    lists: [{ list: "Pipeline", stage: "In DD", kind: "list", id: "l_1" }],
    people: ["Jane Founder"],
  });
});

test("Attio: web_url gives the record + tab links and teaches the workspace slug for list/people links (live-verified paths)", async () => {
  // Captured 2026-09-18: web_url = https://app.attio.com/{slug}/company/{id}; tabs /activity /emails /team;
  // lists live at /collection/{list_id}; people at /person/{id}. No /search route exists.
  mockFetch((url) => {
    if (url.includes("/records/query"))
      return { data: [{ ...attioCompany, web_url: "https://app.attio.com/roach-dev/company/rec_1" }] };
    if (url.endsWith("/entries")) return { data: [{ list_id: "l_1", list_api_slug: "pipeline", entry_values: {} }] };
    if (url.endsWith("/lists")) return { data: [{ id: { list_id: "l_1" }, name: "Pipeline" }] };
    if (url.includes("/objects/companies/records/rec_1"))
      return { data: { web_url: "https://app.attio.com/roach-dev/company/rec_1", values: { team: [{ target_record_id: "p_1" }] } } };
    if (url.includes("/objects/people/records/p_1"))
      return { data: { web_url: "https://app.attio.com/roach-dev/person/p_1", values: { name: [{ full_name: "Ed STRAZZULLA" }] } } };
    return { data: [] };
  });
  const conn = new AttioConnector("key");
  const [m] = await conn.search({ object: "companies", domain: "acme.com" });
  assert.equal(m.url, "https://app.attio.com/roach-dev/company/rec_1");
  assert.deepEqual(m.views, {
    activity: "https://app.attio.com/roach-dev/company/rec_1/activity",
    emails: "https://app.attio.com/roach-dev/company/rec_1/emails",
    people: "https://app.attio.com/roach-dev/company/rec_1/team",
  });
  assert.equal(conn.webUrls?.search?.("acme.com"), "https://app.attio.com/roach-dev/companies");

  const ctx = await conn.getContext("companies", "rec_1");
  assert.deepEqual(ctx.lists, [{ list: "Pipeline", stage: undefined, kind: "list", id: "l_1", url: "https://app.attio.com/roach-dev/collection/l_1" }]);
  assert.deepEqual(ctx.peopleLinks, [{ label: "Ed STRAZZULLA", url: "https://app.attio.com/roach-dev/person/p_1" }]);
});

// ─── Salesforce ──────────────────────────────────────────────────────────────

const soqlOf = (url: string) => decodeURIComponent(url.split("?q=")[1] ?? "");

test("Salesforce: company search queries Account by Website and maps fields", async () => {
  mockFetch((url) => {
    if (soqlOf(url).startsWith("SELECT Id, Name, Website"))
      return {
        records: [
          {
            Id: "001A",
            Name: "Acme",
            Website: "https://www.acme.com",
            OwnerId: "005S",
            Owner: { Name: "Sarah Lee", IsActive: true },
            LastActivityDate: "2026-05-12",
            Contacts: { records: [{}, {}] },
          },
        ],
      };
    return { records: [] };
  });

  const [m] = await new SalesforceConnector("tok", "https://org.my.salesforce.com/").search({
    object: "companies",
    domain: "acme.com",
  });

  const q = soqlOf(calls[0].url);
  assert.match(q, /SELECT Id, Name, Website, OwnerId, Owner\.Name, Owner\.IsActive, LastActivityDate/);
  assert.match(q, /FROM Account WHERE Website LIKE '%acme\.com%' LIMIT 10/);
  assert.ok(calls[0].url.startsWith("https://org.my.salesforce.com/services/data/"), "trailing slash stripped");

  const SF = "https://org.my.salesforce.com/lightning";
  assert.deepEqual(m, {
    recordId: "001A",
    object: "companies",
    name: "Acme",
    domain: "acme.com", // www. stripped from Website
    owner: "Sarah Lee",
    ownerId: "005S",
    ownerUrl: `${SF}/r/User/005S/view`,
    ownerActive: true,
    lastInteraction: "activity · 2026-05-12",
    linkedPeople: 2,
    url: `${SF}/r/Account/001A/view`, // click-through
    views: { activity: `${SF}/r/Account/001A/related/ActivityHistories/view`, people: `${SF}/r/Account/001A/related/Contacts/view` },
  });
});

test("Salesforce: people search by domain matches Contact email suffix and carries the Account", async () => {
  mockFetch(() => ({
    records: [{ Id: "003B", Name: "Jane Founder", Email: "jane@acme.com", AccountId: "001A", Account: { Name: "Acme" }, OwnerId: "005R", Owner: { Name: "Ravi" } }],
  }));

  const [m] = await new SalesforceConnector("tok", "https://org.my.salesforce.com").search({
    object: "people",
    domain: "acme.com",
  });

  assert.match(soqlOf(calls[0].url), /SELECT Id, Name, Email, AccountId, Account\.Name, OwnerId, Owner\.Name, Owner\.IsActive, LastActivityDate FROM Contact WHERE Email LIKE '%@acme\.com' LIMIT 10/);
  assert.equal(m.domain, "acme.com");
  assert.equal(m.owner, "Ravi");
  assert.deepEqual(m.parent, { id: "001A", label: "Acme", url: "https://org.my.salesforce.com/lightning/r/Account/001A/view" });
  assert.equal(m.views?.activity, "https://org.my.salesforce.com/lightning/r/Contact/003B/related/ActivityHistories/view");
});

test("Salesforce: a placeholder owner ('Unassigned …') reads as an owner gap", async () => {
  mockFetch(() => ({ records: [{ Id: "001H", Name: "Hines Atlanta", OwnerId: "005U", Owner: { Name: "Unassigned Atlanta", IsActive: true } }] }));
  const [m] = await new SalesforceConnector("tok", "https://org.my.salesforce.com").search({ object: "companies", name: "Hines" });
  assert.equal(m.owner, "Unassigned Atlanta");
  assert.equal(m.ownerActive, false);
});

test("Salesforce: webUrls.create builds prefilled Lightning forms, values URL-encoded, nothing fetched", async () => {
  mockFetch(() => { throw new Error("must not fetch"); });
  const conn = new SalesforceConnector("tok", "https://org.my.salesforce.com");
  const c = conn.webUrls!.create!;
  assert.equal(
    c("call", { recordId: "003B", name: "Jane Founder" }),
    "https://org.my.salesforce.com/lightning/o/Task/new?defaultFieldValues=WhoId=003B,Subject=Call%20Jane%20Founder",
  );
  assert.equal(
    c("meeting", { recordId: "001A", subject: "Avid / Hines — Bi-Weekly" }),
    "https://org.my.salesforce.com/lightning/o/Event/new?defaultFieldValues=WhatId=001A,Subject=Avid%20%2F%20Hines%20%E2%80%94%20Bi-Weekly",
  );
  assert.equal(
    c("lead", { domain: "eksretirement.com", name: "EKS Group, LLC", person: "Ed Strazzulla", note: "Attio: https://app.attio.com/x/company/1" }),
    "https://org.my.salesforce.com/lightning/o/Lead/new?defaultFieldValues=Company=EKS%20Group%2C%20LLC,Website=https%3A%2F%2Feksretirement.com,FirstName=Ed,LastName=Strazzulla,Description=Attio%3A%20https%3A%2F%2Fapp.attio.com%2Fx%2Fcompany%2F1",
  );
  assert.match(c("company", { domain: "acme.com" })!, /\/lightning\/o\/Account\/new\?defaultFieldValues=Name=acme\.com,Website=https%3A%2F%2Facme\.com$/);
  assert.equal(c("task", {}), undefined);
  assert.equal(calls.length, 0);
});

test("Salesforce: quotes in names are SOQL-escaped", async () => {
  mockFetch(() => ({ records: [] }));
  await new SalesforceConnector("tok", "https://org.my.salesforce.com").search({
    object: "people",
    name: "O'Brien",
  });
  assert.match(soqlOf(calls[0].url), /Name LIKE '%O\\'Brien%'/);
});

test("Salesforce: restricted objects degrade to empty context, never a crash", async () => {
  mockFetch(() => new Response("INVALID_TYPE", { status: 400 }));
  const conn = new SalesforceConnector("tok", "https://org.my.salesforce.com");
  assert.deepEqual(await conn.search({ object: "companies", domain: "acme.com" }), []);
  assert.deepEqual(await conn.getContext("companies", "001A"), { notes: [], lists: [], people: [] });
});

test("Salesforce: whoami falls back to the hostname when Organization is restricted (live-verified)", async () => {
  // Captured live 2026-08: orgs can return INVALID_TYPE for Organization even
  // when Account queries work for the same user.
  mockFetch(
    () =>
      new Response('[{"message":"sObject type \'Organization\' is not supported.","errorCode":"INVALID_TYPE"}]', {
        status: 400,
      }),
  );
  const who = await new SalesforceConnector("tok", "https://cresa.my.salesforce.com").whoami();
  assert.deepEqual(who, { workspace: "cresa.my.salesforce.com" });
});

test("Salesforce: getContext folds Notes + Task subjects, Opportunities, Contacts", async () => {
  mockFetch((url) => {
    const q = soqlOf(url);
    if (q.startsWith("SELECT Title, Body FROM Note"))
      return { records: [{ Title: "Verdict", Body: "passed, too early" }] };
    if (q.startsWith("SELECT Subject, Description FROM Task"))
      return { records: [{ Subject: "Call w/ founder", Description: "not now" }] };
    if (q.startsWith("SELECT Id, Name, StageName, IsClosed FROM Opportunity"))
      return { records: [{ Id: "006A", Name: "Acme Seed", StageName: "Closed Lost", IsClosed: true }] };
    if (q.startsWith("SELECT Id, Name FROM Contact"))
      return { records: [{ Id: "003J", Name: "Jane Founder" }] };
    if (q.includes("FROM ActivityHistories"))
      return { records: [{ Id: "001A", ActivityHistories: { records: [{ Id: "00T1", Subject: "Email: intro", ActivityDate: "2026-05-12", ActivityType: "Email", IsTask: true }] } }] };
    return { records: [] };
  });

  const ctx = await new SalesforceConnector("tok", "https://org.my.salesforce.com").getContext(
    "companies",
    "001A",
  );

  const SF = "https://org.my.salesforce.com/lightning/r";
  assert.deepEqual(ctx, {
    notes: ["Verdict: passed, too early", "Call w/ founder: not now"],
    lists: [{ list: "Opportunity: Acme Seed", stage: "Closed Lost", kind: "opportunity", id: "006A", url: `${SF}/Opportunity/006A/view`, open: false }],
    people: ["Jane Founder"],
    peopleLinks: [{ label: "Jane Founder", url: `${SF}/Contact/003J/view` }],
    activities: [{ id: "00T1", date: "2026-05-12", kind: "email", subject: "Email: intro", url: `${SF}/Task/00T1/view` }],
  });
  const soqls = calls.map((c) => soqlOf(c.url));
  assert.ok(soqls.some((q) => /FROM Account WHERE Id = '001A'/.test(q) && /SELECT Id, Subject, ActivityDate, ActivityType, IsTask FROM ActivityHistories ORDER BY ActivityDate DESC NULLS LAST LIMIT 5/.test(q)));
});

test("Salesforce: getContext on a Contact links each CampaignMember to its Campaign", async () => {
  mockFetch((url) => {
    const q = soqlOf(url);
    if (q.startsWith("SELECT Id, CampaignId, Campaign.Name, Status FROM CampaignMember"))
      return { records: [{ Id: "00v1", CampaignId: "7011", Campaign: { Name: "SD – Monthly Newsletter" }, Status: "Sent" }] };
    return { records: [] };
  });
  const ctx = await new SalesforceConnector("tok", "https://org.my.salesforce.com").getContext("people", "003B");
  assert.deepEqual(ctx.lists, [{
    list: "SD – Monthly Newsletter", stage: "Sent", kind: "campaign", id: "7011",
    url: "https://org.my.salesforce.com/lightning/r/Campaign/7011/view",
    memberUrl: "https://org.my.salesforce.com/lightning/r/CampaignMember/00v1/view",
  }]);
});

test("Salesforce: an expired session that survives the retry THROWS — never a silent 'clean'", async () => {
  mockFetch(() => new Response('[{"message":"Session expired or invalid","errorCode":"INVALID_SESSION_ID"}]', { status: 401 }));
  const conn = new SalesforceConnector("stale", "https://org.my.salesforce.com");
  await assert.rejects(conn.search({ object: "companies", domain: "acme.com" }), (e: any) => e.code === "SALESFORCE_AUTH" && /log in again/.test(e.message));
  await assert.rejects(conn.whoami(), (e: any) => e.code === "SALESFORCE_AUTH");
});

// A sid command with an on-disk counter: prints tok1, tok2, … per invocation.
function countingSidCommand() {
  const file = join(mkdtempSync(join(tmpdir(), "valentine-sid-")), "count");
  const cmd = `n=$(($(cat "${file}" 2>/dev/null || echo 0)+1)); echo $n > "${file}"; printf tok$n`;
  return { cmd, runs: () => Number(readFileSync(file, "utf8").trim()) };
}

test("Salesforce: sid command mints the token lazily and reuses it across calls", async () => {
  const sid = countingSidCommand();
  mockFetch(() => ({ records: [] }));
  const conn = new SalesforceConnector({ command: sid.cmd }, "https://org.my.salesforce.com");
  await conn.search({ object: "people", name: "Ann" });
  await conn.search({ object: "people", name: "Bob" });
  const auths = calls.map((c) => (c.init?.headers as Record<string, string>).Authorization);
  assert.deepEqual(auths, ["Bearer tok1", "Bearer tok1"]); // one mint, reused
  assert.equal(sid.runs(), 1);
});

test("Salesforce: a 401 re-runs the sid command once and retries the query", async () => {
  const sid = countingSidCommand();
  let hits = 0;
  mockFetch(() => (++hits === 1
    ? new Response("Session expired or invalid", { status: 401 })
    : { records: [{ Id: "003X", Name: "Jane Founder" }] }));
  const conn = new SalesforceConnector({ command: sid.cmd }, "https://org.my.salesforce.com");
  const out = await conn.search({ object: "people", name: "Jane" });
  assert.equal(out.length, 1); // retry succeeded — no degrade-to-empty
  const auths = calls.map((c) => (c.init?.headers as Record<string, string>).Authorization);
  assert.deepEqual(auths, ["Bearer tok1", "Bearer tok2"]); // fresh token on retry
  assert.equal(sid.runs(), 2);
});

// ─── Affinity ────────────────────────────────────────────────────────────────

test("Affinity: search hits organizations with interaction dates and maps them", async () => {
  mockFetch((url) => {
    if (url.includes("/organizations?"))
      return {
        organizations: [
          {
            id: 7,
            name: "Acme",
            domain: "acme.com",
            person_ids: [1, 2, 3],
            interaction_dates: {
              last_email_date: "2026-05-12T10:00:00Z",
              last_event_date: "2026-04-01T09:00:00Z",
              last_interaction_date: "2026-05-12T10:00:00Z",
              first_email_date: "2025-01-02T08:00:00Z",
            },
          },
        ],
      };
    return {};
  });

  const [m] = await new AffinityConnector("key").search({ object: "companies", domain: "acme.com" });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/organizations");
  assert.equal(url.searchParams.get("term"), "acme.com");
  assert.equal(url.searchParams.get("with_interaction_dates"), "true");
  // V1 auth: Basic with empty username, key as password.
  const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
  assert.equal(auth, `Basic ${Buffer.from(":key").toString("base64")}`);

  assert.deepEqual(m, {
    recordId: "7",
    object: "companies",
    name: "Acme",
    domain: "acme.com",
    lastEmail: "2026-05-12",
    lastMeeting: "2026-04-01",
    lastInteraction: "email · 2026-05-12",
    firstInteraction: "2025-01-02",
    linkedPeople: 3,
  });
});

test("Affinity: getContext strips note HTML and dedupes list entries", async () => {
  mockFetch((url) => {
    if (url.includes("/notes?organization_id=7"))
      return { notes: [{ content: "<p>passed, <b>too early</b></p>" }] };
    if (url.endsWith("/lists")) return [{ id: 11, name: "Pipeline" }];
    if (url.includes("/organizations/7"))
      return { list_entries: [{ list_id: 11 }, { list_id: 11 }], person_ids: [21] };
    if (url.includes("/persons/21")) return { first_name: "Jane", last_name: "Founder" };
    return {};
  });

  const ctx = await new AffinityConnector("key").getContext("companies", "7");

  assert.deepEqual(ctx, {
    notes: ["passed, too early"],
    lists: [{ list: "Pipeline" }],
    people: ["Jane Founder"],
  });
});
