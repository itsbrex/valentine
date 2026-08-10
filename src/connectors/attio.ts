// Attio connector — READ-ONLY, data-model-agnostic.
// Relies only on Attio's STANDARD system features (present on every workspace):
//   - standard attributes: name, domains
//   - interaction signals: first/last_(email|calendar)_interaction, strongest_connection_*
//   - notes endpoint, list-entries endpoint, workspace members
// Anything custom or missing is skipped gracefully — never assumed.
// API ref: https://developers.attio.com  (base: https://api.attio.com/v2)

import type { CRMConnector, CRMMatch, CRMContext, SearchQuery } from "./types.js";

const BASE = "https://api.attio.com/v2";

interface Rec {
  id: { record_id: string };
  values: Record<string, any>;
}

export class AttioConnector implements CRMConnector {
  readonly name = "Attio";
  private memberCache?: Map<string, string>;
  private listNameCache?: Map<string, string>;
  constructor(private apiKey: string) {}

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
      return {
        recordId: r.id.record_id,
        object: q.object,
        name: text(v.name),
        domain: domain(v.domains),
        owner: members.get(actorRef(v.strongest_connection_user) ?? "") || undefined,
        connectionStrength: select(v.strongest_connection_strength),
        lastEmail: dateOf(interaction(v.last_email_interaction)),
        lastMeeting: dateOf(interaction(v.last_calendar_interaction)),
        lastInteraction: li ? `${li.type} · ${li.date}` : undefined,
        firstInteraction: dateOf(interaction(v.first_interaction)),
        linkedPeople: count(v.team) ?? count(v.associated_people),
      };
    });
  }

  async getContext(object: "companies" | "people", id: string): Promise<CRMContext> {
    const [notes, lists, people] = await Promise.all([
      this.notes(object, id),
      this.lists(object, id),
      this.people(object, id),
    ]);
    return { notes, lists, people };
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

  private async lists(object: string, id: string): Promise<{ list: string; stage?: string }[]> {
    try {
      const d = await this.req(`/objects/${object}/records/${id}/entries`);
      const names = await this.listNames();
      return (d?.data ?? []).map((e: any) => ({
        list: names.get(e?.list_id ?? e?.id?.list_id ?? "") ?? "list",
        stage: select(e?.entry_values?.stage) ?? select(e?.entry_values?.status),
      }));
    } catch {
      return [];
    }
  }

  private async people(object: string, id: string): Promise<string[]> {
    if (object !== "companies") return [];
    try {
      const rec = await this.req(`/objects/companies/records/${id}`);
      const refs: string[] = (rec?.data?.values?.team ?? rec?.data?.values?.associated_people ?? [])
        .slice(0, 5)
        .map((t: any) => t?.target_record_id)
        .filter(Boolean);
      const names = await Promise.all(
        refs.map(async (pid) => {
          try {
            const p = await this.req(`/objects/people/records/${pid}`);
            return text(p?.data?.values?.name);
          } catch {
            return undefined;
          }
        }),
      );
      return names.filter(Boolean) as string[];
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
const count = (v: any) => (Array.isArray(v) ? v.length : undefined);
function interaction(v: any): { type: string; date?: string } | undefined {
  const f = first(v);
  return f ? { type: f.interaction_type, date: ymd(f.interacted_at) } : undefined;
}
const dateOf = (i?: { date?: string }) => i?.date;
