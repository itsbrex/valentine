// Multi-CRM sweep. One agent loop per configured CRM (activeCrms — primary
// first), then a combined verdict for anything that needs a single answer:
// exit codes, watch notifications, the top-level JSON fields. The per-CRM
// verdicts ride along so every surface can show e.g. the company Salesforce
// answer with the personal Attio answer underneath.

import type { Config, CrmId } from "./config.js";
import { activeCrms } from "./config.js";
import { makeConnector } from "./connectors/index.js";
import { lookup } from "./agent.js";
import type { ModelClient } from "./models.js";
import type { Verdict } from "./connectors/types.js";

export const CRM_LABELS: Record<CrmId, string> = {
  attio: "Attio",
  affinity: "Affinity",
  salesforce: "Salesforce",
};

export interface SourceVerdict extends Verdict {
  crm: CrmId;
}

export interface SweepResult {
  /** Worst-of across sources — what exit codes and notifications key on. */
  combined: Verdict;
  /** Per-CRM verdicts, in configured order (primary first). */
  sources: SourceVerdict[];
}

const SEVERITY: Record<Verdict["verdict"], number> = {
  clean: 0,
  ambiguous: 1,
  prior_contact: 2,
};

/** Fold per-CRM verdicts into one: worst verdict wins; when several CRMs are
 *  in play and something was found, each finding's summary is tagged with its
 *  CRM so a one-line surface (watch, exit-code callers) still says where. */
export function combineVerdicts(sources: SourceVerdict[]): Verdict {
  if (sources.length === 1) {
    const { crm: _crm, ...v } = sources[0];
    return v;
  }
  const worst = sources.reduce((a, b) => (SEVERITY[b.verdict] > SEVERITY[a.verdict] ? b : a));
  const flagged = sources.filter((s) => s.verdict === worst.verdict);
  const summary =
    worst.verdict === "clean"
      ? worst.summary
      : flagged.map((s) => `[${CRM_LABELS[s.crm]}] ${s.summary}`).join(" · ");
  return {
    verdict: worst.verdict,
    summary,
    owner: worst.owner,
    lastTouch: worst.lastTouch,
    status: worst.status,
    citations: [...new Set(sources.flatMap((s) => s.citations))],
  };
}

/** Sweep every configured CRM for a target. Sequential, primary first. */
export async function sweepAll(
  client: ModelClient,
  cfg: Config,
  target: string,
): Promise<SweepResult> {
  const sources: SourceVerdict[] = [];
  for (const crm of activeCrms(cfg)) {
    const v = await lookup(client, cfg.model, makeConnector(cfg, crm), target);
    sources.push({ crm, ...v });
  }
  return { combined: combineVerdicts(sources), sources };
}
