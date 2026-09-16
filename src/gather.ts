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
  opts: { contextTop?: number } = {},
): Promise<Evidence> {
  const target = parseTarget(raw);
  const contextTop = opts.contextTop ?? 2;

  let found: CRMMatch[];
  if (target.kind === "domain") {
    found = await crm.search({ object: "companies", domain: target.value });
    // No company record → maybe a contact with that email domain (Salesforce
    // Contact.Email, Affinity persons). Connectors that can't filter people by
    // domain return [] without throwing.
    if (found.length === 0) found = await crm.search({ object: "people", domain: target.value });
  } else {
    const [companies, people] = await Promise.all([
      crm.search({ object: "companies", name: target.value }),
      crm.search({ object: "people", name: target.value }),
    ]);
    found = [...companies, ...people];
  }

  const matches = rankMatches(dedupe(found), target);
  const contexts = new Map<string, CRMContext>();
  await Promise.all(
    matches.slice(0, contextTop).map(async (m) => {
      try {
        contexts.set(m.recordId, await crm.getContext(m.object, m.recordId));
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
