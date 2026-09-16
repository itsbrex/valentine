// Render a verdict for humans / machines, and map it to an exit code so that
// watch/Slack/scripts can branch on the result (SPEC §11). Multi-CRM sweeps
// render one labeled block per CRM; single-CRM output keeps its head + summary
// lines byte-identical, with the structured facts and click-through links
// (OSC 8 hyperlinks — iTerm2, Terminal.app 15+, WezTerm, kitty, VS Code)
// underneath.

import pc from "picocolors";
import type { Verdict, RecordLink } from "./connectors/types.js";
import { CRM_LABELS, type SweepResult } from "./sweep.js";

export function exitCodeFor(v: Verdict): number {
  if (v.verdict === "clean") return 0;
  if (v.verdict === "prior_contact") return 10;
  return 20; // ambiguous
}

/** Clickable label in terminals that support OSC 8; plain "label (url)" elsewhere. */
export function hyperlink(label: string, url: string, tty = process.stdout.isTTY): string {
  if (!tty || process.env.NO_HYPERLINKS) return `${label} ${pc.dim(`(${url})`)}`;
  return `]8;;${url}${label}]8;;`;
}

function linksLine(links: RecordLink[]): string {
  return links.map((l) => pc.cyan(hyperlink(l.label, l.url))).join(pc.dim("  ·  "));
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

  const f = v.facts;
  if (f) {
    const extra: string[] = [];
    if (f.connectionStrength) extra.push(`Connection: ${f.connectionStrength}`);
    if (f.firstInteraction) extra.push(`First contact: ${f.firstInteraction}`);
    if (f.people.length) extra.push(`Contacts: ${f.people.slice(0, 4).join(", ")}${f.people.length > 4 ? ` +${f.people.length - 4}` : ""}`);
    if (extra.length) lines.push(pc.dim(extra.join(" · ")));
    if (f.lists.length && !v.status)
      lines.push(pc.dim(`Lists: ${f.lists.map((l) => (l.stage ? `${l.list} (${l.stage})` : l.list)).join(", ")}`));
    if (f.notes[0] && v.verdict === "prior_contact") lines.push(pc.dim(`Note: ${f.notes[0].slice(0, 120)}${f.notes[0].length > 120 ? "…" : ""}`));
    if (f.links.length) lines.push(linksLine(f.links));
  }

  if (v.citations.length) lines.push(pc.dim(`Records: ${v.citations.join(", ")}`));
  return lines.join("\n");
}

export function toJson(v: Verdict, target: string): string {
  return JSON.stringify({ target, ...v }, null, 2);
}

/** Human rendering for a sweep: single-CRM unchanged; multi-CRM gets one
 *  labeled block per source, primary first. */
export function renderSweep(res: SweepResult): string {
  const tail = res.elapsedMs != null ? "\n" + pc.dim(`${(res.elapsedMs / 1000).toFixed(1)}s`) : "";
  if (res.sources.length === 1) return renderVerdict(res.combined) + tail;
  return (
    res.sources
      .map(({ crm, ...v }) => pc.bold(pc.underline(CRM_LABELS[crm])) + "\n" + renderVerdict(v))
      .join("\n\n") + tail
  );
}

/** JSON for a sweep: single-CRM keeps the documented flat shape; multi-CRM
 *  adds a `sources` array of per-CRM verdicts under the combined top level. */
export function sweepToJson(res: SweepResult, target: string): string {
  if (res.sources.length === 1) return toJson(res.combined, target);
  return JSON.stringify({ target, ...res.combined, sources: res.sources }, null, 2);
}
