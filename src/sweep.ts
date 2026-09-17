// Multi-CRM sweep. One brief (or agent loop) per configured CRM, then a
// combined verdict for anything that needs a single answer: exit codes, watch
// notifications, the top-level JSON fields. The per-CRM verdicts ride along so
// every surface can show e.g. the company Salesforce answer with the personal
// Attio answer underneath.
//
// Strategy (config `strategy` / VALENTINE_STRATEGY):
//   brief (default) — deterministic reads + one structured model call per CRM,
//                     CRMs swept in parallel. Seconds, not minutes, on a local
//                     model; a model failure costs the sentence, not the verdict.
//   agent           — the original tool-calling loop, sequential, primary first.

import type { Config, CrmId } from "./config.js";
import { activeCrms, sweepStrategy } from "./config.js";
import { makeConnector } from "./connectors/index.js";
import { lookup } from "./agent.js";
import { brief, type BriefOptions } from "./brief.js";
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
  /** Wall time for the whole sweep, ms. */
  elapsedMs?: number;
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
    ...(worst.facts ? { facts: worst.facts } : {}),
  };
}

export interface SweepOptions extends BriefOptions {}

/** Sweep every configured CRM for a target. */
export async function sweepAll(
  client: ModelClient,
  cfg: Config,
  target: string,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const t0 = Date.now();
  const strategy = sweepStrategy(cfg);

  const one = async (crm: CrmId): Promise<SourceVerdict> => {
    try {
      const connector = makeConnector(cfg, crm);
      const v =
        strategy === "agent"
          ? await lookup(client, cfg.model, connector, target)
          : await brief(client, cfg.model, connector, target, opts);
      return { crm, ...v };
    } catch (e: any) {
      // One unreachable CRM must not sink the others — an expired Salesforce
      // browser session shouldn't cost you the Attio answer 30 minutes before
      // the meeting. Surfaced as ambiguous, never clean: a source we couldn't
      // read is unknown, not safe.
      return {
        verdict: "ambiguous",
        summary: `Couldn't reach ${CRM_LABELS[crm]}: ${e?.message ?? e}`,
        citations: [],
        crm,
      };
    }
  };

  const crms = activeCrms(cfg);
  const sources: SourceVerdict[] = [];
  if (strategy === "agent") {
    for (const crm of crms) sources.push(await one(crm));
  } else {
    sources.push(...(await Promise.all(crms.map(one))));
  }
  return { combined: combineVerdicts(sources), sources, elapsedMs: Date.now() - t0 };
}
