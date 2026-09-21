// Salesforce connector — READ-ONLY, data-model-agnostic.
// Relies only on STANDARD objects present on every org:
//   - Account / Contact / Lead search via SOQL (Name, Website, Email, Owner, LastActivityDate)
//   - Note bodies + Task subjects for outcomes ("passed, too early")
//   - Opportunities (Account) and Campaigns (Contact) as list/pipeline signals,
//     with Amount / CloseDate / Owner when the user can see them
//   - ActivityHistory (the Task/Event behind "last touched") and OpenActivities
//     (what is already scheduled — soonest first) for deep links
// Anything custom or missing is skipped gracefully — never assumed. The one
// exception is a PROBE: opportunity queries try the CRE deal-shape fields the
// sf-ownership-desk uses (Size__c, Size_Type__c, Term_Months__c, Lease_Type__c)
// and fall back to standard-only, then to the bare query, on INVALID_FIELD.
//
// Auth: a REST access token + instance URL. Get one from a read-only user via a
// connected app, or locally: `sf org display --json` → accessToken/instanceUrl.
// Static tokens expire with the Salesforce session. Alternatively, configure a
// sid command (config `salesforceSidCommand` / VALENTINE_SALESFORCE_SID_COMMAND):
// any shell command that prints a fresh access token — e.g. a browser-session
// extractor like salesforce-mcp-auto-auth-chrome (see backlog.md). The command
// runs lazily on first use and once more on a 401/INVALID_SESSION_ID, so the
// session self-refreshes as long as a browser tab stays logged in.
//
// An auth failure that survives the retry is THROWN, not swallowed: a sweep
// must report "couldn't reach Salesforce" (ambiguous), never "clean". Restricted
// objects/fields still degrade to no-match — that is a data-model gap, not an
// outage.
// API ref: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/
// Lightning URLs: /lightning/r/{Object}/{Id}/view · …/related/{RelatedList}/view ·
//   /lightning/o/{Object}/new?defaultFieldValues=Field=Value,… (values URL-encoded)

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CRMConnector, CRMMatch, CRMContext, SearchQuery, Activity, ListMembership, RecordLink, WebUrls, CreatePrefill } from "./types.js";

const run = promisify(exec);
const API = "/services/data/v59.0";

export interface SalesforceAuth {
  /** Static access token. */
  token?: string;
  /** Shell command that prints a fresh access token; re-run on 401. */
  command?: string;
}

/** Thrown when the token is rejected even after a refresh — the caller surfaces it. */
export class SalesforceAuthError extends Error {
  readonly code = "SALESFORCE_AUTH";
}

/** The authenticated session: token (static or minted by the sid command),
 *  one refresh-and-retry on 401, and a thin REST helper. Shared by the
 *  read-only connector and — only when writes are opted in — the writer. */
export class SalesforceSession {
  private token?: string;
  private readonly command?: string;
  readonly instanceUrl: string;

  constructor(auth: string | SalesforceAuth, instanceUrl: string) {
    if (typeof auth === "string") auth = { token: auth };
    this.token = auth.token;
    this.command = auth.command;
    this.instanceUrl = instanceUrl.replace(/\/+$/, "");
  }

  private async accessToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.command)
      throw new Error("No Salesforce token or sid command configured. Run `valentine init`.");
    const { stdout } = await run(this.command, { timeout: 30_000 });
    this.token = stdout.trim().split("\n").pop() || undefined;
    if (!this.token)
      throw new SalesforceAuthError("Salesforce sid command printed nothing — is the browser logged in?");
    return this.token;
  }

  /** One REST call under `/services/data/v59.0`. 401 → refresh once via the
   *  sid command, then SalesforceAuthError. Other errors carry the body. */
  async request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<any> {
    const url = `${this.instanceUrl}${API}${path}`;
    const init = (token: string): RequestInit => ({
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let res = await fetch(url, init(await this.accessToken()));
    // Session expired and we can mint a fresh one → re-run the command, retry once.
    if (res.status === 401 && this.command) {
      this.token = undefined;
      res = await fetch(url, init(await this.accessToken()));
    }
    if (res.status === 401) {
      const text = await res.text();
      throw new SalesforceAuthError(
        `Salesforce session expired or invalid (${text.slice(0, 120)}) — log in again in the browser` +
          (this.command ? " that the sid command reads" : "") + ".",
      );
    }
    if (!res.ok) {
      const text = await res.text();
      // Lead with the errorCode: the body echoes the whole SOQL first, so a
      // 200-char slice alone can hide INVALID_FIELD / INVALID_TYPE.
      let code = "";
      try {
        const c = JSON.parse(text)?.[0]?.errorCode;
        if (typeof c === "string") code = ` ${c}`;
      } catch {
        /* not JSON */
      }
      throw new Error(`Salesforce ${res.status}${code} on ${method} ${path.split("?")[0]}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined;
    return res.json();
  }

  async soql(q: string): Promise<any[]> {
    const data = await this.request("GET", `/query?q=${encodeURIComponent(q)}`);
    return data?.records ?? [];
  }
}

export class SalesforceConnector implements CRMConnector {
  readonly name = "Salesforce";
  readonly webUrls: WebUrls;
  readonly session: SalesforceSession;
  private instanceUrl: string;

  constructor(auth: string | SalesforceAuth | SalesforceSession, instanceUrl: string) {
    this.session = auth instanceof SalesforceSession ? auth : new SalesforceSession(auth, instanceUrl);
    this.instanceUrl = this.session.instanceUrl;
    this.webUrls = {
      create: (kind, p) => this.createUrl(kind, p),
    };
  }

  private soql(q: string): Promise<any[]> {
    return this.session.soql(q);
  }

  async whoami(): Promise<{ workspace: string }> {
    // Live-verified 2026-08: some orgs restrict the Organization sObject
    // (INVALID_TYPE) even for users who can query Account fine — fall back to
    // the instance hostname instead of failing the connection check.
    try {
      const recs = await this.soql("SELECT Name FROM Organization LIMIT 1");
      return { workspace: recs[0]?.Name ?? new URL(this.instanceUrl).hostname };
    } catch (e) {
      if (e instanceof SalesforceAuthError) throw e;
      return { workspace: new URL(this.instanceUrl).hostname };
    }
  }

  async search(q: SearchQuery): Promise<CRMMatch[]> {
    const term = soqlEscape(q.domain ?? q.name ?? "");
    if (!term) return [];

    try {
      if (q.object === "companies") {
        const where = q.domain ? `Website LIKE '%${term}%'` : `Name LIKE '%${term}%'`;
        const recs = await this.accounts(where);
        const all: CRMMatch[] = recs.map((r) => ({
          recordId: r.Id,
          object: "companies" as const,
          name: r.Name ?? undefined,
          domain: hostname(r.Website),
          ...this.ownerOf(r),
          lastInteraction: r.LastActivityDate ? `activity · ${r.LastActivityDate}` : undefined,
          linkedPeople: r.Contacts?.records?.length ?? undefined,
          url: this.recordUrl("Account", r.Id),
          ...(firmographics(r) ? { firmographics: firmographics(r) } : {}),
          views: {
            activity: this.relatedUrl("Account", r.Id, "ActivityHistories"),
            people: this.relatedUrl("Account", r.Id, "Contacts"),
          },
        }));
        return q.domain ? domainRelated(all, q.domain) : all;
      }

      // "people" → Contact, plus unconverted Leads. By name, or by email
      // domain when a domain is given.
      const where = q.domain ? `Email LIKE '%@${term}'` : `Name LIKE '%${term}%'`;
      const recs = await this.soql(
        `SELECT Id, Name, Email, AccountId, Account.Name, OwnerId, Owner.Name, Owner.IsActive, LastActivityDate ` +
          `FROM Contact WHERE ${where} LIMIT 10`,
      );
      const contacts: CRMMatch[] = recs.map((r) => ({
        recordId: r.Id,
        object: "people" as const,
        name: r.Name ?? undefined,
        domain: r.Email?.split("@")[1],
        ...this.ownerOf(r),
        lastInteraction: r.LastActivityDate ? `activity · ${r.LastActivityDate}` : undefined,
        url: this.recordUrl("Contact", r.Id),
        ...(r.AccountId
          ? { parent: { id: r.AccountId, label: r.Account?.Name ?? "Account", url: this.recordUrl("Account", r.AccountId)! } }
          : {}),
        views: { activity: this.relatedUrl("Contact", r.Id, "ActivityHistories") },
      }));
      return [...contacts, ...(await this.leads(q, term))];
    } catch (e) {
      if (e instanceof SalesforceAuthError) throw e;
      return []; // restricted object/field for this user → no match, never crash
    }
  }

  /** Unconverted Leads — a prospect someone already logged but never turned
   *  into an Account/Contact. Its own try: Lead is often restricted. */
  private async leads(q: SearchQuery, term: string): Promise<CRMMatch[]> {
    try {
      const where = q.domain
        ? `(Email LIKE '%@${term}' OR Website LIKE '%${term}%')`
        : `(Name LIKE '%${term}%' OR Company LIKE '%${term}%')`;
      const recs = await this.soql(
        `SELECT Id, Name, Company, Email, Website, Status, OwnerId, Owner.Name, Owner.IsActive, LastActivityDate ` +
          `FROM Lead WHERE IsConverted = false AND ${where} LIMIT 10`,
      );
      return recs.map((r) => ({
        recordId: r.Id,
        object: "people" as const,
        recordType: "Lead",
        name: r.Name ?? undefined,
        domain: r.Email?.split("@")[1] ?? hostname(r.Website),
        ...this.ownerOf(r),
        lastInteraction: r.LastActivityDate ? `activity · ${r.LastActivityDate}` : undefined,
        url: this.recordUrl("Lead", r.Id),
        views: { activity: this.relatedUrl("Lead", r.Id, "ActivityHistories") },
      }));
    } catch (e) {
      if (e instanceof SalesforceAuthError) throw e;
      return [];
    }
  }

  private ownerOf(r: any): Pick<CRMMatch, "owner" | "ownerId" | "ownerUrl" | "ownerActive"> {
    const name: string | undefined = r.Owner?.Name ?? undefined;
    if (!name) return {};
    // Orgs park unowned records on a placeholder user ("Unassigned Atlanta",
    // "Integration User"…) — surface that as an owner gap, not an owner.
    const placeholder = /\bunassigned\b|\bintegration user\b|\bapi user\b/i.test(name);
    const active = r.Owner?.IsActive === false || placeholder ? false : r.Owner?.IsActive === true ? true : undefined;
    return {
      owner: name,
      ...(r.OwnerId ? { ownerId: r.OwnerId, ownerUrl: this.recordUrl("User", r.OwnerId) } : {}),
      ...(active === undefined ? {} : { ownerActive: active }),
    };
  }

  /** Lightning deep link; my.salesforce.com hosts serve Lightning directly. */
  private recordUrl(sobject: string, id?: string): string | undefined {
    return id ? `${this.instanceUrl}/lightning/r/${sobject}/${id}/view` : undefined;
  }

  private relatedUrl(sobject: string, id: string, related: string): string {
    return `${this.instanceUrl}/lightning/r/${sobject}/${id}/related/${related}/view`;
  }

  /** Prefilled new-record form. `defaultFieldValues=F1=v1,F2=v2`; each value
   *  URL-encoded so commas and spaces inside it survive. Nothing is saved until
   *  the user presses Save in their browser. */
  private createUrl(kind: "company" | "lead" | "call" | "task" | "meeting", p: CreatePrefill & { recordId?: string; subject?: string }): string | undefined {
    const fields: Record<string, string | undefined> = {};
    let object: string;
    if (kind === "company") {
      object = "Account";
      fields.Name = p.name ?? p.domain;
      fields.Website = p.domain ? `https://${p.domain}` : undefined;
      fields.Description = p.note;
    } else if (kind === "lead") {
      object = "Lead";
      fields.Company = p.name ?? p.domain;
      fields.Website = p.domain ? `https://${p.domain}` : undefined;
      const [first, ...rest] = (p.person ?? "").split(" ").filter(Boolean);
      if (rest.length) {
        fields.FirstName = first;
        fields.LastName = rest.join(" ");
      } else if (first) fields.LastName = first;
      fields.Description = p.note;
    } else {
      if (!p.recordId) return undefined;
      object = kind === "meeting" ? "Event" : "Task";
      // Contact/Lead ids go on WhoId; anything else (Account, Opportunity) on WhatId.
      const who = /^(003|00Q)/.test(p.recordId);
      fields[who ? "WhoId" : "WhatId"] = p.recordId;
      fields.Subject = p.subject ?? (kind === "call" ? `Call ${p.name ?? p.domain ?? ""}`.trim() : kind === "meeting" ? `Meeting ${p.name ?? p.domain ?? ""}`.trim() : `Follow up ${p.name ?? p.domain ?? ""}`.trim());
    }
    const pairs = Object.entries(fields)
      .filter((kv): kv is [string, string] => !!kv[1])
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    if (!pairs.length) return undefined;
    return `${this.instanceUrl}/lightning/o/${object}/new?defaultFieldValues=${pairs.join(",")}`;
  }

  async getContext(object: "companies" | "people", id: string): Promise<CRMContext> {
    const sid = soqlEscape(id);
    const [notes, lists, people, acts] = await Promise.all([
      this.notes(object, sid),
      this.lists(object, sid),
      this.people(object, sid),
      this.activities(object, sid),
    ]);
    return {
      notes,
      lists,
      people: people.map((p) => p.label),
      ...(people.length ? { peopleLinks: people } : {}),
      ...(acts.recent.length ? { activities: acts.recent } : {}),
      ...(acts.upcoming.length ? { upcoming: acts.upcoming } : {}),
    };
  }

  // --- standard sub-fetches, each degrades to empty on error ---

  private async notes(object: "companies" | "people", id: string): Promise<string[]> {
    const out: string[] = [];
    try {
      const notes = await this.soql(
        `SELECT Title, Body FROM Note WHERE ParentId = '${id}' ORDER BY CreatedDate DESC LIMIT 25`,
      );
      out.push(...notes.map((n) => join(n.Title, n.Body)).filter(Boolean));
    } catch {
      /* Notes disabled for this org/user → skip */
    }
    try {
      // Logged calls & emails live on Task — subjects often carry the outcome.
      const rel = object === "companies" ? "WhatId" : "WhoId";
      const tasks = await this.soql(
        `SELECT Subject, Description FROM Task WHERE ${rel} = '${id}' ORDER BY CreatedDate DESC LIMIT 10`,
      );
      out.push(...tasks.map((t) => join(t.Subject, t.Description).slice(0, 300)).filter(Boolean));
    } catch {
      /* no Task access → skip */
    }
    return out.slice(0, 25);
  }

  /** Which Account field set this org/user can see: probed once, then
   *  remembered. 0 = with ZoomInfo firmographics · 1 = standard · 2 = bare.
   *  Same shape as the opportunity probe below — an org without the ZoomInfo
   *  managed package answers INVALID_FIELD once and never pays for it again. */
  private acctTier = 0;

  private async accounts(where: string): Promise<any[]> {
    const tail = `, (SELECT Id FROM Contacts LIMIT 6) FROM Account WHERE ${where} LIMIT 10`;
    const tiers = [`${ACCT_STANDARD}, ${ACCT_FIRMO.join(", ")}`, ACCT_STANDARD, ACCT_BARE];
    for (; this.acctTier < tiers.length; this.acctTier++) {
      try {
        return await this.soql(`SELECT ${tiers[this.acctTier]}${tail}`);
      } catch (e) {
        if (e instanceof SalesforceAuthError) throw e;
        if (!/INVALID_FIELD|No such column|FIELD_INTEGRITY/i.test(String((e as Error)?.message))) throw e;
      }
    }
    return [];
  }

  /** Which opportunity field set this org/user can see: probed once, then
   *  remembered. 0 = with CRE custom fields · 1 = standard deal fields · 2 = bare. */
  private oppTier = 0;

  private async opportunities(accountId: string): Promise<ListMembership[]> {
    const tiers = [
      `${OPP_STANDARD}, ${OPP_CUSTOM.join(", ")}`,
      OPP_STANDARD,
      "Id, Name, StageName, IsClosed",
    ];
    for (; this.oppTier < tiers.length; this.oppTier++) {
      try {
        const opps = await this.soql(
          `SELECT ${tiers[this.oppTier]} FROM Opportunity WHERE AccountId = '${accountId}' ORDER BY CreatedDate DESC LIMIT 10`,
        );
        return opps.map((o) => ({
          list: `Opportunity: ${o.Name}`,
          stage: o.StageName ?? undefined,
          kind: "opportunity" as const,
          id: o.Id,
          url: this.recordUrl("Opportunity", o.Id),
          open: o.IsClosed == null ? undefined : !o.IsClosed,
          ...(typeof o.Amount === "number" ? { amount: o.Amount } : {}),
          ...(o.CloseDate ? { closeDate: o.CloseDate } : {}),
          ...(o.Owner?.Name ? { owner: o.Owner.Name } : {}),
          ...(dealDetail(o) ? { detail: dealDetail(o) } : {}),
        }));
      } catch (e) {
        if (e instanceof SalesforceAuthError) throw e;
        // INVALID_FIELD / no FLS on a field → drop to the next tier and retry;
        // anything else (no Opportunity access at all) → no lists.
        if (!/INVALID_FIELD|No such column|FIELD_INTEGRITY/i.test(String((e as Error)?.message))) return [];
      }
    }
    return [];
  }

  private async lists(object: "companies" | "people", id: string): Promise<ListMembership[]> {
    try {
      if (object === "companies") return await this.opportunities(id);
      const camps = await this.soql(
        `SELECT Id, CampaignId, Campaign.Name, Status FROM CampaignMember WHERE ContactId = '${id}' LIMIT 10`,
      );
      return camps.map((c) => ({
        list: c.Campaign?.Name ?? "campaign",
        stage: c.Status ?? undefined,
        kind: "campaign" as const,
        id: c.CampaignId ?? undefined,
        url: this.recordUrl("Campaign", c.CampaignId),
        memberUrl: this.recordUrl("CampaignMember", c.Id),
      }));
    } catch {
      return [];
    }
  }

  private async people(object: "companies" | "people", id: string): Promise<RecordLink[]> {
    if (object !== "companies") return [];
    try {
      const recs = await this.soql(`SELECT Id, Name FROM Contact WHERE AccountId = '${id}' LIMIT 5`);
      return recs.filter((r) => r.Name).map((r) => ({ label: r.Name, url: this.recordUrl("Contact", r.Id)! }));
    } catch {
      return [];
    }
  }

  /** The Task/Event behind "last touched" (ActivityHistories, newest first)
   *  and what is already scheduled (OpenActivities, SOONEST first — the
   *  ownership desk's "next task" picked the latest due date by mistake).
   *  Both are subqueries: neither object can be queried directly, and for
   *  non-admin users Salesforce demands EXACTLY these ORDER BY clauses
   *  (`ActivityDate DESC, LastModifiedDate DESC` / `ActivityDate ASC,
   *  LastModifiedDate DESC`) — anything else, even `NULLS LAST`, is a
   *  MALFORMED_QUERY "implementation restriction". Live-verified 2026-09-18. */
  private async activities(object: "companies" | "people", id: string): Promise<{ recent: Activity[]; upcoming: Activity[] }> {
    const sobject = object === "companies" ? "Account" : /^00Q/.test(id) ? "Lead" : "Contact";
    const map = (a: any): Activity => ({
      id: a.Id,
      date: a.ActivityDate ?? undefined,
      kind: (a.ActivityType ?? (a.IsTask ? "task" : "event")).toLowerCase(),
      subject: a.Subject ?? undefined,
      url: this.recordUrl(a.IsTask === false ? "Event" : "Task", a.Id),
      ...(a.Owner?.Name ? { owner: a.Owner.Name } : {}),
      ...(a.Status ? { status: a.Status } : {}),
    });
    try {
      const recs = await this.soql(
        `SELECT Id, (SELECT Id, Subject, ActivityDate, ActivityType, IsTask FROM ActivityHistories ` +
          `ORDER BY ActivityDate DESC, LastModifiedDate DESC LIMIT 5), ` +
          `(SELECT Id, Subject, ActivityDate, ActivityType, IsTask, Status, Owner.Name FROM OpenActivities ` +
          `ORDER BY ActivityDate ASC, LastModifiedDate DESC LIMIT 5) FROM ${sobject} WHERE Id = '${id}'`,
      );
      return {
        recent: (recs[0]?.ActivityHistories?.records ?? []).map(map),
        upcoming: (recs[0]?.OpenActivities?.records ?? []).map(map),
      };
    } catch {
      return { recent: [], upcoming: [] };
    }
  }
}

// --- account field sets (see the acctTier probe note) ---
const ACCT_BARE = "Id, Name, Website, OwnerId, Owner.Name, Owner.IsActive, LastActivityDate";
const ACCT_STANDARD = `${ACCT_BARE}, NumberOfEmployees, AnnualRevenue, Industry`;
/** ZoomInfo managed-package enrichment, live-verified on the cresa org
 *  2026-09-21. Dropped wholesale when the package is not installed. */
const ACCT_FIRMO = ["ZoomInfo_Employees__c", "ZoomInfo_Annual_Revenue__c", "ZoomInfo_Primary_Industry__c"];

/** "1,200 employees · $340M · Commercial Real Estate" — the org's own fields
 *  first, ZoomInfo's only where the org has nothing. Zero means "not filled
 *  in", never a zero-employee company (same rule as dealDetail). */
function firmographics(r: any): string | undefined {
  const num = (x: unknown) => (typeof x === "number" && x > 0 ? x : undefined);
  const employees = num(r.NumberOfEmployees) ?? num(r.ZoomInfo_Employees__c);
  const revenue = num(r.AnnualRevenue) ?? num(r.ZoomInfo_Annual_Revenue__c);
  const industry = r.Industry || r.ZoomInfo_Primary_Industry__c || undefined;
  const bits: string[] = [];
  if (employees) bits.push(`${Math.round(employees).toLocaleString("en-US")} employees`);
  if (revenue) bits.push(money(revenue));
  if (industry) bits.push(String(industry));
  return bits.length ? bits.join(" · ") : undefined;
}

/** $1.25M / $340K / $900 — compact enough for a Slack field. */
function money(n: number): string {
  if (n >= 1e9) return `$${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

/** `Website LIKE '%hines.com%'` also matches machines.com. Keep only accounts
 *  whose website host IS the domain or a subdomain of it, or whose Name
 *  relates to the domain label (subsidiaries on a different domain).
 *  Single-hit exception: one loose hit and nothing precise is still better
 *  than pretending we found nothing — it just stays one match, honestly
 *  counted, instead of "1 of 10". Ported from the sf-ownership-desk rule. */
function domainRelated(matches: CRMMatch[], domain: string): CRMMatch[] {
  const d = domain.toLowerCase().replace(/^www\./, "");
  const label = d.split(".")[0];
  const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hostHit = (m: CRMMatch) => {
    const h = m.domain?.toLowerCase().replace(/^www\./, "");
    return !!h && (h === d || h.endsWith(`.${d}`));
  };
  // Match name tokens, never a bare substring: "Machines Inc" contains
  // "hines" and that is the very bug this filter exists to kill.
  const nameHit = (m: CRMMatch) => {
    if (!m.name || label.length < 3) return false;
    const ts = tokens(m.name);
    if (ts.includes(label)) return true; // "Hines Atlanta" ← hines.com
    const joined = ts.join("");
    if (joined.length < 4) return false;
    return joined.startsWith(label) || label.startsWith(joined); // "Ware Malcomb" ← waremalcomb.com
  };
  const precise = matches.filter((m) => hostHit(m) || nameHit(m));
  if (precise.length) return precise;
  return matches.length === 1 ? matches : [];
}

// --- opportunity field sets (see the probe note at the top) ---
const OPP_STANDARD = "Id, Name, StageName, IsClosed, Amount, CloseDate, Probability, Type, Owner.Name";
/** CRE deal-shape fields from the sf-ownership-desk org. Dropped wholesale when absent. */
const OPP_CUSTOM = ["Size__c", "Size_Type__c", "Term_Months__c", "Lease_Type__c"];

/** "45,000 SF · Office · 60 mo · Renewal" from whatever deal-shape fields came back. */
function dealDetail(o: any): string | undefined {
  const bits: string[] = [];
  // Zero means "not filled in", not a zero-size deal — live-verified 2026-09-18.
  if (typeof o.Size__c === "number" && o.Size__c > 0) bits.push(`${o.Size__c.toLocaleString("en-US")}${o.Size_Type__c ? ` ${o.Size_Type__c}` : " SF"}`);
  if (o.Lease_Type__c) bits.push(String(o.Lease_Type__c));
  if (typeof o.Term_Months__c === "number" && o.Term_Months__c > 0) bits.push(`${o.Term_Months__c} mo`);
  if (o.Type) bits.push(String(o.Type));
  return bits.length ? bits.join(" · ") : undefined;
}

// --- value extractors ---
const soqlEscape = (s: string) => s.replace(/(['\\])/g, "\\$1");
const join = (a?: string, b?: string) => [a, b].filter(Boolean).join(": ");
function hostname(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
