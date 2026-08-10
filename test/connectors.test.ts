// Connector request/response contracts against a mocked global fetch.
// Each block asserts (a) the request the connector actually makes and
// (b) the CRMMatch/CRMContext shapes it maps out of a canned API payload.
// Fixture payloads mirror the real API response shapes each connector parses.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
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

  assert.deepEqual(ctx, {
    notes: ["passed, too early", "Intro call"],
    lists: [{ list: "Pipeline", stage: "In DD" }],
    people: ["Jane Founder"],
  });
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
            Owner: { Name: "Sarah Lee" },
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
  assert.match(q, /FROM Account WHERE Website LIKE '%acme\.com%' LIMIT 10/);
  assert.ok(calls[0].url.startsWith("https://org.my.salesforce.com/services/data/"), "trailing slash stripped");

  assert.deepEqual(m, {
    recordId: "001A",
    object: "companies",
    name: "Acme",
    domain: "acme.com", // www. stripped from Website
    owner: "Sarah Lee",
    lastInteraction: "activity · 2026-05-12",
    linkedPeople: 2,
  });
});

test("Salesforce: people search by domain matches Contact email suffix", async () => {
  mockFetch(() => ({
    records: [{ Id: "003B", Name: "Jane Founder", Email: "jane@acme.com", Owner: { Name: "Ravi" } }],
  }));

  const [m] = await new SalesforceConnector("tok", "https://org.my.salesforce.com").search({
    object: "people",
    domain: "acme.com",
  });

  assert.match(soqlOf(calls[0].url), /FROM Contact WHERE Email LIKE '%@acme\.com' LIMIT 10/);
  assert.equal(m.domain, "acme.com");
  assert.equal(m.owner, "Ravi");
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

test("Salesforce: getContext folds Notes + Task subjects, Opportunities, Contacts", async () => {
  mockFetch((url) => {
    const q = soqlOf(url);
    if (q.startsWith("SELECT Title, Body FROM Note"))
      return { records: [{ Title: "Verdict", Body: "passed, too early" }] };
    if (q.startsWith("SELECT Subject, Description FROM Task"))
      return { records: [{ Subject: "Call w/ founder", Description: "not now" }] };
    if (q.startsWith("SELECT Name, StageName FROM Opportunity"))
      return { records: [{ Name: "Acme Seed", StageName: "Closed Lost" }] };
    if (q.startsWith("SELECT Name FROM Contact"))
      return { records: [{ Name: "Jane Founder" }] };
    return { records: [] };
  });

  const ctx = await new SalesforceConnector("tok", "https://org.my.salesforce.com").getContext(
    "companies",
    "001A",
  );

  assert.deepEqual(ctx, {
    notes: ["Verdict: passed, too early", "Call w/ founder: not now"],
    lists: [{ list: "Opportunity: Acme Seed", stage: "Closed Lost" }],
    people: ["Jane Founder"],
  });
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
