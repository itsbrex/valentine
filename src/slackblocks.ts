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
// By default everything here is a link. Valentine stays read-only: the "act"
// buttons open prefilled new-record forms in the CRM's own web app, and
// nothing is saved until a human presses Save there.
//
// With `interactive` set (the `valentine slack` endpoint answers the card)
// the card also carries an overflow menu (re-run · copy ids · mute · handled —
// local state, never the CRM) and, when writes are switched on
// (`writes: true` / VALENTINE_WRITES=1), the write-through buttons from the
// design: Create in Attio · Claim owner · Link IDs · Fix Attio match · Log to
// both CRMs. Each write button carries its payload in `value` and a confirm
// dialog that spells out what gets written; the handler is src/slackactions.ts.
//
// Slack limits enforced: ≤50 blocks, ≤10 fields per section, ≤5 buttons per
// row (25 is the hard cap; 5 keeps one line), button text ≤75, section text
// ≤3000, header ≤150. Every message also carries a plain `text` fallback.

import type { Verdict, RecordLink, BriefFacts, ListMembership, Activity } from "./connectors/types.js";
import { CRM_LABELS, type SweepResult, type SourceVerdict } from "./sweep.js";
import { money } from "./brief.js";

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
const LIMITS = { blocks: 50, fields: 10, buttons: 5, buttonText: 75, sectionText: 3000, header: 150, fieldText: 2000, value: 2000, optionValue: 75 } as const;

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

/** A write-through button: no URL, a payload for the interactivity endpoint,
 *  and a confirm dialog naming what gets written. */
export interface ActionButton {
  label: string;
  action: CardAction;
  primary?: boolean;
  confirm?: { title: string; text: string; ok?: string };
}
type Btn = RecordLink | ActionButton;
const isAction = (b: Btn): b is ActionButton => "action" in b;

function buttonRow(links: Btn[], ids: Ids): Block | undefined {
  return buttonRows(links, ids, 1)[0];
}

/** Buttons in rows of ≤5. `maxRows` 1 keeps the read-only rows one line (extra
 *  links are dropped, as before); interactive rows may spill to a second. */
function buttonRows(links: Btn[], ids: Ids, maxRows = 2): Block[] {
  const seen = new Set<string>();
  const els = links
    .filter((l) => {
      const key = isAction(l) ? `act:${l.label}` : l.url;
      return !!key && !seen.has(key) && seen.add(key);
    })
    .slice(0, LIMITS.buttons * maxRows)
    .map((l) => {
      const base = { type: "button", text: { type: "plain_text", text: clip(l.label, LIMITS.buttonText), emoji: true }, action_id: ids.next(l.label) };
      if (!isAction(l)) return { ...base, url: l.url };
      return {
        ...base,
        value: JSON.stringify(l.action).slice(0, LIMITS.value),
        ...(l.primary ? { style: "primary" } : {}),
        ...(l.confirm
          ? {
              confirm: {
                title: { type: "plain_text", text: clip(l.confirm.title, 100) },
                text: { type: "mrkdwn", text: clip(l.confirm.text, 300) },
                confirm: { type: "plain_text", text: l.confirm.ok ?? "Do it" },
                deny: { type: "plain_text", text: "Cancel" },
              },
            }
          : {}),
      };
    });
  const rows: Block[] = [];
  for (let i = 0; i < els.length; i += LIMITS.buttons) rows.push({ type: "actions", elements: els.slice(i, i + LIMITS.buttons) });
  return rows;
}

/** The ··· menu. Option values are capped at 75 chars by Slack, so they are
 *  `op|arg`, not JSON. Nothing here touches the CRM. */
function overflow(items: { label: string; value: string }[], ids: Ids): Block {
  return {
    type: "overflow",
    action_id: ids.next("more"),
    options: items.slice(0, 5).map((o) => ({ text: { type: "plain_text", text: clip(o.label, LIMITS.buttonText) }, value: o.value.slice(0, LIMITS.optionValue) })),
  };
}

// ---------------------------------------------------------------- card actions

/** What a write-through button asks the endpoint to do. Carried verbatim in
 *  the button's `value`; validated again by the handler before any write. */
export type CardAction =
  | { op: "attio_create"; domain?: string; name?: string; person?: string; email?: string; from?: { crm: string; id: string; url?: string } }
  | { op: "sf_create_lead"; domain?: string; name?: string; person?: string; email?: string; from?: { crm: string; id: string; url?: string } }
  | { op: "create_both"; domain?: string; name?: string; person?: string; email?: string }
  | { op: "claim"; crm: "salesforce" | "attio"; object: "companies" | "people"; id: string }
  | { op: "crosslink"; sf: { object: "companies" | "people"; id: string; url?: string }; attio: { object: "companies" | "people"; id: string; url?: string } }
  | { op: "attio_rematch"; domain: string; id: string; name: string; note?: string }
  | { op: "log_meeting"; title: string; start?: number; targets: { crm: "salesforce" | "attio"; object: "companies" | "people"; id: string }[] }
  /** Opens a modal rather than writing directly — the text comes from the
   *  human, so there is nothing to confirm up front. Lands on every CRM that
   *  knows the target, the same rule as `/valentine note`. */
  | { op: "add_note"; target: string; name?: string };

/** The ··· menu ops (`op|arg`). All read-only. */
export type MenuOp = "rerun" | "copy" | "mute" | "handled" | "brief";
export const menuValue = (op: MenuOp, ...args: string[]): string => [op, ...args].join("|");

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
  meeting?: { title: string; start?: number };
  /** Set when `valentine slack` will answer the card's interactive elements.
   *  `writes` adds the write-through buttons on top of the local-only menu. */
  interactive?: { writes: boolean };
  /** Lab replay link for this sweep, carried into "Prep brief" so the shared
   *  copy can point back at the run it came from. */
  runUrl?: string;
}

/** The record ids a write needs, from a source verdict. */
const recordOf = (s: SourceVerdict): { object: "companies" | "people"; id: string; url?: string } | undefined =>
  s.citations[0] ? { object: s.facts?.matchObject ?? "companies", id: s.citations[0], url: s.facts?.matchUrl } : undefined;

/** Two records already point at each other when one's notes / description
 *  carry the other's id or link. Best-effort: notes are trimmed to three. */
function crosslinked(a: SourceVerdict, b: SourceVerdict): boolean {
  const has = (s: SourceVerdict, other: SourceVerdict) => {
    const needles = [other.citations[0], other.facts?.matchUrl].filter((x): x is string => !!x);
    return (s.facts?.notes ?? []).some((n) => needles.some((x) => n.includes(x)));
  };
  return has(a, b) || has(b, a);
}

/** Does the matched name plausibly belong to the domain? "Ware Malcomb" for
 *  waremalcomb.com yes; "Language Services Associates" no. */
function nameFitsDomain(name: string | undefined, domain: string): boolean {
  if (!name || !/\./.test(domain)) return true;
  const label = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
  const n = norm(name).replace(/\s+/g, "");
  if (!label || !n) return true;
  const [a, b] = n.length < label.length ? [n, label] : [label, n];
  return a.length >= 4 ? b.startsWith(a) || b.includes(a) : b.startsWith(a);
}

/** Seed for "Create in Attio / Lead in SF" from the CRM that knows the company. */
function seedFrom(s: SourceVerdict | undefined, domain: string): { domain?: string; name?: string; person?: string; from?: { crm: string; id: string; url?: string } } {
  const f = s?.facts;
  const dom = f?.domain ?? (/\./.test(domain) ? domain : undefined);
  if (!s || !f) return { domain: dom, name: /\./.test(domain) ? undefined : domain };
  return {
    domain: dom,
    name: f.matchObject === "companies" ? f.matchName : f.parent?.label,
    person: f.matchObject === "people" ? f.matchName : f.people[0],
    ...(s.citations[0] ? { from: { crm: CRM_LABELS[s.crm], id: s.citations[0], url: f.matchUrl } } : {}),
  };
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
    const tie = ambiguous[0].facts?.matchedBy;
    const why = tie ? `${tie} match only` : `${ambiguous[0].facts?.matches ?? "several"} matches`;
    head = `${MARK.ambiguous} ${link(domain, `https://${domain}`)}  ·  ${LABEL.ambiguous}${pill(why)} · ${crmList(ambiguous)}`;
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
  const ia = opts.interactive;
  const writes = !!ia?.writes;
  if (opts.meeting) {
    const row: Btn[] = [];
    for (const s of found) {
      const f = s.facts!;
      if (f.matchUrl) row.push({ label: `${short(s.crm)} ${recordNoun(f)}`, url: f.matchUrl });
    }
    for (const s of found) {
      const log = s.facts!.actions?.find((a) => /meeting/i.test(a.label));
      if (log) row.push(log);
    }
    if (writes) row.push(...meetingWrites(found, domain, opts.meeting));
    const rows = buttonRows(row, ids, writes ? 2 : 1);
    if (rows.length) blocks.push(context(`*${esc(domain.toUpperCase())}*`), ...rows);
  } else {
    for (const s of res.sources) blocks.push(...crmRow(s, found, ids, domain, writes ? res.sources : undefined));
    const other: Btn[] = otherLinks(found[0] ?? clean[0]);
    if (writes && !found.length && !unreachable.length) {
      const seed = seedFrom(undefined, domain);
      const hasSf = res.sources.some((s) => s.crm === "salesforce");
      const hasAttio = res.sources.some((s) => s.crm === "attio");
      if (hasSf && hasAttio)
        other.unshift({
          label: "Both + cross-link",
          action: { op: "create_both", ...seed },
          confirm: { title: "Create in both CRMs?", text: `Lead *${esc(seed.name ?? domain)}* in Salesforce and company *${esc(seed.name ?? domain)}* in Attio, each noting the other's link.`, ok: "Create both" },
        });
    }
    // One note for the whole card: it lands on every CRM that knows the
    // target, so it belongs next to the shared links rather than on a CRM row.
    if (writes && found.length)
      other.unshift({
        label: "Add note",
        action: { op: "add_note", target, ...(found[0].facts?.matchName ? { name: found[0].facts!.matchName } : {}) },
      });
    if (ia) {
      const sf = res.sources.find((s) => s.crm === "salesforce");
      const at = res.sources.find((s) => s.crm === "attio");
      const menu: { label: string; value: string }[] = [
        { label: "Re-run sweep", value: menuValue("rerun", target) },
        { label: "Prep brief (share here)", value: menuValue("brief", target, opts.runUrl ?? "") },
      ];
      if (sf?.citations[0]) menu.push({ label: "Copy SF ID", value: menuValue("copy", "SF", sf.citations[0]) });
      if (at?.citations[0]) menu.push({ label: "Copy Attio ID", value: menuValue("copy", "Attio", at.citations[0]) });
      if (/\./.test(domain)) menu.push({ label: "Mute domain 30d", value: menuValue("mute", domain) });
      menu.push({ label: "Mark handled", value: menuValue("handled", target) });
      const rows = buttonRows(other, ids, 1);
      const row = rows[0] ?? { type: "actions", elements: [] };
      (row.elements as unknown[]).push(overflow(menu, ids));
      blocks.push(context("*OTHER*"), row);
    } else {
      const b = buttonRow(other, ids);
      if (b) blocks.push(context("*OTHER*"), b);
    }
  }

  const says = [...new Set(found.map((s) => s.nextStep).filter((x): x is string => !!x))];
  if (!found.length && !says.length && res.combined.nextStep) says.push(res.combined.nextStep);
  return { blocks, says };
}

/** The owner cell: linked name, a "claim" nudge when the CRM's owner is a
 *  placeholder, or "unset" when there is none. */
function ownerValue(s: SourceVerdict, nudge: string): string {
  const f = s.facts!;
  if (!s.owner) return `unset${pill(nudge)}`;
  return link(s.owner, f.ownerUrl) + (f.ownerActive === false ? pill(nudge) : "");
}

function singleFields(s: SourceVerdict): { label: string; value: string }[] {
  const f = s.facts!;
  const out: { label: string; value: string }[] = [];
  const matchLabel = f.matchObject === "people" ? "Contact" : "Company";
  if (f.matchName) out.push({ label: matchLabel, value: link(f.matchName, f.matchUrl) + (f.matches > 1 ? pill(`1 of ${f.matches} matches`) : "") });
  if (f.parent) out.push({ label: "Account", value: link(f.parent.label, f.parent.url) });
  // "Owner · Most in touch": who the team assigned vs who actually has the
  // relationship. Only split them when the CRM knows both and they differ —
  // otherwise one Owner field, as before.
  out.push(
    f.contact
      ? { label: "Owner · Most in touch", value: `${ownerValue(s, "claim it")} · ${esc(f.contact)}` }
      : { label: "Owner", value: ownerValue(s, "claim it") },
  );
  if (s.lastTouch) {
    const [date, kind] = [s.lastTouch.slice(0, 10), s.lastTouch.match(/\((\w+)\)/)?.[1]];
    out.push({ label: "Last touch", value: `${link(date, f.lastTouchUrl)}${kind ? ` · ${esc(kind)}` : ""}${f.stale ? pill(f.stale) : ""}` });
  }
  if (f.opportunity) out.push({ label: "Opportunity", value: link(f.opportunity.list.replace(/^Opportunity: /, ""), f.opportunity.url) + (f.opportunity.stage ? pill(f.opportunity.stage) : "") + dealPills(f.opportunity) });
  if (f.nextActivity?.date) out.push({ label: "Next", value: nextValue(f.nextActivity) });
  const other = f.lists.filter((l) => l !== f.opportunity).slice(0, 2);
  if (other.length) out.push({ label: other[0].kind === "campaign" ? "Campaign" : "List", value: other.map((l) => link(l.list, l.url)).join(" · ") });
  if (s.status && !f.opportunity?.stage) out.push({ label: "Stage / outcome", value: other[0]?.memberUrl ? link(s.status, other[0].memberUrl) : esc(s.status) });
  if (f.connectionStrength) out.push({ label: "Connection", value: esc(f.connectionStrength) });
  if (f.firmographics) out.push({ label: "Company size", value: esc(f.firmographics) });
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
  const owner = (s: SourceVerdict) => ownerValue(s, "claim");
  out.push({ label: `Owner (${tag(a)} / ${tag(b)})`, value: `${owner(a)} / ${owner(b)}` });
  for (const s of found)
    if (s.facts!.contact && s.facts!.contact !== s.owner)
      out.push({ label: `Most in touch (${tag(s)})`, value: esc(s.facts!.contact!) });
  const touch = (s: SourceVerdict) => (s.lastTouch ? link(s.lastTouch.slice(0, 10), s.facts!.lastTouchUrl) + (s.facts!.stale ? pill(s.facts!.stale) : "") : "—");
  out.push({ label: `Last touch (${tag(a)} / ${tag(b)})`, value: `${touch(a)} / ${touch(b)}` });
  for (const s of found) {
    const f = s.facts!;
    if (f.opportunity) out.push({ label: `Opportunity (${tag(s)})`, value: link(f.opportunity.list.replace(/^Opportunity: /, ""), f.opportunity.url) + (f.opportunity.stage ? pill(f.opportunity.stage) : "") + dealPills(f.opportunity) });
  }
  for (const s of found) if (s.facts!.nextActivity?.date) out.push({ label: `Next (${tag(s)})`, value: nextValue(s.facts!.nextActivity!) });
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

/** `$1.2M` `closes 2026-12-01` `45,000 SF · Office` pills after the stage. */
const dealPills = (o: ListMembership): string =>
  [o.amount != null ? money(o.amount) : "", o.closeDate ? `closes ${o.closeDate}` : "", o.detail ?? ""].filter(Boolean).map(pill).join("");

/** "2026-10-01 · call · Glenn Friedrich" with the date linked to the Task/Event. */
const nextValue = (a: Activity): string =>
  [link(a.date!, a.url), a.subject ? esc(a.subject) : esc(a.kind), a.owner ? esc(a.owner) : ""].filter(Boolean).join(" · ");

function peopleValue(f: BriefFacts): string | undefined {
  const linked = f.peopleLinks?.length ? f.peopleLinks.map((p) => link(p.label, p.url)) : f.people.map(esc);
  if (!linked.length) return undefined;
  const shown = linked.slice(0, 3).join(" · ");
  return f.people.length > 3 ? `${shown} +${f.people.length - 3}` : shown;
}

/** The write buttons for one CRM's row. `sources` is only passed when writes are on. */
function crmWrites(s: SourceVerdict, found: SourceVerdict[], domain: string, sources: SourceVerdict[]): ActionButton[] {
  const out: ActionButton[] = [];
  const f = s.facts;
  const rec = recordOf(s);
  const crmName = CRM_LABELS[s.crm];
  if (s.crm !== "salesforce" && s.crm !== "attio") return out;
  if (s.verdict === "prior_contact" && f && rec) {
    if (ownerGap(s))
      out.push({
        label: "Claim owner",
        action: { op: "claim", crm: s.crm, object: rec.object, id: rec.id },
        confirm: { title: `Claim in ${crmName}?`, text: `Set *${esc(f.matchName ?? rec.id)}* owner to you in ${crmName}.`, ok: "Claim" },
      });
    const other = found.find((o) => o !== s && (o.crm === "salesforce" || o.crm === "attio"));
    const orec = other && recordOf(other);
    if (other && orec && s.crm === "salesforce" && !crosslinked(s, other))
      out.push({
        label: "Link IDs",
        primary: true,
        action: { op: "crosslink", sf: rec, attio: orec },
        confirm: { title: "Cross-link records?", text: `Attio *${esc(other.facts?.matchName ?? orec.id)}* ↔ Salesforce *${esc(f.matchName ?? rec.id)}*. Each record gets the other's link (SF description, Attio note).`, ok: "Link" },
      });
    if (s.crm === "attio" && !nameFitsDomain(f.matchName, domain)) {
      const sf = found.find((o) => o.crm === "salesforce");
      const right = sf?.facts?.matchObject === "companies" ? sf.facts.matchName : sf?.facts?.parent?.label;
      out.push({
        label: "Fix Attio match",
        action: { op: "attio_rematch", domain, id: rec.id, name: right ?? domain, ...(sf?.facts?.matchUrl ? { note: `Salesforce: ${sf.facts.matchUrl}` } : {}) },
        confirm: { title: "Fix the Attio match?", text: `Move *${esc(domain)}* off *${esc(f.matchName ?? rec.id)}* onto a new company *${esc(right ?? domain)}*, with a note on both.`, ok: "Fix" },
      });
    }
    return out;
  }
  if (s.verdict !== "clean" || s.unreachable) return out;
  const seed = seedFrom(found[0], domain);
  const nothingAnywhere = !found.length && !sources.some((x) => x.unreachable);
  if (s.crm === "attio") {
    const who = [seed.name ?? seed.domain ?? domain, seed.person].filter(Boolean).map((x) => `*${esc(x!)}*`).join(" and ");
    out.push({
      label: seed.person ? "＋ Create company + person" : "＋ Company in Attio",
      primary: true,
      action: { op: "attio_create", ...seed },
      confirm: { title: "Create in Attio?", text: `Company ${who}${seed.domain ? ` (${esc(seed.domain)})` : ""}${seed.from ? `, source ${esc(seed.from.crm)} ${esc(seed.from.id)}` : ", source Valentine"}.`, ok: "Create" },
    });
  } else if (s.crm === "salesforce" && nothingAnywhere) {
    // With Attio knowing the company, the prefilled Lightning forms (＋ Lead /
    // ＋ Account, seeded from Attio) stay the way in — no write needed.
    out.push({
      label: "＋ Lead in Salesforce",
      primary: true,
      action: { op: "sf_create_lead", ...seed },
      confirm: { title: "Create a Lead?", text: `Lead *${esc(seed.name ?? domain)}*${seed.domain ? ` (${esc(seed.domain)})` : ""}, LeadSource Valentine, owner you.`, ok: "Create" },
    });
  }
  return out;
}

/** Meeting heads-up writes: claim a gapped owner per CRM, fix a wrong Attio
 *  match, log the meeting to every CRM that knows the company. */
function meetingWrites(found: SourceVerdict[], domain: string, meeting: { title: string; start?: number }): ActionButton[] {
  const out: ActionButton[] = [];
  const targets: { crm: "salesforce" | "attio"; object: "companies" | "people"; id: string }[] = [];
  for (const s of found) {
    if (s.crm !== "salesforce" && s.crm !== "attio") continue;
    const rec = recordOf(s);
    if (!rec) continue;
    targets.push({ crm: s.crm, object: rec.object, id: rec.id });
    for (const w of crmWrites(s, found, domain, found)) if (w.action.op !== "crosslink") out.push({ ...w, label: w.action.op === "claim" ? `Claim ${short(s.crm)} owner` : w.label });
  }
  if (targets.length)
    out.push({
      label: targets.length > 1 ? "Log to both CRMs" : `Log meeting to ${CRM_LABELS[targets[0].crm]}`,
      action: { op: "log_meeting", title: meeting.title, ...(meeting.start ? { start: meeting.start } : {}), targets },
      confirm: { title: "Log this meeting?", text: `*${esc(meeting.title)}* logged as a meeting on ${targets.map((t) => CRM_LABELS[t.crm]).join(" + ")}.`, ok: "Log" },
    });
  return out;
}

/** One CRM's row: its label (+ state pill), its buttons, and for a CRM that
 *  has nothing, what a create form will be prefilled with. `sources` is passed
 *  only when writes are on and adds the write-through buttons. */
function crmRow(s: SourceVerdict, found: SourceVerdict[], ids: Ids, domain = "", sources?: SourceVerdict[]): Block[] {
  const name = CRM_LABELS[s.crm];
  const f = s.facts;
  if (s.unreachable) return [context(`*${name.toUpperCase()}*${pill("unreachable")}`)];
  const writes = sources ? crmWrites(s, found, domain, sources) : [];
  if (s.verdict === "prior_contact" && f) {
    const links: Btn[] = [];
    if (f.matchUrl) links.push({ label: `Open ${recordNoun(f)}`, url: f.matchUrl });
    if (f.parent) links.push({ label: "Account", url: f.parent.url });
    if (f.views?.activity) links.push({ label: "Activity", url: f.views.activity });
    if (f.views?.emails) links.push({ label: "Emails", url: f.views.emails });
    for (const a of f.actions ?? []) if (!/meeting/i.test(a.label)) links.push(a);
    links.push(...writes);
    const rows = buttonRows(links, ids, writes.length ? 2 : 1);
    return rows.length ? [context(`*${name.toUpperCase()}*`), ...rows] : [];
  }
  // clean / ambiguous-but-readable
  const out: Block[] = [];
  const state = s.verdict === "clean" ? `nothing in ${name}` : `${f?.matches ?? "several"} matches — needs a look`;
  out.push(context(`*${name.toUpperCase()}*${pill(state)}`));
  const links: Btn[] = [...writes, ...(f?.actions ?? [])];
  if (f?.searchUrl) links.push({ label: s.crm === "attio" ? "Companies in Attio" : `Search ${name}`, url: f.searchUrl });
  out.push(...buttonRows(links, ids, writes.length ? 2 : 1));
  const seed = found[0];
  if ((f?.actions?.length || writes.length) && seed?.facts) {
    const sf = seed.facts;
    const bits = [sf.matchName && `${esc(sf.matchObject === "people" ? "contact" : "name")} \`${esc(sf.matchName)}\``, sf.domain && `website \`${esc(sf.domain)}\``, sf.matchUrl && `note \`${CRM_LABELS[seed.crm]} record link\``].filter(Boolean);
    if (bits.length) out.push(context(`prefills from ${CRM_LABELS[seed.crm]} → ${bits.join(" · ")} — ${writes.length ? `the green button writes them after you confirm${f?.actions?.length ? "; the form links save nothing until you press Save" : ""}` : "nothing is saved until you press Save"}`));
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
    out.push({
      label: `LinkedIn · ${f.matchName.split(" ")[0]}`,
      // Their actual profile when the CRM has it; a name search otherwise.
      url: f.linkedin ?? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${f.matchName} ${f.parent?.label ?? f.domain ?? ""}`.trim())}`,
    });
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
  /** Write-through is on for this card (the footer says so instead of "read-only"). */
  writes?: boolean;
}

function footer(res: SweepResult | undefined, meta: FooterMeta, lead = "swept"): Block {
  const swept = res
    ? res.sources.map((s) => link(CRM_LABELS[s.crm], s.facts?.matchUrl ?? s.facts?.searchUrl)).join(" + ")
    : esc(meta.crms);
  const bits = [`${lead} ${swept}${meta.elapsedMs != null ? ` in ${(meta.elapsedMs / 1000).toFixed(1)}s` : ""}`, meta.writes ? "writes on · every write confirmed" : "read-only"];
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
export interface MeetingLinks {
  /** Epoch ms — carried into "Log to both CRMs". */
  start?: number;
  /** Deep link to the event (ical://…) and the conferencing URL, when the calendar source has them. */
  url?: string;
  joinUrl?: string;
}

export function meetingMessage(
  title: string,
  minutes: number,
  items: MeetingItem[],
  meta: FooterMeta,
  opts: { meeting?: MeetingLinks; interactive?: CardOptions["interactive"] } = {},
): { text: string; blocks: Block[] } {
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: clip(`📅 ${title}`, LIMITS.header), emoji: true } },
    context(`:clock3: in *${minutes} min*  ·  ${items.length} external ${items.length === 1 ? "domain" : "domains"}  ·  swept ${esc(meta.crms)}`),
  ];
  const eventLinks: RecordLink[] = [];
  if (opts.meeting?.url) eventLinks.push({ label: "Open event", url: opts.meeting.url });
  if (opts.meeting?.joinUrl) eventLinks.push({ label: "Join", url: opts.meeting.joinUrl });
  const ev = buttonRow(eventLinks, new Ids("ev"));
  if (ev) blocks.push(ev);
  const lines: string[] = [`✦ ${title} in ${minutes} min`];
  const says: string[] = [];
  const saysFor: string[] = [];
  items.forEach((it, i) => {
    blocks.push(divider());
    if (it.res) {
      const card = targetBlocks(it.target, it.res, `v${i}`, { meeting: { title, start: opts.meeting?.start }, interactive: opts.interactive });
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
export function slashMessage(target: string, res: SweepResult, meta: FooterMeta, opts: Pick<CardOptions, "interactive"> = {}): { text: string; blocks: Block[] } {
  const v = res.combined;
  const { blocks, says } = targetBlocks(target, res, "s", { ...opts, ...(meta.runUrl ? { runUrl: meta.runUrl } : {}) });
  const s = saysBlock(says);
  if (s) blocks.push(s);
  blocks.push(footer(res, { ...meta, elapsedMs: meta.elapsedMs ?? res.elapsedMs }));
  return { text: `${MARK[v.verdict]} ${target} — ${v.summary}`, blocks: cap(blocks) };
}
