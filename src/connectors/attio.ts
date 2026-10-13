// Attio connector — READ-ONLY, data-model-agnostic.
// Relies only on Attio's STANDARD system features (present on every workspace):
//   - standard attributes: name, domains
//   - interaction signals: first/last_(email|calendar)_interaction, strongest_connection_*
//   - notes endpoint, list-entries endpoint, workspace members
// Anything custom or missing is skipped gracefully — never assumed.
// API ref: https://developers.attio.com  (base: https://api.attio.com/v2)
//
// Web app URLs (live-verified 2026-09-18 on app.attio.com):
//   record      https://app.attio.com/{slug}/company/{record_id}   (= the API's `web_url`)
//   tabs        …/activity · …/emails · …/team
//   list        https://app.attio.com/{slug}/collection/{list_id}  (redirects to its default view)
//   companies   https://app.attio.com/{slug}/companies
//   There is no /search route (it redirects home), and no deep link to a workspace member.

import type { CRMConnector, CRMMatch, CRMContext, SearchQuery, ListMembership, RecordLink, WebUrls } from "./types.js";

const BASE = "https://api.attio.com/v2";
const APP = "https://app.attio.com";

interface Rec {
  id: { record_id: string };
  values: Record<string, any>;
  /** Deep link into app.attio.com — present on every record the API returns. */
  web_url?: string;
}

export class AttioConnector implements CRMConnector {
  readonly name = "Attio";
  readonly webUrls: WebUrls;
  private memberCache?: Map<string, string>;
  private listNameCache?: Map<string, string>;
  /** Workspace slug for web URLs — learned from the first record's web_url or /self. */
  private slug?: string;
  constructor(private apiKey: string) {
    this.webUrls = {
      // No search route in the web app: the companies table is the closest thing.
      search: () => (this.slug ? `${APP}/${this.slug}/companies` : undefined),
    };
  }

  private async req(path: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Attio ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async whoami(): Promise<{ workspace: string }> {
    // Live-verified 2026-08: /self returns a FLAT token-introspection object
    // (workspace_name, workspace_id at top level) — no `data` wrapper.
    const data = await this.req("/self");
    const d = data?.data ?? data;
    if (d?.workspace_slug) this.slug = d.workspace_slug;
    return { workspace: d?.workspace_name ?? d?.workspace_id ?? "unknown" };
  }

  async search(q: SearchQuery): Promise<CRMMatch[]> {
    let filter: Record<string, any>;
    if (q.domain) filter = { domains: q.domain };
    else if (q.name) filter = { name: { $contains: q.name } };
    else return [];

    let recs: Rec[] = [];
    try {
      const page = await this.req(`/objects/${q.object}/records/query`, {
        method: "POST",
        body: JSON.stringify({ filter, limit: 10 }),
      });
      recs = page?.data ?? [];
    } catch {
      return []; // unknown attribute / object for this workspace → no match, never crash
    }

    const members = await this.members();
    return recs.map((r) => {
      const v = r.values;
      const li = interaction(v.last_interaction);
      // Attio has no standard owner attribute. The strongest connection says
      // who is *in touch*; a workspace that tracks assignment rolls its own
      // attribute for it. Prefer the assignment when there is one and keep
      // the connection as `contact`, so the card can show "Owner · Most in
      // touch" instead of conflating the two.
      const connId = actorRef(v.strongest_connection_user);
      const contact = members.get(connId ?? "") || undefined;
      const assigned = ownerAttrValue(v);
      const owner = assigned ?? contact;
      const ownerId = assigned ? undefined : connId;
      this.learnSlug(r.web_url);
      return {
        recordId: r.id.record_id,
        object: q.object,
        name: text(v.name),
        domain: domain(v.domains),
        owner,
        ...(owner && ownerId ? { ownerId } : {}),
        ...(contact && contact !== owner ? { contact } : {}),
        ...(linkedinUrl(v.linkedin) ? { linkedin: linkedinUrl(v.linkedin) } : {}),
        connectionStrength: select(v.strongest_connection_strength),
        lastEmail: dateOf(interaction(v.last_email_interaction)),
        lastMeeting: dateOf(interaction(v.last_calendar_interaction)),
        lastInteraction: li ? `${li.type} · ${li.date}` : undefined,
        firstInteraction: dateOf(interaction(v.first_interaction)),
        linkedPeople: count(v.team) ?? count(v.associated_people),
        ...(r.web_url
          ? {
              url: r.web_url,
              views: {
                activity: `${r.web_url}/activity`,
                emails: `${r.web_url}/emails`,
                ...(q.object === "companies" ? { people: `${r.web_url}/team` } : {}),
              },
            }
          : {}),
      };
    });
  }

  private learnSlug(webUrl?: string): void {
    if (this.slug || !webUrl) return;
    const m = /^https:\/\/app\.attio\.com\/([^/]+)\//.exec(webUrl);
    if (m) this.slug = m[1];
  }

  async getContext(object: "companies" | "people", id: string): Promise<CRMContext> {
    const [notes, lists, people] = await Promise.all([
      this.notes(object, id),
      this.lists(object, id),
      this.people(object, id),
    ]);
    return {
      notes,
      lists,
      people: people.map((p) => p.label),
      ...(people.some((p) => p.url) ? { peopleLinks: people.filter((p) => p.url) } : {}),
    };
  }

  // --- standard sub-fetches, each degrades to empty on error ---

  private async notes(object: string, id: string): Promise<string[]> {
    try {
      const d = await this.req(
        `/notes?parent_object=${object}&parent_record_id=${id}&limit=25`,
      );
      return (d?.data ?? [])
        .map((n: any) => n?.content_plaintext ?? n?.title ?? "")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async lists(object: string, id: string): Promise<ListMembership[]> {
    try {
      const d = await this.req(`/objects/${object}/records/${id}/entries`);
      const names = await this.listNames();
      return (d?.data ?? []).map((e: any) => {
        const listId: string | undefined = e?.list_id ?? e?.id?.list_id ?? undefined;
        return {
          list: names.get(listId ?? "") ?? e?.list_api_slug ?? "list",
          stage: select(e?.entry_values?.stage) ?? select(e?.entry_values?.status),
          kind: "list" as const,
          ...(listId ? { id: listId } : {}),
          ...(listId && this.slug ? { url: `${APP}/${this.slug}/collection/${listId}` } : {}),
        };
      });
    } catch {
      return [];
    }
  }

  private async people(object: string, id: string): Promise<RecordLink[]> {
    if (object !== "companies") return [];
    try {
      const rec = await this.req(`/objects/companies/records/${id}`);
      this.learnSlug(rec?.data?.web_url);
      const refs: string[] = (rec?.data?.values?.team ?? rec?.data?.values?.associated_people ?? [])
        .slice(0, 5)
        .map((t: any) => t?.target_record_id)
        .filter(Boolean);
      const people = await Promise.all(
        refs.map(async (pid): Promise<RecordLink | undefined> => {
          try {
            const p = await this.req(`/objects/people/records/${pid}`);
            const name = text(p?.data?.values?.name);
            if (!name) return undefined;
            const url = p?.data?.web_url ?? (this.slug ? `${APP}/${this.slug}/person/${pid}` : "");
            return { label: name, url };
          } catch {
            return undefined;
          }
        }),
      );
      return people.filter((p): p is RecordLink => !!p);
    } catch {
      return [];
    }
  }

  private async members(): Promise<Map<string, string>> {
    if (this.memberCache) return this.memberCache;
    const m = new Map<string, string>();
    try {
      const d = await this.req("/workspace_members");
      for (const x of d?.data ?? []) {
        const id = x?.id?.workspace_member_id;
        const name = [x.first_name, x.last_name].filter(Boolean).join(" ") || x.email_address;
        if (id) m.set(id, name);
      }
    } catch {
      /* no member access → owner stays unresolved */
    }
    this.memberCache = m;
    return m;
  }

  private async listNames(): Promise<Map<string, string>> {
    if (this.listNameCache) return this.listNameCache;
    const m = new Map<string, string>();
    try {
      const d = await this.req("/lists");
      for (const l of d?.data ?? []) {
        const id = l?.id?.list_id;
        if (id) m.set(id, l?.name ?? l?.api_slug ?? "list");
      }
    } catch {
      /* ignore */
    }
    this.listNameCache = m;
    return m;
  }
}

// --- value extractors: tolerant of Attio's nested, typed value arrays ---
const ymd = (iso?: string) => (iso ? iso.slice(0, 10) : undefined);
const first = (v: any) => (Array.isArray(v) && v.length ? v[0] : undefined);
const text = (v: any) => first(v)?.value ?? first(v)?.full_name ?? undefined;
const domain = (v: any) => first(v)?.domain ?? first(v)?.root_domain ?? undefined;
const select = (v: any) => first(v)?.option?.title ?? undefined;
const actorRef = (v: any) => first(v)?.referenced_actor_id ?? undefined;

/** Attio's standard enriched `linkedin` attribute — a company page on a
 *  company, a profile on a person. Read by its EXACT slug on purpose: a
 *  workspace can carry dozens of other `linkedin_*` attributes (handle, id,
 *  headline, last message…) and a loose match would grab the wrong one.
 *  Accepts a bare `company/acme` or `in/jane` path too, since some workspaces
 *  store the handle rather than the full URL. */
function linkedinUrl(raw: unknown): string | undefined {
  const v = first(raw);
  const s = (typeof v === "string" ? v : typeof v?.value === "string" ? v.value : "").trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) {
    try {
      return /(^|\.)linkedin\.com$/i.test(new URL(s).hostname) ? s : undefined;
    } catch {
      return undefined;
    }
  }
  const path = s.replace(/^\/+/, "");
  return /^(company|in|school|showcase)\//i.test(path) ? `https://www.linkedin.com/${path}` : undefined;
}

/** The workspace's own "owner" attribute, when it has one. Attio ships no
 *  standard owner field, so workspaces roll their own — a select or text
 *  attribute whose slug mentions owner (on this workspace, `account_owner`,
 *  mirrored from Salesforce). Read straight off the values already returned
 *  by the record query, so it costs no extra request and a workspace without
 *  one simply gets `undefined`. Email variants are skipped, and so is an
 *  actor-reference, which carries an id here rather than a display name. */
function ownerAttrValue(values: Record<string, any>): string | undefined {
  for (const [slug, raw] of Object.entries(values)) {
    if (!/owner/i.test(slug) || /email/i.test(slug)) continue;
    const f = first(raw);
    const t = f?.option?.title ?? (typeof f?.value === "string" ? f.value : undefined);
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return undefined;
}
const count = (v: any) => (Array.isArray(v) ? v.length : undefined);
function interaction(v: any): { type: string; date?: string } | undefined {
  const f = first(v);
  return f ? { type: f.interaction_type, date: ymd(f.interacted_at) } : undefined;
}
const dateOf = (i?: { date?: string }) => i?.date;
