// Connector factory. The CLI and agent depend on this + the CRMConnector
// interface only — never on a specific CRM. Adding a CRM = a new case here.
// Every function takes an optional crm override so multi-CRM sweeps can build
// a connector per configured CRM (activeCrms) instead of just cfg.crm.

import type { Config, CrmId } from "../config.js";
import { activeCrms } from "../config.js";
import type { CRMConnector } from "./types.js";
import { AttioConnector } from "./attio.js";
import { AffinityConnector } from "./affinity.js";
import { SalesforceConnector } from "./salesforce.js";

/** The credential the given CRM needs, if any. For Salesforce a sid command
 *  counts — the connector mints tokens from it on demand. */
export function crmKey(cfg: Config, crm: CrmId = cfg.crm): string | undefined {
  switch (crm) {
    case "affinity":
      return cfg.affinityKey;
    case "salesforce":
      return cfg.salesforceKey ?? cfg.salesforceSidCommand;
    default:
      return cfg.attioKey;
  }
}

/** Configured CRMs that are missing credentials — [] when ready to sweep. */
export function missingCrmCreds(cfg: Config): CrmId[] {
  return activeCrms(cfg).filter(
    (crm) => !crmKey(cfg, crm) || (crm === "salesforce" && !cfg.salesforceInstanceUrl),
  );
}

export function makeConnector(cfg: Config, crm: CrmId = cfg.crm): CRMConnector {
  const key = crmKey(cfg, crm);
  if (!key) throw new Error(`No ${crm} API key found. Run \`valentine init\`.`);
  switch (crm) {
    case "affinity":
      return new AffinityConnector(key);
    case "salesforce":
      if (!cfg.salesforceInstanceUrl)
        throw new Error(
          "Salesforce needs an instance URL — set VALENTINE_SALESFORCE_INSTANCE_URL or run `valentine init`.",
        );
      return new SalesforceConnector(
        { token: cfg.salesforceKey, command: cfg.salesforceSidCommand },
        cfg.salesforceInstanceUrl,
      );
    case "attio":
      return new AttioConnector(key);
    default:
      throw new Error(`Unsupported CRM: ${crm}`);
  }
}
