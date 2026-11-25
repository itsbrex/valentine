// Salesforce writer — OPT-IN. Shares the read connector's SalesforceSession
// (same token / sid command, same 401 refresh) so there is no second auth
// path; what changes is only which REST calls are allowed. Standard objects
// only: Account, Contact, Lead, Task, Event, and the OwnerId / Description
// fields every org has. Nothing custom is assumed.
//
// REST: POST /sobjects/{Object} → { id } · PATCH /sobjects/{Object}/{Id} → 204
// Ids: 001 Account · 003 Contact · 00Q Lead · 006 Opportunity · 00T Task · 00U Event

import { SalesforceSession, SalesforceAuthError } from "../connectors/salesforce.js";
import type { CRMWriter, WriteResult, RecordObject, CompanyDraft, PersonDraft, ActivityDraft, CrossRef } from "./types.js";

export class SalesforceWriter implements CRMWriter {
  readonly name = "Salesforce";
  private me?: { id: string; name?: string };

  constructor(readonly session: SalesforceSession) {}

  private url(sobject: string, id: string): string {
    return `${this.session.instanceUrl}/lightning/r/${sobject}/${id}/view`;
  }

  /** Which sObject an id belongs to — the prefix says. */
  static sobjectOf(id: string, object?: RecordObject): "Account" | "Contact" | "Lead" | "Opportunity" {
    if (/^001/.test(id)) return "Account";
    if (/^003/.test(id)) return "Contact";
    if (/^00Q/.test(id)) return "Lead";
    if (/^006/.test(id)) return "Opportunity";
    return object === "people" ? "Contact" : "Account";
  }

  async whoami(): Promise<{ id: string; name?: string }> {
    if (this.me) return this.me;
    // chatter/users/me works with a browser sid (no OAuth userinfo needed) —
    // the same probe salesforce-mcp-auto-auth-chrome uses to validate a session.
    const u = await this.session.request("GET", "/chatter/users/me");
    if (!u?.id) throw new SalesforceAuthError("Salesforce did not say who the session belongs to.");
    this.me = { id: u.id, name: u.name ?? u.displayName ?? undefined };
    return this.me;
  }

  private async create(sobject: string, fields: Record<string, unknown>): Promise<string> {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") body[k] = v;
    const res = await this.session.request("POST", `/sobjects/${sobject}`, body);
    if (!res?.id) throw new Error(`Salesforce did not return an id for the new ${sobject}.`);
    return res.id;
  }

  async createCompany(d: CompanyDraft): Promise<WriteResult> {
    const id = await this.create("Account", {
      Name: d.name,
      Website: d.domain ? `https://${d.domain}` : undefined,
      Description: d.note,
      OwnerId: d.ownerId,
    });
    return { id, url: this.url("Account", id), label: `Account ${d.name} created in Salesforce` };
  }

  async createPerson(d: PersonDraft): Promise<WriteResult> {
    const { FirstName, LastName } = splitName(d.name);
    const id = await this.create("Contact", {
      FirstName,
      LastName,
      Email: d.email,
      AccountId: d.companyId,
      Description: d.note,
      OwnerId: d.ownerId,
    });
    return { id, url: this.url("Contact", id), label: `Contact ${d.name} created in Salesforce` };
  }

  async createLead(d: CompanyDraft & { person?: string; email?: string }): Promise<WriteResult> {
    const { FirstName, LastName } = splitName(d.person ?? "");
    const id = await this.create("Lead", {
      Company: d.name,
      Website: d.domain ? `https://${d.domain}` : undefined,
      FirstName,
      // LastName is required on Lead; without a person the company stands in.
      LastName: LastName || d.name,
      Email: d.email,
      LeadSource: "Valentine",
      Description: d.note,
      OwnerId: d.ownerId,
    });
    return { id, url: this.url("Lead", id), label: `Lead ${d.name} created in Salesforce` };
  }

  async claimOwner(object: RecordObject, recordId: string, ownerId?: string): Promise<WriteResult> {
    const owner = ownerId ?? (await this.whoami()).id;
    const sobject = SalesforceWriter.sobjectOf(recordId, object);
    await this.session.request("PATCH", `/sobjects/${sobject}/${recordId}`, { OwnerId: owner });
    return { id: recordId, url: this.url(sobject, recordId), label: `${sobject} owner set to ${this.me?.name ?? "you"} in Salesforce` };
  }

  async addNote(object: RecordObject, recordId: string, text: string): Promise<WriteResult> {
    // Notes (the classic Note object) are disabled on many orgs; a completed
    // Task is the one note-shaped thing every org accepts and the read side
    // already folds Task subjects into `notes`.
    return this.logActivity(object, recordId, { kind: "note", subject: text.slice(0, 80), note: text });
  }

  async logActivity(object: RecordObject, recordId: string, a: ActivityDraft): Promise<WriteResult> {
    const sobject = SalesforceWriter.sobjectOf(recordId, object);
    // Contact/Lead ids go on WhoId; Account/Opportunity on WhatId.
    const rel = sobject === "Contact" || sobject === "Lead" ? "WhoId" : "WhatId";
    const at = a.at ? new Date(a.at) : new Date();
    if (a.kind === "meeting") {
      const id = await this.create("Event", {
        Subject: a.subject,
        [rel]: recordId,
        StartDateTime: at.toISOString(),
        DurationInMinutes: 30,
        Description: a.note,
      });
      return { id, url: this.url("Event", id), label: `Meeting "${a.subject}" logged in Salesforce` };
    }
    const id = await this.create("Task", {
      Subject: a.subject,
      [rel]: recordId,
      Status: "Completed",
      ActivityDate: at.toISOString().slice(0, 10),
      Description: a.note,
    });
    return { id, url: this.url("Task", id), label: `${a.kind === "call" ? "Call" : "Note"} "${a.subject}" logged in Salesforce` };
  }

  async crosslink(object: RecordObject, recordId: string, other: CrossRef): Promise<WriteResult> {
    const sobject = SalesforceWriter.sobjectOf(recordId, object);
    const line = `${other.crm}: ${other.url ?? other.id}`;
    const cur = await this.session.request("GET", `/sobjects/${sobject}/${recordId}?fields=Description`);
    const existing: string = cur?.Description ?? "";
    if (existing.includes(other.url ?? other.id))
      return { id: recordId, url: this.url(sobject, recordId), label: `${sobject} already links to ${other.crm}` };
    await this.session.request("PATCH", `/sobjects/${sobject}/${recordId}`, {
      Description: existing ? `${existing}\n${line}` : line,
    });
    return { id: recordId, url: this.url(sobject, recordId), label: `${other.crm} link written to the ${sobject} description` };
  }
}

/** "Ted Bruenich" → First/Last; a single word is the last name (required). */
export function splitName(full: string): { FirstName?: string; LastName?: string } {
  const [first, ...rest] = full.trim().split(/\s+/).filter(Boolean);
  if (!first) return {};
  return rest.length ? { FirstName: first, LastName: rest.join(" ") } : { LastName: first };
}
