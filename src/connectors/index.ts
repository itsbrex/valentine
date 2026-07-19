// Connector factory. The CLI and agent depend on this + the CRMConnector
// interface only — never on a specific CRM. Adding a CRM = a new case here.

import type { Config } from "../config.js";
import type { CRMConnector } from "./types.js";
import { AttioConnector } from "./attio.js";
import { AffinityConnector } from "./affinity.js";
import { SalesforceConnector } from "./salesforce.js";

/** The key the chosen CRM needs, if any. */
export function crmKey(cfg: Config): string | undefined {
  switch (cfg.crm) {
    case "affinity":
      return cfg.affinityKey;
    case "salesforce":
      return cfg.salesforceKey;
    default:
      return cfg.attioKey;
  }
}

export function makeConnector(cfg: Config): CRMConnector {
  const key = crmKey(cfg);
  if (!key) throw new Error(`No ${cfg.crm} API key found. Run \`valentine init\`.`);
  switch (cfg.crm) {
    case "affinity":
      return new AffinityConnector(key);
    case "salesforce":
      if (!cfg.salesforceInstanceUrl)
        throw new Error(
          "Salesforce needs an instance URL — set VALENTINE_SALESFORCE_INSTANCE_URL or run `valentine init`.",
        );
      return new SalesforceConnector(key, cfg.salesforceInstanceUrl);
    case "attio":
      return new AttioConnector(key);
    default:
      throw new Error(`Unsupported CRM: ${cfg.crm}`);
  }
}
