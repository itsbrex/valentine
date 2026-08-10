// Render a verdict for humans / machines, and map it to an exit code so that
// watch/Slack/scripts can branch on the result (SPEC §11). Multi-CRM sweeps
// render one labeled block per CRM; single-CRM output is byte-identical to
// what it always was.

import pc from "picocolors";
import type { Verdict } from "./connectors/types.js";
import { CRM_LABELS, type SweepResult } from "./sweep.js";

export function exitCodeFor(v: Verdict): number {
  if (v.verdict === "clean") return 0;
  if (v.verdict === "prior_contact") return 10;
  return 20; // ambiguous
}

export function renderVerdict(v: Verdict): string {
  const head =
    v.verdict === "prior_contact"
      ? pc.yellow(pc.bold("⚠ Prior contact"))
      : v.verdict === "clean"
        ? pc.green(pc.bold("✅ Clear"))
        : pc.dim(pc.bold("❓ Ambiguous"));

  const lines = [head, v.summary];
  const meta: string[] = [];
  if (v.owner) meta.push(`Owner: ${v.owner}`);
  if (v.lastTouch) meta.push(`Last touch: ${v.lastTouch}`);
  if (v.status) meta.push(`Status: ${v.status}`);
  if (meta.length) lines.push(pc.dim(meta.join(" · ")));
  if (v.citations.length) lines.push(pc.dim(`Records: ${v.citations.join(", ")}`));
  return lines.join("\n");
}

export function toJson(v: Verdict, target: string): string {
  return JSON.stringify({ target, ...v }, null, 2);
}

/** Human rendering for a sweep: single-CRM unchanged; multi-CRM gets one
 *  labeled block per source, primary first. */
export function renderSweep(res: SweepResult): string {
  if (res.sources.length === 1) return renderVerdict(res.combined);
  return res.sources
    .map(({ crm, ...v }) => pc.bold(pc.underline(CRM_LABELS[crm])) + "\n" + renderVerdict(v))
    .join("\n\n");
}

/** JSON for a sweep: single-CRM keeps the documented flat shape; multi-CRM
 *  adds a `sources` array of per-CRM verdicts under the combined top level. */
export function sweepToJson(res: SweepResult, target: string): string {
  if (res.sources.length === 1) return toJson(res.combined, target);
  return JSON.stringify({ target, ...res.combined, sources: res.sources }, null, 2);
}
