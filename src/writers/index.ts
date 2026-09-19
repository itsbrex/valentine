// Writer factory — the one place writes are gated. `makeWriter` returns
// undefined unless writes are switched on (config `writes` / VALENTINE_WRITES)
// AND the CRM has a writer, so every caller has to handle "no". The Salesforce
// writer rides on the read connector's session; Attio gets its own token.

import type { Config, CrmId } from "../config.js";
import { writesEnabled } from "../config.js";
import { SalesforceSession } from "../connectors/salesforce.js";
import type { CRMWriter } from "./types.js";
import { SalesforceWriter } from "./salesforce.js";
import { AttioWriter } from "./attio.js";

export type { CRMWriter, WriteResult } from "./types.js";

export function makeWriter(cfg: Config, crm: CrmId): CRMWriter | undefined {
  if (!writesEnabled(cfg)) return undefined;
  switch (crm) {
    case "salesforce": {
      const auth = { token: cfg.salesforceKey, command: cfg.salesforceSidCommand };
      if (!(auth.token || auth.command) || !cfg.salesforceInstanceUrl) return undefined;
      return new SalesforceWriter(new SalesforceSession(auth, cfg.salesforceInstanceUrl));
    }
    case "attio": {
      const key = cfg.attioWriteKey ?? cfg.attioKey;
      return key ? new AttioWriter(key) : undefined;
    }
    default:
      return undefined; // Affinity: no writer yet
  }
}
