// Attio writer — OPT-IN. Uses its own token (config `attioWriteKey` /
// VALENTINE_ATTIO_WRITE_KEY) so the read token can stay read-only; falls back
// to the read token only when writes are switched on and no write token is set.
// Standard attributes only: companies.name / domains, people.name /
// email_addresses / company, and the notes endpoint. An "owner" is not a
// standard company attribute in Attio (the read side infers it from
// strongest_connection_user), so claimOwner looks for a writable
// actor-reference attribute called owner and says so when there is none.
//
// API: POST /v2/objects/{object}/records → { data: { id, web_url } }
//      PATCH …/records/{id}  (appends to multiselects) · PUT (overwrites)
//      POST /v2/notes · GET /v2/objects/{object}/attributes · GET /v2/self

import type { CRMWriter, WriteResult, RecordObject, CompanyDraft, PersonDraft, ActivityDraft, CrossRef } from "./types.js";

const BASE = "https://api.attio.com/v2";
const APP = "https://app.attio.com";

export class AttioWriter implements CRMWriter {
  readonly name = "Attio";
  private me?: { id: string; name?: string };
  private slug?: string;
  private ownerAttr?: string | null;

  constructor(private apiKey: string) {}

  private async req(method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Attio ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  private learnSlug(webUrl?: string): void {
    if (this.slug || !webUrl) return;
    const m = /^https:\/\/app\.attio\.com\/([^/]+)\//.exec(webUrl);
    if (m) this.slug = m[1];
  }

  private url(object: RecordObject, id: string, webUrl?: string): string | undefined {
    if (webUrl) return webUrl;
    return this.slug ? `${APP}/${this.slug}/${object === "people" ? "person" : "company"}/${id}` : undefined;
  }

  async whoami(): Promise<{ id: string; name?: string }> {
    if (this.me) return this.me;
    const d = await this.req("GET", "/self");
    const s = d?.data ?? d;
    if (s?.workspace_slug) this.slug = s.workspace_slug;
    const id: string | undefined = s?.authorized_by_workspace_member_id ?? undefined;
    if (!id) throw new Error("Attio token is not a workspace member's (no authorized_by_workspace_member_id) — writes need a user token.");
    this.me = { id };
    return this.me;
  }

  private async createRecord(object: RecordObject, values: Record<string, unknown>): Promise<{ id: string; url?: string }> {
    const d = await this.req("POST", `/objects/${object}/records`, { data: { values } });
    const id: string | undefined = d?.data?.id?.record_id;
    if (!id) throw new Error(`Attio did not return a record id for the new ${object} record.`);
    this.learnSlug(d?.data?.web_url);
    return { id, url: this.url(object, id, d?.data?.web_url) };
  }

  async createCompany(d: CompanyDraft): Promise<WriteResult> {
    const values: Record<string, unknown> = { name: d.name };
    if (d.domain) values.domains = [d.domain];
    const rec = await this.createRecord("companies", values);
    if (d.note) await this.note("companies", rec.id, "Source", d.note);
    if (d.ownerId) await this.claimOwner("companies", rec.id, d.ownerId).catch(() => undefined);
    return { ...rec, label: `Company ${d.name} created in Attio` };
  }

  async createPerson(d: PersonDraft): Promise<WriteResult> {
    const [first, ...rest] = d.name.trim().split(/\s+/).filter(Boolean);
    const values: Record<string, unknown> = {
      name: [{ first_name: first ?? d.name, last_name: rest.join(" "), full_name: d.name.trim() }],
    };
    if (d.email) values.email_addresses = [d.email];
    if (d.companyId) values.company = [{ target_object: "companies", target_record_id: d.companyId }];
    const rec = await this.createRecord("people", values);
    if (d.note) await this.note("people", rec.id, "Source", d.note);
    return { ...rec, label: `Person ${d.name} created in Attio` };
  }

  /** The writable actor-reference attribute that plays "owner" on companies,
   *  if the workspace has one. Cached; null when absent. */
  private async ownerAttribute(object: RecordObject): Promise<string | null> {
    if (this.ownerAttr !== undefined) return this.ownerAttr;
    const d = await this.req("GET", `/objects/${object}/attributes`);
    const attrs: any[] = d?.data ?? [];
    const hit = attrs.find(
      (a) => a?.type === "actor-reference" && a?.is_writable !== false && /owner/i.test(`${a?.api_slug} ${a?.title}`),
    );
    this.ownerAttr = (hit?.api_slug as string | undefined) ?? null;
    return this.ownerAttr;
  }

  async claimOwner(object: RecordObject, recordId: string, ownerId?: string): Promise<WriteResult> {
    const attr = await this.ownerAttribute(object);
    if (!attr)
      throw new Error(
        "Attio has no owner attribute on this object — add one (type: user / actor reference, named Owner) and try again.",
      );
    const owner = ownerId ?? (await this.whoami()).id;
    const d = await this.req("PATCH", `/objects/${object}/records/${recordId}`, {
      data: { values: { [attr]: [{ referenced_actor_type: "workspace-member", referenced_actor_id: owner }] } },
    });
    this.learnSlug(d?.data?.web_url);
    return { id: recordId, url: this.url(object, recordId, d?.data?.web_url), label: `Attio ${attr} set to you` };
  }

  private async note(object: RecordObject, recordId: string, title: string, content: string): Promise<string> {
    const d = await this.req("POST", "/notes", {
      data: { parent_object: object, parent_record_id: recordId, title, format: "plaintext", content },
    });
    return d?.data?.id?.note_id ?? "";
  }

  async addNote(object: RecordObject, recordId: string, text: string): Promise<WriteResult> {
    await this.note(object, recordId, text.slice(0, 60), text);
    return { id: recordId, url: this.url(object, recordId), label: "Note added in Attio" };
  }

  async logActivity(object: RecordObject, recordId: string, a: ActivityDraft): Promise<WriteResult> {
    // Attio has no first-class activity object for third parties; a dated note
    // is what its own "log" does, and the read side folds notes into context.
    const when = (a.at ? new Date(a.at) : new Date()).toISOString().slice(0, 10);
    const head = a.kind === "meeting" ? "Meeting" : a.kind === "call" ? "Call" : "Note";
    await this.note(object, recordId, `${head} · ${when} · ${a.subject}`.slice(0, 80), a.note ?? a.subject);
    return { id: recordId, url: this.url(object, recordId), label: `${head} "${a.subject}" logged in Attio` };
  }

  async crosslink(object: RecordObject, recordId: string, other: CrossRef): Promise<WriteResult> {
    await this.note(object, recordId, `${other.crm} record`, `${other.crm}: ${other.url ?? other.id}`);
    return { id: recordId, url: this.url(object, recordId), label: `${other.crm} link noted on the Attio record` };
  }

  async rematch(domain: string, wrongRecordId: string, right: { name: string; note?: string }): Promise<WriteResult> {
    // 1. take the domain off the wrong company (PUT overwrites the multiselect)
    const cur = await this.req("GET", `/objects/companies/records/${wrongRecordId}`);
    this.learnSlug(cur?.data?.web_url);
    const domains: string[] = (cur?.data?.values?.domains ?? []).map((d: any) => d?.domain ?? d).filter(Boolean);
    const wrongName = cur?.data?.values?.name?.[0]?.value ?? "the other company";
    const rest = domains.filter((d) => d.toLowerCase() !== domain.toLowerCase());
    if (rest.length !== domains.length) await this.req("PUT", `/objects/companies/records/${wrongRecordId}`, { data: { values: { domains: rest } } });
    await this.note("companies", wrongRecordId, "Domain moved", `${domain} moved to "${right.name}" by Valentine — it did not belong here.`);
    // 2. the right company, owning the domain
    const rec = await this.createRecord("companies", { name: right.name, domains: [domain] });
    await this.note("companies", rec.id, "Source", right.note ?? `${domain} was previously on "${wrongName}" (${wrongRecordId}).`);
    return { ...rec, label: `${domain} moved from "${wrongName}" to new company ${right.name} in Attio` };
  }
}
