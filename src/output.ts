// Render a verdict for humans / machines, and map it to an exit code so that
// watch/Slack/scripts can branch on the result (SPEC §11).

import pc from "picocolors";
import type { Verdict } from "./connectors/types.js";

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
