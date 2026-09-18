// Slack Block Kit renderers, shared by the watch DM and the /valentine slash
// command. One card per swept target, whatever the CRMs said:
//
//   headline   verdict + every entity linked + state pills (stale · stage · owner gap · name mismatch)
//   summary    the one-line brief, with the names/dates in it linked to their records
//   fields     the facts, paired across CRMs when both know the company
//   says       "Valentine says" — one grounded next step
//   actions    one row per CRM: open the record / tabs, prefilled forms
//              (Log call · New task · + Lead · + Account) or "nothing in X"
//   other      website, LinkedIn
//   footer     what was swept, timing, model
//
// Everything here is a link. Valentine stays read-only: the "act" buttons open
// prefilled new-record forms in the CRM's own web app, and nothing is saved
// until a human presses Save there. Interactive (write-through) buttons would
// need a Slack interactivity endpoint and CRM write scopes — parked in
// backlog.md as a deliberate non-goal.
//
// Slack limits enforced: ≤50 blocks, ≤10 fields per section, ≤5 buttons per
// row (25 is the hard cap; 5 keeps one line), button text ≤75, section text
// ≤3000, header ≤150. Every message also carries a plain `text` fallback.

import type { Verdict, RecordLink, BriefFacts } from "./connectors/types.js";
import { CRM_LABELS, type SweepResult, type SourceVerdict } from "./sweep.js";

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
const LIMITS = { blocks: 50, fields: 10, buttons: 5, buttonText: 75, sectionText: 3000, header: 150, fieldText: 2000 } as const;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mrkdwn = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text: clip(text, LIMITS.sectionText) } });
const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text: clip(text, LIMITS.sectionText) }] });
const divider = (): Block => ({ type: "divider" });

/** Escape the three characters Slack's mrkdwn treats specially. */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `<url|text>`, or plain text when there is no URL. URLs with `|` or `>` would
 *  break the link syntax, so they fall back to text too. */
const link = (text: string, url?: string): string => (url && !/[|>]/.test(url) ? `<${url}|${esc(text)}>` : esc(text));
const pill = (text: string): string => ` \`${text}\``;

// ---------------------------------------------------------------- helpers

class Ids {
  private used = new Set<string>();
  constructor(private prefix: string) {}
  next(base: string): string {
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "b";
    let id = `${this.prefix}_${slug}`;
    for (let i = 2; this.used.has(id); i++) id = `${this.prefix}_${slug}_${i}`;
    this.used.add(id);
    return id.slice(0, 255);
  }
}

function buttonRow(links: RecordLink[], ids: Ids): Block | undefined {
  const seen = new Set<string>();
  const els = links
    .filter((l) => l.url && !seen.has(l.url) && seen.add(l.url))
    .slice(0, LIMITS.buttons)
    .map((l) => ({
      type: "button",
      text: { type: "plain_text", text: clip(l.label, LIMITS.buttonText), emoji: true },
      url: l.url,
      action_id: ids.next(l.label),
    }));
  return els.length ? { type: "actions", elements: els } : undefined;
}

function fieldsBlock(items: { label: string; value: string }[]): Block | undefined {
  const fields = items
    .filter((f) => f.value)
    .slice(0, LIMITS.fields)
    .map((f) => ({ type: "mrkdwn", text: clip(`*${esc(f.label)}*\n${f.value}`, LIMITS.fieldText) }));
  return fields.length ? { type: "section", fields } : undefined;
}

/** Replace `needle` (already-escaped text) with a link, only outside existing
 *  `<…>` links, first occurrence only. */
function linkOnce(text: string, needle: string, url?: string): string {
  if (!needle || !url || /[|>]/.test(url)) return text;
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i === -1) return text;
    const open = text.lastIndexOf("<", i);
    const close = text.lastIndexOf(">", i);
    if (open > close) {
      from = i + needle.length; // inside a link already
      continue;
    }
    return `${text.slice(0, i)}<${url}|${needle}>${text.slice(i + needle.length)}`;
  }
}

/** The model's sentence with every entity the facts know linked to its record. */
export function linkify(summary: string, v: Verdict): string {
  const f = v.facts;
  let t = esc(summary);
  if (!f) return t;
  const pairs: [string | undefined, string | undefined][] = [
    [f.matchName, f.matchUrl],
    [f.parent?.label, f.parent?.url],
    [v.owner, f.ownerUrl],
    ...(f.peopleLinks ?? []).map((p): [string, string] => [p.label, p.url]),
    ...f.lists.map((l): [string, string | undefined] => [l.list.replace(/^Opportunity: /, ""), l.url]),
    [v.lastTouch?.slice(0, 10), f.lastTouchUrl],
    [f.lastMeeting, f.views?.activity],
    [f.lastEmail, f.views?.emails],
    [f.firstInteraction, f.views?.activity],
    ...(f.activities ?? []).map((a): [string | undefined, string | undefined] => [a.date, a.url]),
  ];
  // Longest names first so "Hines Atlanta" wins over "Hines".
  pairs.sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0));
  const done = new Set<string>();
  for (const [name, url] of pairs) {
    if (!name || !url || done.has(name)) continue;
    done.add(name);
    t = linkOnce(t, esc(name), url);
  }
  return t;
}

const norm = (s?: string): string => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|ltd|corp|co|the)\b/g, "").trim();
const short = (crm: SourceVerdict["crm"]): string => (crm === "salesforce" ? "SF" : CRM_LABELS[crm]);
const recordNoun = (f?: BriefFacts): string => (f?.matchObject === "people" ? "contact" : "company");
const activeDeal = (f?: BriefFacts): boolean => !!f?.opportunity && f.opportunity.open !== false;
const ownerGap = (s: SourceVerdict): boolean => s.verdict === "prior_contact" && (!s.owner || s.facts?.ownerActive === false);

export interface CardOptions {
  /** Meeting heads-up: one domain-named action row (record per CRM + Log meeting) instead of a row per CRM. */
  meeting?: { title: string };
}

/** Blocks for one target, across every source in the sweep. Returns the
 *  "Valentine says" lines separately so a multi-target message can fold them
 *  into one block. */
export function targetBlocks(target: string, res: SweepResult, idPrefix: string, opts: CardOptions = {}): { blocks: Block[]; says: string[] } {
  const ids = new Ids(idPrefix);
  const found = res.sources.filter((s) => s.verdict === "prior_contact" && s.facts);
  const clean = res.sources.filter((s) => s.verdict === "clean");
  const unreachable = res.sources.filter((s) => s.unreachable);
  const ambiguous = res.sources.filter((s) => s.verdict === "ambiguous" && !s.unreachable);
  const crmList = (list: SourceVerdict[]) => list.map((s) => CRM_LABELS[s.crm]).join(" + ");
  const blocks: Block[] = [];

  // ---- headline
  const primary = found[0] ?? ambiguous[0] ?? res.sources[0];
  const pf = primary?.facts;
  const domain = pf?.domain ?? (found[0]?.facts?.domain ?? target);
  const deal = found.find((s) => activeDeal(s.facts));
  let head: string;
  if (found.length) {
    const site = pf?.parent ? pf.parent.url : pf?.matchObject === "companies" ? pf?.matchUrl : `https://${domain}`;
    head = `${deal ? ":fire:" : MARK.prior_contact} ${link(domain, site)}`;
    const names = found.map((s) => link(s.facts!.matchName ?? CRM_LABELS[s.crm], s.facts!.matchUrl)).filter((n, i, a) => a.indexOf(n) === i);
    if (pf?.matchName && norm(pf.matchName) !== norm(domain)) head += ` – ${names.join(" / ")}`;
    head += `  ·  ${deal ? "Active deal" : LABEL.prior_contact}`;
    if (deal) head += pill(deal.facts!.opportunity!.stage ?? "open");
    else if (pf?.stale) head += pill(`${pf.stale} stale`);
    if (found.length > 1) head += pill("both CRMs");
    for (const s of found) if (ownerGap(s)) head += pill(`${found.length > 1 ? `${short(s.crm)} ` : ""}owner ${s.owner ? "unassigned" : "unset"}`);
    if (found.length > 1 && norm(found[0].facts!.matchName) !== norm(found[1].facts!.matchName)) head += pill("names differ across CRMs");
    for (const s of unreachable) head += pill(`${CRM_LABELS[s.crm]} unreachable`);
    head += ` · ${crmList(found)}`;
  } else if (ambiguous.length) {
    head = `${MARK.ambiguous} ${link(domain, `https://${domain}`)}  ·  ${LABEL.ambiguous}${pill(`${ambiguous[0].facts?.matches ?? "several"} matches`)} · ${crmList(ambiguous)}`;
  } else {
    head = `${unreachable.length ? MARK.ambiguous : MARK.clean} ${link(domain, /\./.test(domain) ? `https://${domain}` : undefined)}  ·  ${LABEL.clean}`;
    head += unreachable.length ? unreachable.map((s) => pill(`${CRM_LABELS[s.crm]} unreachable`)).join("") : pill("clear to reach out");
    head += ` · ${crmList(res.sources)}`;
  }
  blocks.push(mrkdwn(head));

  // ---- summary: one linked sentence per source that found something
  for (const s of found) blocks.push(mrkdwn(`${found.length > 1 ? `*${CRM_LABELS[s.crm]}:* ` : ""}${linkify(s.summary, s)}`));
  for (const s of ambiguous) blocks.push(mrkdwn(`${found.length ? `*${CRM_LABELS[s.crm]}:* ` : ""}${esc(s.summary)}`));
  if (!found.length && !ambiguous.length) {
    const what = res.sources.map((s) => (s.unreachable ? `${CRM_LABELS[s.crm]} could not be read` : `nothing in ${CRM_LABELS[s.crm]}`)).join(", ");
    blocks.push(mrkdwn(`No company, contact or list entry matches ${esc(domain)} — ${what}.`));
  }
  for (const s of unreachable) blocks.push(context(`${MARK.ambiguous} ${esc(s.summary)}`));

  // ---- fields
  const fb = found.length > 1 ? pairedFields(found) : found.length ? singleFields(found[0]) : cleanFields(res.sources, domain);
  const fblock = fieldsBlock(fb);
  if (fblock) blocks.push(fblock);

  // ---- action rows
  if (opts.meeting) {
    const row: RecordLink[] = [];
    for (const s of found) {
      const f = s.facts!;
      if (f.matchUrl) row.push({ label: `${short(s.crm)} ${recordNoun(f)}`, url: f.matchUrl });
    }
    for (const s of found) {
      const log = s.facts!.actions?.find((a) => /meeting/i.test(a.label));
      if (log) row.push(log);
    }
    const b = buttonRow(row, ids);
    if (b) blocks.push(context(`*${esc(domain.toUpperCase())}*`), b);
  } else {
    for (const s of res.sources) blocks.push(...crmRow(s, found, ids));
    const other = otherLinks(found[0] ?? clean[0]);
    const b = buttonRow(other, ids);
    if (b) blocks.push(context("*OTHER*"), b);
  }

  const says = [...new Set(found.map((s) => s.nextStep).filter((x): x is string => !!x))];
  if (!found.length && !says.length && res.combined.nextStep) says.push(res.combined.nextStep);
  return { blocks, says };
}

function singleFields(s: SourceVerdict): { label: string; value: string }[] {
  const f = s.facts!;
  const out: { label: string; value: string }[] = [];
  const matchLabel = f.matchObject === "people" ? "Contact" : "Company";
  if (f.matchName) out.push({ label: matchLabel, value: link(f.matchName, f.matchUrl) + (f.matches > 1 ? pill(`1 of ${f.matches} matches`) : "") });
  if (f.parent) out.push({ label: "Account", value: link(f.parent.label, f.parent.url) });
  out.push({ label: "Owner", value: s.owner ? link(s.owner, f.ownerUrl) + (f.ownerActive === false ? pill("claim it") : "") : `unset${pill("claim it")}` });
  if (s.lastTouch) {
    const [date, kind] = [s.lastTouch.slice(0, 10), s.lastTouch.match(/\((\w+)\)/)?.[1]];
    out.push({ label: "Last touch", value: `${link(date, f.lastTouchUrl)}${kind ? ` · ${esc(kind)}` : ""}${f.stale ? pill(f.stale) : ""}` });
  }
  if (f.opportunity) out.push({ label: "Opportunity", value: link(f.opportunity.list.replace(/^Opportunity: /, ""), f.opportunity.url) + (f.opportunity.stage ? pill(f.opportunity.stage) : "") });
  const other = f.lists.filter((l) => l !== f.opportunity).slice(0, 2);
  if (other.length) out.push({ label: other[0].kind === "campaign" ? "Campaign" : "List", value: other.map((l) => link(l.list, l.url)).join(" · ") });
  if (s.status && !f.opportunity?.stage) out.push({ label: "Stage / outcome", value: other[0]?.memberUrl ? link(s.status, other[0].memberUrl) : esc(s.status) });
  if (f.connectionStrength) out.push({ label: "Connection", value: esc(f.connectionStrength) });
  if (f.firstInteraction) out.push({ label: "First contact", value: link(f.firstInteraction, f.views?.activity) });
  const people = peopleValue(f);
  if (people) out.push({ label: "Known people", value: people });
  return out;
}

function pairedFields(found: SourceVerdict[]): { label: string; value: string }[] {
  const [a, b] = found;
  const tag = (s: SourceVerdict) => short(s.crm);
  const out: { label: string; value: string }[] = [];
  const rec = (s: SourceVerdict) => link(s.facts!.matchName ?? CRM_LABELS[s.crm], s.facts!.matchUrl);
  out.push({ label: `Record (${tag(a)} / ${tag(b)})`, value: `${rec(a)} / ${rec(b)}` });
  const owner = (s: SourceVerdict) => (s.owner ? link(s.owner, s.facts!.ownerUrl) + (s.facts!.ownerActive === false ? pill("claim") : "") : `unset${pill("claim")}`);
  out.push({ label: `Owner (${tag(a)} / ${tag(b)})`, value: `${owner(a)} / ${owner(b)}` });
  const touch = (s: SourceVerdict) => (s.lastTouch ? link(s.lastTouch.slice(0, 10), s.facts!.lastTouchUrl) + (s.facts!.stale ? pill(s.facts!.stale) : "") : "—");
  out.push({ label: `Last touch (${tag(a)} / ${tag(b)})`, value: `${touch(a)} / ${touch(b)}` });
  for (const s of found) {
    const f = s.facts!;
    if (f.opportunity) out.push({ label: `Opportunity (${tag(s)})`, value: link(f.opportunity.list.replace(/^Opportunity: /, ""), f.opportunity.url) + (f.opportunity.stage ? pill(f.opportunity.stage) : "") });
  }
  for (const s of found) {
    const people = peopleValue(s.facts!);
    if (people) out.push({ label: `${tag(s)} ${s.facts!.matchObject === "people" ? "contact" : "people"}`, value: people });
  }
  for (const s of found) if (s.facts!.connectionStrength) out.push({ label: `Connection (${tag(s)})`, value: esc(s.facts!.connectionStrength!) });
  return out;
}

function cleanFields(sources: SourceVerdict[], domain: string): { label: string; value: string }[] {
  const out = sources.map((s) => ({
    label: CRM_LABELS[s.crm],
    value: s.unreachable ? "could not be read" : `${s.facts?.matches ?? 0} matching records`,
  }));
  if (/\./.test(domain)) out.push({ label: "Domain", value: link(domain, `https://${domain}`) });
  return out;
}

function peopleValue(f: BriefFacts): string | undefined {
  const linked = f.peopleLinks?.length ? f.peopleLinks.map((p) => link(p.label, p.url)) : f.people.map(esc);
  if (!linked.length) return undefined;
  const shown = linked.slice(0, 3).join(" · ");
  return f.people.length > 3 ? `${shown} +${f.people.length - 3}` : shown;
}

/** One CRM's row: its label (+ state pill), its buttons, and for a CRM that
 *  has nothing, what a create form will be prefilled with. */
function crmRow(s: SourceVerdict, found: SourceVerdict[], ids: Ids): Block[] {
  const name = CRM_LABELS[s.crm];
  const f = s.facts;
  if (s.unreachable) return [context(`*${name.toUpperCase()}*${pill("unreachable")}`)];
  if (s.verdict === "prior_contact" && f) {
    const links: RecordLink[] = [];
    if (f.matchUrl) links.push({ label: `Open ${recordNoun(f)}`, url: f.matchUrl });
    if (f.parent) links.push({ label: "Account", url: f.parent.url });
    if (f.views?.activity) links.push({ label: "Activity", url: f.views.activity });
    if (f.views?.emails) links.push({ label: "Emails", url: f.views.emails });
    for (const a of f.actions ?? []) if (!/meeting/i.test(a.label)) links.push(a);
    const row = buttonRow(links, ids);
    return row ? [context(`*${name.toUpperCase()}*`), row] : [];
  }
  // clean / ambiguous-but-readable
  const out: Block[] = [];
  const state = s.verdict === "clean" ? `nothing in ${name}` : `${f?.matches ?? "several"} matches — needs a look`;
  out.push(context(`*${name.toUpperCase()}*${pill(state)}`));
  const links: RecordLink[] = [...(f?.actions ?? [])];
  if (f?.searchUrl) links.push({ label: s.crm === "attio" ? "Companies in Attio" : `Search ${name}`, url: f.searchUrl });
  const row = buttonRow(links, ids);
  if (row) out.push(row);
  const seed = found[0];
  if (f?.actions?.length && seed?.facts) {
    const sf = seed.facts;
    const bits = [sf.matchName && `${esc(sf.matchObject === "people" ? "contact" : "name")} \`${esc(sf.matchName)}\``, sf.domain && `website \`${esc(sf.domain)}\``, sf.matchUrl && `note \`${CRM_LABELS[seed.crm]} record link\``].filter(Boolean);
    if (bits.length) out.push(context(`prefills from ${CRM_LABELS[seed.crm]} → ${bits.join(" · ")} — nothing is saved until you press Save`));
  }
  return out;
}

function otherLinks(s?: SourceVerdict): RecordLink[] {
  const f = s?.facts;
  if (!f) return [];
  const out: RecordLink[] = [];
  const site = f.links.find((l) => l.label === "Website");
  if (site) out.push(site);
  if (f.matchObject === "people" && f.matchName)
    out.push({ label: `LinkedIn · ${f.matchName.split(" ")[0]}`, url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${f.matchName} ${f.parent?.label ?? f.domain ?? ""}`.trim())}` });
  const li = f.links.find((l) => l.label === "LinkedIn");
  if (li) out.push({ label: "LinkedIn · company", url: li.url });
  return out;
}

const saysBlock = (says: string[], labelled?: string[]): Block | undefined => {
  if (!says.length) return undefined;
  const lines = says.map((s, i) => (labelled?.[i] ? `*${esc(labelled[i])}* — ${esc(s)}` : esc(s)));
  return mrkdwn(`> *Valentine says*\n> ${lines.join("\n> ")}`);
};

export interface FooterMeta {
  crms: string;
  model?: string;
  elapsedMs?: number;
  /** A link back to the run (Valentine Lab). */
  runUrl?: string;
  runId?: string;
}

function footer(res: SweepResult | undefined, meta: FooterMeta, lead = "swept"): Block {
  const swept = res
    ? res.sources.map((s) => link(CRM_LABELS[s.crm], s.facts?.matchUrl ?? s.facts?.searchUrl)).join(" + ")
    : esc(meta.crms);
  const bits = [`${lead} ${swept}${meta.elapsedMs != null ? ` in ${(meta.elapsedMs / 1000).toFixed(1)}s` : ""}`, "read-only"];
  if (meta.model) bits.push(esc(meta.model.split("/").pop() ?? meta.model));
  if (meta.runId) bits.push(`run ${link(meta.runId, meta.runUrl)}`);
  return context(bits.join("  ·  "));
}

/** Keep the header/footer, drop from the middle when a message would exceed 50 blocks. */
function cap(blocks: Block[]): Block[] {
  if (blocks.length <= LIMITS.blocks) return blocks;
  const tail = blocks.slice(-2);
  return [...blocks.slice(0, LIMITS.blocks - 3), context("… more not shown (Slack's 50-block cap)"), ...tail];
}

// ---------------------------------------------------------------- back-compat surfaces

/** Blocks for one CRM's verdict on one target. */
export function verdictBlocks(target: string, v: Verdict, crmLabel: string | undefined, idPrefix: string): Block[] {
  const crm = (Object.keys(CRM_LABELS) as SourceVerdict["crm"][]).find((k) => CRM_LABELS[k] === crmLabel) ?? "attio";
  const res: SweepResult = { combined: v, sources: [{ crm, ...v }] };
  const { blocks, says } = targetBlocks(target, res, idPrefix);
  const s = saysBlock(says);
  return s ? [...blocks, s] : blocks;
}

/** Blocks for a whole sweep of one target. */
export function sweepBlocks(target: string, res: SweepResult, idPrefix: string): Block[] {
  const { blocks, says } = targetBlocks(target, res, idPrefix);
  const s = saysBlock(says);
  return s ? [...blocks, s] : blocks;
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
  meta: FooterMeta,
): { text: string; blocks: Block[] } {
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: clip(`📅 ${title}`, LIMITS.header), emoji: true } },
    context(`:clock3: in *${minutes} min*  ·  ${items.length} external ${items.length === 1 ? "domain" : "domains"}  ·  swept ${esc(meta.crms)}`),
  ];
  const lines: string[] = [`✦ ${title} in ${minutes} min`];
  const says: string[] = [];
  const saysFor: string[] = [];
  items.forEach((it, i) => {
    blocks.push(divider());
    if (it.res) {
      const card = targetBlocks(it.target, it.res, `v${i}`, { meeting: { title } });
      blocks.push(...card.blocks);
      if (card.says[0]) {
        says.push(card.says[0]);
        saysFor.push(it.target);
      }
      const v = it.res.combined;
      lines.push(`${v.verdict === "prior_contact" ? "⚠" : v.verdict === "clean" ? "✅" : "❓"} ${it.target} — ${v.summary}`);
    } else {
      blocks.push(mrkdwn(`${MARK.ambiguous} *${esc(it.target)}*  ·  sweep failed: ${esc(it.error ?? "unknown error")}`));
      lines.push(`❓ ${it.target} — sweep failed: ${it.error ?? "unknown error"}`);
    }
  });
  const s = saysBlock(says, items.length > 1 ? saysFor : undefined);
  if (s) blocks.push(s);
  blocks.push(footer(undefined, meta, "heads-up  ·  swept"));
  return { text: lines.join("\n"), blocks: cap(blocks) };
}

/** The slash-command reply (and the `--notify` DM) for one target. */
export function slashMessage(target: string, res: SweepResult, meta: FooterMeta): { text: string; blocks: Block[] } {
  const v = res.combined;
  const { blocks, says } = targetBlocks(target, res, "s");
  const s = saysBlock(says);
  if (s) blocks.push(s);
  blocks.push(footer(res, { ...meta, elapsedMs: meta.elapsedMs ?? res.elapsedMs }));
  return { text: `${MARK[v.verdict]} ${target} — ${v.summary}`, blocks: cap(blocks) };
}
