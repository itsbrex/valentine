// How a record ties to a domain target, for connectors whose search is looser
// than an exact key (Salesforce `Website LIKE`, Affinity term search). Only the
// record's own domain confirms it; a subdomain is a candidate a human checks.

export type HostTie = "domain" | "subdomain";

/** "hines.com" vs "www.hines.com" → "domain"; vs "emea.hines.com" →
 *  "subdomain"; vs "machines.com" → undefined. */
export function hostTie(host: string | undefined, domain: string): HostTie | undefined {
  const h = host?.toLowerCase().replace(/^www\./, "");
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (!h) return undefined;
  if (h === d) return "domain";
  return h.endsWith(`.${d}`) ? "subdomain" : undefined;
}

/** The strongest tie across several hosts (an organization's domains, a
 *  person's email domains). */
export function bestTie(hosts: (string | undefined)[], domain: string): HostTie | undefined {
  const ties = hosts.map((h) => hostTie(h, domain));
  return ties.includes("domain") ? "domain" : ties.includes("subdomain") ? "subdomain" : undefined;
}
