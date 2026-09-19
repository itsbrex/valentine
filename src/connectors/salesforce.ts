// Salesforce connector — READ-ONLY, data-model-agnostic.
// Relies only on STANDARD objects present on every org:
//   - Account / Contact search via SOQL (Name, Website, Owner, LastActivityDate)
//   - Note bodies + Task subjects for outcomes ("passed, too early")
//   - Opportunities (Account) and Campaigns (Contact) as list/pipeline signals
//   - ActivityHistory (the Task/Event behind "last touched") for deep links
// Anything custom or missing is skipped gracefully — never assumed.
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
      throw new Error(`Salesforce ${res.status} on ${method} ${path.split("?")[0]}: ${text.slice(0, 200)}`);
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
        const recs = await this.soql(
          `SELECT Id, Name, Website, OwnerId, Owner.Name, Owner.IsActive, LastActivityDate, ` +
            `(SELECT Id FROM Contacts LIMIT 6) FROM Account WHERE ${where} LIMIT 10`,
        );
        return recs.map((r) => ({
          recordId: r.Id,
          object: "companies" as const,
          name: r.Name ?? undefined,
          domain: hostname(r.Website),
          ...this.ownerOf(r),
          lastInteraction: r.LastActivityDate ? `activity · ${r.LastActivityDate}` : undefined,
          linkedPeople: r.Contacts?.records?.length ?? undefined,
          url: this.recordUrl("Account", r.Id),
          views: {
            activity: this.relatedUrl("Account", r.Id, "ActivityHistories"),
            people: this.relatedUrl("Account", r.Id, "Contacts"),
          },
        }));
      }

      // "people" → Contact. By name, or by email domain when a domain is given.
      const where = q.domain ? `Email LIKE '%@${term}'` : `Name LIKE '%${term}%'`;
      const recs = await this.soql(
        `SELECT Id, Name, Email, AccountId, Account.Name, OwnerId, Owner.Name, Owner.IsActive, LastActivityDate ` +
          `FROM Contact WHERE ${where} LIMIT 10`,
      );
      return recs.map((r) => ({
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
    } catch (e) {
      if (e instanceof SalesforceAuthError) throw e;
      return []; // restricted object/field for this user → no match, never crash
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
    const [notes, lists, people, activities] = await Promise.all([
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
      ...(activities.length ? { activities } : {}),
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

  private async lists(object: "companies" | "people", id: string): Promise<ListMembership[]> {
    try {
      if (object === "companies") {
        const opps = await this.soql(
          `SELECT Id, Name, StageName, IsClosed FROM Opportunity WHERE AccountId = '${id}' ORDER BY CreatedDate DESC LIMIT 10`,
        );
        return opps.map((o) => ({
          list: `Opportunity: ${o.Name}`,
          stage: o.StageName ?? undefined,
          kind: "opportunity" as const,
          id: o.Id,
          url: this.recordUrl("Opportunity", o.Id),
          open: o.IsClosed == null ? undefined : !o.IsClosed,
        }));
      }
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

  /** The Task/Event behind "last touched", via the ActivityHistories subquery
   *  (ActivityHistory cannot be queried directly). Newest first. */
  private async activities(object: "companies" | "people", id: string): Promise<Activity[]> {
    const sobject = object === "companies" ? "Account" : "Contact";
    try {
      const recs = await this.soql(
        `SELECT Id, (SELECT Id, Subject, ActivityDate, ActivityType, IsTask FROM ActivityHistories ` +
          `ORDER BY ActivityDate DESC NULLS LAST LIMIT 5) FROM ${sobject} WHERE Id = '${id}'`,
      );
      const rows: any[] = recs[0]?.ActivityHistories?.records ?? [];
      return rows.map((a) => ({
        id: a.Id,
        date: a.ActivityDate ?? undefined,
        kind: (a.ActivityType ?? (a.IsTask ? "task" : "event")).toLowerCase(),
        subject: a.Subject ?? undefined,
        url: this.recordUrl(a.IsTask === false ? "Event" : "Task", a.Id),
      }));
    } catch {
      return [];
    }
  }
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
