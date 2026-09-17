// Slack Block Kit renderers, shared by the watch DM and the /valentine slash
// command. One block set per swept target: a verdict headline, the one-line
// brief, a field grid of the facts, and link buttons that open the CRM record,
// the company site, or a LinkedIn search. Every message also carries a plain
// `text` fallback for notifications and clients without Block Kit.

import type { Verdict, RecordLink } from "./connectors/types.js";
import { CRM_LABELS, type SweepResult } from "./sweep.js";

type Block = Record<string, unknown>;

const MARK: Record<Verdict["verdict"], string> = {
  prior_contact: ":warning:",
  clean: ":white_check_mark:",
  ambiguous: ":grey_question:",
};
const LABEL: Record<Verdict["verdict"], string> = {
  prior_contact: "Prior contact",
  clean: "No prior contact",
  ambiguous: "Needs a look",
};

const mrkdwn = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

/** Escape the three characters Slack's mrkdwn treats specially. */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buttons(links: RecordLink[], idPrefix: string): Block | undefined {
  const els = links.slice(0, 5).map((l, i) => ({
    type: "button",
    text: { type: "plain_text", text: l.label, emoji: true },
    url: l.url,
    action_id: `${idPrefix}_${i}`,
  }));
  return els.length ? { type: "actions", elements: els } : undefined;
}

function fields(v: Verdict): Block | undefined {
  const f = v.facts;
  const items: string[] = [];
  if (v.owner) items.push(`*Owner*\n${esc(v.owner)}`);
  if (v.lastTouch) items.push(`*Last touch*\n${esc(v.lastTouch)}`);
  if (v.status) items.push(`*Stage / outcome*\n${esc(v.status)}`);
  if (f?.connectionStrength) items.push(`*Connection*\n${esc(f.connectionStrength)}`);
  if (f?.firstInteraction) items.push(`*First contact*\n${esc(f.firstInteraction)}`);
  if (f?.people.length) {
    const shown = f.people.slice(0, 3).map(esc).join(", ");
    const more = f.people.length > 3 ? ` +${f.people.length - 3}` : "";
    items.push(`*Known contacts*\n${shown}${more}`);
  }
  if (!items.length) return undefined;
  return { type: "section", fields: items.slice(0, 10).map((t) => ({ type: "mrkdwn", text: t })) };
}

/** Blocks for one CRM's verdict on one target. */
export function verdictBlocks(target: string, v: Verdict, crmLabel: string | undefined, idPrefix: string): Block[] {
  const name = v.facts?.matchName && v.facts.matchName.toLowerCase() !== target.toLowerCase() ? ` — ${esc(v.facts.matchName)}` : "";
  const where = crmLabel ? ` · ${crmLabel}` : "";
  const out: Block[] = [mrkdwn(`${MARK[v.verdict]} *${esc(target)}*${name}  ·  ${LABEL[v.verdict]}${where}`)];
  if (v.verdict !== "clean" || !v.facts) out.push(mrkdwn(esc(v.summary)));
  const f = fields(v);
  if (f) out.push(f);
  const note = v.facts?.notes[0];
  if (note && v.verdict === "prior_contact") out.push(context(`:memo: ${esc(note.slice(0, 150))}${note.length > 150 ? "…" : ""}`));
  const b = v.facts?.links ? buttons(v.facts.links, idPrefix) : undefined;
  if (b) out.push(b);
  return out;
}

/** Blocks for a whole sweep of one target: sources that found something get
 *  their own block set; sources that came back clean collapse into one line. */
export function sweepBlocks(target: string, res: SweepResult, idPrefix: string): Block[] {
  if (res.sources.length === 1) return verdictBlocks(target, res.combined, undefined, idPrefix);
  const out: Block[] = [];
  const clean: string[] = [];
  res.sources.forEach(({ crm, ...v }, i) => {
    if (v.verdict === "clean") clean.push(CRM_LABELS[crm]);
    else out.push(...verdictBlocks(target, v, CRM_LABELS[crm], `${idPrefix}_${i}`));
  });
  if (clean.length) {
    const line = `${MARK.clean} *${esc(target)}*  ·  nothing in ${clean.join(" or ")}`;
    out.length ? out.push(context(line)) : out.push(mrkdwn(line));
  }
  return out;
}

export interface MeetingItem {
  target: string;
  res?: SweepResult;
  /** When the sweep itself threw. */
  error?: string;
}

/** The watch DM: one message per meeting, all its external attendees inside. */
export function meetingMessage(
  title: string,
  minutes: number,
  items: MeetingItem[],
  meta: { crms: string; model?: string; elapsedMs?: number },
): { text: string; blocks: Block[] } {
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: `✦ ${title}`.slice(0, 150), emoji: true } },
    context(`:clock3: in *${minutes} min*  ·  swept ${esc(meta.crms)}`),
  ];
  const lines: string[] = [`✦ ${title} in ${minutes} min`];
  items.forEach((it, i) => {
    blocks.push({ type: "divider" });
    if (it.res) {
      blocks.push(...sweepBlocks(it.target, it.res, `v${i}`));
      const v = it.res.combined;
      lines.push(`${v.verdict === "prior_contact" ? "⚠" : v.verdict === "clean" ? "✅" : "❓"} ${it.target} — ${v.summary}`);
    } else {
      blocks.push(mrkdwn(`${MARK.ambiguous} *${esc(it.target)}*  ·  sweep failed: ${esc(it.error ?? "unknown error")}`));
      lines.push(`❓ ${it.target} — sweep failed: ${it.error ?? "unknown error"}`);
    }
  });
  const tail: string[] = ["read-only"];
  if (meta.model) tail.push(esc(meta.model.split("/").pop() ?? meta.model));
  if (meta.elapsedMs != null) tail.push(`${(meta.elapsedMs / 1000).toFixed(1)}s`);
  blocks.push(context(tail.join("  ·  ")));
  return { text: lines.join("\n"), blocks: blocks.slice(0, 50) };
}

/** The slash-command reply for one target. */
export function slashMessage(target: string, res: SweepResult, meta: { crms: string; elapsedMs?: number }): { text: string; blocks: Block[] } {
  const v = res.combined;
  const blocks = [
    ...sweepBlocks(target, res, "s"),
    context(`swept ${esc(meta.crms)}${meta.elapsedMs != null ? ` in ${(meta.elapsedMs / 1000).toFixed(1)}s` : ""}  ·  read-only`),
  ];
  return { text: `${MARK[v.verdict]} ${target} — ${v.summary}`, blocks: blocks.slice(0, 50) };
}
