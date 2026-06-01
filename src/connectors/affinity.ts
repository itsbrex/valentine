// Affinity connector — READ-ONLY, data-model-agnostic.
// Relies only on Affinity's STANDARD V1 features (present on every tenant):
//   - organization/person search with interaction dates + persons
//   - the notes endpoint, the single-record `list_entries`, the lists endpoint
// Anything custom or missing is skipped gracefully — never assumed.
// API ref: https://api-docs.affinity.co  (base: https://api.affinity.co)
//
// Object mapping: Valentine's "companies" -> Affinity "organizations",
// "people" -> "persons". Owner/connection-strength have no standard
// org-level equivalent in V1, so they stay unresolved — the verdict still
// fires on interaction dates, list membership, and notes.

import type { CRMConnector, CRMMatch, CRMContext, SearchQuery } from "./types.js";

const BASE = "https://api.affinity.co";

/** Valentine object -> Affinity REST collection + its notes query param. */
const MAP = {
  companies: { path: "organizations", noteParam: "organization_id", listKey: "organizations" },
  people: { path: "persons", noteParam: "person_id", listKey: "persons" },
} as const;

export class AffinityConnector implements CRMConnector {
  readonly name = "Affinity";
  private listNameCache?: Map<number, string>;
  constructor(private apiKey: string) {}

  private async req(path: string, init: RequestInit = {}) {
    // V1 uses HTTP Basic auth: API key as the password, empty username.
    const basic = Buffer.from(`:${this.apiKey}`).toString("base64");
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Affinity ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async whoami(): Promise<{ workspace: string }> {
    const data = await this.req("/whoami");
    const t = data?.tenant ?? {};
    return { workspace: t.name ?? t.subdomain ?? `tenant ${t.id ?? "?"}` };
  }

  async search(q: SearchQuery): Promise<CRMMatch[]> {
    const term = q.domain ?? q.name;
    if (!term) return [];
    const m = MAP[q.object];

    let recs: any[] = [];
    try {
      const qs = new URLSearchParams({
        term,
        with_interaction_dates: "true",
        with_interaction_persons: "true",
      });
      const page = await this.req(`/${m.path}?${qs}`);
      recs = page?.[m.listKey] ?? [];
    } catch {
      return []; // bad term / no access for this object → no match, never crash
    }

    return recs.slice(0, 10).map((r) => {
      const d = r.interaction_dates ?? {};
      return {
        recordId: String(r.id),
        object: q.object,
        name: r.name ?? fullName(r),
        domain: r.domain ?? first(r.domains),
        lastEmail: ymd(d.last_email_date),
        lastMeeting: ymd(d.last_event_date),
        lastInteraction: lastInteraction(d),
        firstInteraction: ymd(d.first_email_date) ?? ymd(d.first_event_date),
        linkedPeople: count(r.person_ids),
      } satisfies CRMMatch;
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

  private async notes(object: "companies" | "people", id: string): Promise<string[]> {
    try {
      const d = await this.req(`/notes?${MAP[object].noteParam}=${id}`);
      const arr = Array.isArray(d) ? d : (d?.notes ?? []);
      return arr
        .slice(0, 25)
        .map((n: any) => stripHtml(n?.content ?? ""))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async lists(object: "companies" | "people", id: string): Promise<{ list: string; stage?: string }[]> {
    try {
      // The single-record GET carries the record's `list_entries`.
      const rec = await this.req(`/${MAP[object].path}/${id}`);
      const entries: any[] = rec?.list_entries ?? [];
      const names = await this.listNames();
      // Dedupe to one row per list (a record can have several entries on one list).
      const seen = new Map<number, { list: string; stage?: string }>();
      for (const e of entries) {
        const lid = e?.list_id;
        if (lid == null || seen.has(lid)) continue;
        seen.set(lid, { list: names.get(lid) ?? `list ${lid}` });
      }
      return [...seen.values()];
    } catch {
      return [];
    }
  }

  private async people(object: "companies" | "people", id: string): Promise<string[]> {
    if (object !== "companies") return [];
    try {
      const rec = await this.req(`/organizations/${id}`);
      const ids: number[] = (rec?.person_ids ?? []).slice(0, 5);
      const names = await Promise.all(
        ids.map(async (pid) => {
          try {
            const p = await this.req(`/persons/${pid}`);
            return fullName(p);
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

  private async listNames(): Promise<Map<number, string>> {
    if (this.listNameCache) return this.listNameCache;
    const m = new Map<number, string>();
    try {
      const d = await this.req("/lists");
      for (const l of Array.isArray(d) ? d : (d?.lists ?? [])) {
        if (l?.id != null) m.set(l.id, l?.name ?? `list ${l.id}`);
      }
    } catch {
      /* no list access → list names stay generic */
    }
    this.listNameCache = m;
    return m;
  }
}

// --- value extractors ---
const ymd = (iso?: string) => (iso ? String(iso).slice(0, 10) : undefined);
const first = (v: any) => (Array.isArray(v) && v.length ? v[0] : undefined);
const count = (v: any) => (Array.isArray(v) ? v.length : undefined);
const fullName = (r: any) =>
  [r?.first_name, r?.last_name].filter(Boolean).join(" ") || r?.primary_email || undefined;
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Label the single most-recent interaction by which dated field it matches. */
function lastInteraction(d: any): string | undefined {
  const last = d?.last_interaction_date;
  if (!last) return undefined;
  const date = ymd(last);
  const type =
    last === d.last_email_date ? "email" : last === d.last_event_date ? "meeting" : "interaction";
  return `${type} · ${date}`;
}
