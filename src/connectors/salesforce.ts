// Salesforce connector — READ-ONLY, data-model-agnostic.
// Relies only on STANDARD objects present on every org:
//   - Account / Contact search via SOQL (Name, Website, Owner, LastActivityDate)
//   - Note bodies + Task subjects for outcomes ("passed, too early")
//   - Opportunities (Account) and Campaigns (Contact) as list/pipeline signals
// Anything custom or missing is skipped gracefully — never assumed.
//
// Auth: a REST access token + instance URL. Get one from a read-only user via a
// connected app, or locally: `sf org display --json` → accessToken/instanceUrl.
// Tokens expire with the Salesforce session — refresh is out of scope for v1.
// API ref: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/

import type { CRMConnector, CRMMatch, CRMContext, SearchQuery } from "./types.js";

const API = "/services/data/v59.0";

export class SalesforceConnector implements CRMConnector {
  readonly name = "Salesforce";

  constructor(
    private accessToken: string,
    private instanceUrl: string,
  ) {
    this.instanceUrl = instanceUrl.replace(/\/+$/, "");
  }

  private async soql(q: string): Promise<any[]> {
    const res = await fetch(`${this.instanceUrl}${API}/query?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Salesforce ${res.status} on query: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.records ?? [];
  }

  async whoami(): Promise<{ workspace: string }> {
    const recs = await this.soql("SELECT Name FROM Organization LIMIT 1");
    return { workspace: recs[0]?.Name ?? new URL(this.instanceUrl).hostname };
  }

  async search(q: SearchQuery): Promise<CRMMatch[]> {
    const term = soqlEscape(q.domain ?? q.name ?? "");
    if (!term) return [];

    try {
      if (q.object === "companies") {
        const where = q.domain ? `Website LIKE '%${term}%'` : `Name LIKE '%${term}%'`;
        const recs = await this.soql(
          `SELECT Id, Name, Website, Owner.Name, LastActivityDate, ` +
            `(SELECT Id FROM Contacts LIMIT 6) FROM Account WHERE ${where} LIMIT 10`,
        );
        return recs.map((r) => ({
          recordId: r.Id,
          object: "companies" as const,
          name: r.Name ?? undefined,
          domain: hostname(r.Website),
          owner: r.Owner?.Name ?? undefined,
          lastInteraction: r.LastActivityDate ? `activity · ${r.LastActivityDate}` : undefined,
          linkedPeople: r.Contacts?.records?.length ?? undefined,
        }));
      }

      // "people" → Contact. By name, or by email domain when a domain is given.
      const where = q.domain ? `Email LIKE '%@${term}'` : `Name LIKE '%${term}%'`;
      const recs = await this.soql(
        `SELECT Id, Name, Email, Owner.Name, LastActivityDate, Account.Name ` +
          `FROM Contact WHERE ${where} LIMIT 10`,
      );
      return recs.map((r) => ({
        recordId: r.Id,
        object: "people" as const,
        name: r.Name ?? undefined,
        domain: r.Email?.split("@")[1],
        owner: r.Owner?.Name ?? undefined,
        lastInteraction: r.LastActivityDate ? `activity · ${r.LastActivityDate}` : undefined,
      }));
    } catch {
      return []; // restricted object/field for this user → no match, never crash
    }
  }

  async getContext(object: "companies" | "people", id: string): Promise<CRMContext> {
    const sid = soqlEscape(id);
    const [notes, lists, people] = await Promise.all([
      this.notes(object, sid),
      this.lists(object, sid),
      this.people(object, sid),
    ]);
    return { notes, lists, people };
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

  private async lists(
    object: "companies" | "people",
    id: string,
  ): Promise<{ list: string; stage?: string }[]> {
    try {
      if (object === "companies") {
        const opps = await this.soql(
          `SELECT Name, StageName FROM Opportunity WHERE AccountId = '${id}' ORDER BY CreatedDate DESC LIMIT 10`,
        );
        return opps.map((o) => ({ list: `Opportunity: ${o.Name}`, stage: o.StageName ?? undefined }));
      }
      const camps = await this.soql(
        `SELECT Campaign.Name, Status FROM CampaignMember WHERE ContactId = '${id}' LIMIT 10`,
      );
      return camps.map((c) => ({ list: c.Campaign?.Name ?? "campaign", stage: c.Status ?? undefined }));
    } catch {
      return [];
    }
  }

  private async people(object: "companies" | "people", id: string): Promise<string[]> {
    if (object !== "companies") return [];
    try {
      const recs = await this.soql(`SELECT Name FROM Contact WHERE AccountId = '${id}' LIMIT 5`);
      return recs.map((r) => r.Name).filter(Boolean);
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
