// Salesforce connector — READ-ONLY, data-model-agnostic.
// Relies only on STANDARD objects present on every org:
//   - Account / Contact search via SOQL (Name, Website, Owner, LastActivityDate)
//   - Note bodies + Task subjects for outcomes ("passed, too early")
//   - Opportunities (Account) and Campaigns (Contact) as list/pipeline signals
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
// API ref: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CRMConnector, CRMMatch, CRMContext, SearchQuery } from "./types.js";

const run = promisify(exec);
const API = "/services/data/v59.0";

export interface SalesforceAuth {
  /** Static access token. */
  token?: string;
  /** Shell command that prints a fresh access token; re-run on 401. */
  command?: string;
}

export class SalesforceConnector implements CRMConnector {
  readonly name = "Salesforce";
  private token?: string;
  private readonly command?: string;
  private instanceUrl: string;

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
      throw new Error("Salesforce sid command printed nothing — is the browser logged in?");
    return this.token;
  }

  private async soql(q: string): Promise<any[]> {
    const url = `${this.instanceUrl}${API}/query?q=${encodeURIComponent(q)}`;
    let res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
    // Session expired and we can mint a fresh one → re-run the command, retry once.
    if (res.status === 401 && this.command) {
      this.token = undefined;
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${await this.accessToken()}` },
      });
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Salesforce ${res.status} on query: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.records ?? [];
  }

  async whoami(): Promise<{ workspace: string }> {
    // Live-verified 2026-08: some orgs restrict the Organization sObject
    // (INVALID_TYPE) even for users who can query Account fine — fall back to
    // the instance hostname instead of failing the connection check.
    try {
      const recs = await this.soql("SELECT Name FROM Organization LIMIT 1");
      return { workspace: recs[0]?.Name ?? new URL(this.instanceUrl).hostname };
    } catch {
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
