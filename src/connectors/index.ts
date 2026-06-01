// Connector factory. The CLI and agent depend on this + the CRMConnector
// interface only — never on a specific CRM. Adding a CRM = a new case here.

import type { Config } from "../config.js";
import type { CRMConnector } from "./types.js";
import { AttioConnector } from "./attio.js";
import { AffinityConnector } from "./affinity.js";

/** The key the chosen CRM needs, if any. */
export function crmKey(cfg: Config): string | undefined {
  return cfg.crm === "affinity" ? cfg.affinityKey : cfg.attioKey;
}

export function makeConnector(cfg: Config): CRMConnector {
  const key = crmKey(cfg);
  if (!key) throw new Error(`No ${cfg.crm} API key found. Run \`valentine init\`.`);
  switch (cfg.crm) {
    case "affinity":
      return new AffinityConnector(key);
    case "attio":
      return new AttioConnector(key);
    default:
      throw new Error(`Unsupported CRM: ${cfg.crm}`);
  }
}
