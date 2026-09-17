// THE FAST PATH, step one: gather. For a domain the read sequence is always
// the same — search companies by domain, pull context on the best match — so
// there is nothing for a model to decide. Doing it in code instead of an agent
// loop turns 3–10 model round-trips into zero, and it cannot fail the way a
// small model's tool call can (mis-typed argument, truncated JSON, wrong tool).
// Names are searched across companies AND people. Still read-only.

import type { CRMConnector, CRMMatch, CRMContext } from "./connectors/types.js";

export type TargetKind = "domain" | "name";

export interface Target {
  kind: TargetKind;
  /** Normalized value: lower-cased bare domain, or the trimmed name. */
  value: string;
  raw: string;
}

/** A step in a sweep, for live instrumentation (the lab dashboard, verbose
 *  logs). Pure data; emitted through `TraceFn` when a caller asks for one. */
export type TraceEvent =
  | { type: "search"; crm: string; object: "companies" | "people"; by: "domain" | "name"; term: string; ms: number; matches: number }
  | { type: "context"; crm: string; recordId: string; name?: string; ms: number; notes: number; lists: number; people: number }
  | { type: "rank"; crm: string; top?: string; matches: number }
  | { type: "judge"; crm: string; verdict: "prior_contact" | "clean" | "ambiguous"; owner?: string; lastTouch?: string; status?: string }
  | { type: "model.start"; crm: string; model: string; prompt: string }
  | { type: "model.end"; crm: string; model: string; ms: number; raw?: string; summary?: string; accepted: boolean; reason?: string; usage?: ModelUsage }
  | { type: "model.skip"; crm: string; reason: string }
  | { type: "source.done"; crm: string; verdict: "prior_contact" | "clean" | "ambiguous"; ms: number; summary: string };

/** What a local model server reports about one call. */
export interface ModelUsage {
  promptTokens?: number;
  genTokens?: number;
  loadMs?: number;
  promptMs?: number;
  genMs?: number;
  mode?: "prefill" | "format" | "tool";
}

export type TraceFn = (e: TraceEvent) => void;

export interface Evidence {
  target: Target;
  /** Ranked: exact-domain matches first, then anything with a signal. */
  matches: CRMMatch[];
  /** Context for the top matches, by record id. */
  contexts: Map<string, CRMContext>;
}

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** "https://www.Acme.com/about", "jane@acme.com", "acme.com" → domain acme.com;
 *  anything else is a name. */
export function parseTarget(raw: string): Target {
  let s = raw.trim();
  const at = s.indexOf("@");
  if (at !== -1 && !/\s/.test(s)) s = s.slice(at + 1);
  s = s.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "");
  s = s.replace(/^www\./i, "").toLowerCase();
  if (DOMAIN_RE.test(s)) return { kind: "domain", value: s, raw };
  return { kind: "name", value: raw.trim(), raw };
}

/** Any read-only signal that someone at the fund touched this record. */
export function hasSignal(m: CRMMatch, ctx?: CRMContext): boolean {
  if (
    m.owner ||
    m.connectionStrength ||
    m.lastEmail ||
    m.lastMeeting ||
    m.lastInteraction ||
    m.firstInteraction ||
    (m.linkedPeople ?? 0) > 0
  )
    return true;
  if (ctx && (ctx.notes.length || ctx.lists.length || ctx.people.length)) return true;
  return false;
}

/** Latest YYYY-MM-DD on a match, for recency ordering. */
export function latestDate(m: CRMMatch): string {
  const dates = [m.lastMeeting, m.lastEmail, m.lastInteraction?.split(" · ").pop()].filter(
    (d): d is string => !!d,
  );
  return dates.sort().pop() ?? "";
}

/** Order matches so the one the verdict should rest on comes first: the
 *  record that IS the target (exact domain, or a name carrying the domain's
 *  label — "Hines" for hines.com, over "Urban Oaks Builders" that merely
 *  shares the website), then the most recently touched. */
export function rankMatches(matches: CRMMatch[], target: Target): CRMMatch[] {
  const label = target.kind === "domain" ? target.value.split(".")[0] : target.value.toLowerCase();
  const score = (m: CRMMatch): number => {
    let s = 0;
    const name = m.name?.toLowerCase() ?? "";
    if (target.kind === "domain" && m.domain?.toLowerCase() === target.value) s += 100;
    if (name === label || name === target.value.toLowerCase()) s += 80;
    else if (label.length >= 3 && name.includes(label)) s += 40;
    if (m.object === "companies") s += 10;
    if (hasSignal(m)) s += 5;
    return s;
  };
  return [...matches].sort((a, b) => {
    const d = score(b) - score(a);
    return d !== 0 ? d : latestDate(b).localeCompare(latestDate(a));
  });
}

/** Sweep one CRM for a target: search, rank, pull context on the top matches. */
export async function gather(
  crm: CRMConnector,
  raw: string,
  opts: { contextTop?: number; trace?: TraceFn } = {},
): Promise<Evidence> {
  const target = parseTarget(raw);
  const contextTop = opts.contextTop ?? 2;
  const trace = opts.trace ?? (() => {});

  const search = async (object: "companies" | "people"): Promise<CRMMatch[]> => {
    const t0 = Date.now();
    const q = target.kind === "domain" ? { object, domain: target.value } : { object, name: target.value };
    const out = await crm.search(q);
    trace({ type: "search", crm: crm.name, object, by: target.kind, term: target.value, ms: Date.now() - t0, matches: out.length });
    return out;
  };

  let found: CRMMatch[];
  if (target.kind === "domain") {
    found = await search("companies");
    // No company record → maybe a contact with that email domain (Salesforce
    // Contact.Email, Affinity persons). Connectors that can't filter people by
    // domain return [] without throwing.
    if (found.length === 0) found = await search("people");
  } else {
    const [companies, people] = await Promise.all([search("companies"), search("people")]);
    found = [...companies, ...people];
  }

  const matches = rankMatches(dedupe(found), target);
  trace({ type: "rank", crm: crm.name, top: matches[0]?.name ?? matches[0]?.recordId, matches: matches.length });
  const contexts = new Map<string, CRMContext>();
  await Promise.all(
    matches.slice(0, contextTop).map(async (m) => {
      const t0 = Date.now();
      try {
        const ctx = await crm.getContext(m.object, m.recordId);
        contexts.set(m.recordId, ctx);
        trace({ type: "context", crm: crm.name, recordId: m.recordId, name: m.name, ms: Date.now() - t0, notes: ctx.notes.length, lists: ctx.lists.length, people: ctx.people.length });
      } catch {
        /* context is a bonus — the search signals alone still decide */
      }
    }),
  );
  return { target, matches, contexts };
}

function dedupe(list: CRMMatch[]): CRMMatch[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    const key = `${m.object}:${m.recordId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
