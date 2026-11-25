// What happens when someone presses a card button. Two kinds of action reach
// here from `valentine slack`:
//
//   menu ops   (`op|arg` from the ··· overflow) — local only: re-run the
//              sweep, hand back an id to copy, mute a domain for 30 days, mark
//              a target handled. Nothing touches the CRM.
//   card ops   (JSON `CardAction` from a write button) — the opt-in writes.
//              Refused outright unless writes are on; every payload is
//              re-validated here, never trusted from the button alone.
//
// Each op returns one reply for the asker (ephemeral) — what was written and
// where, or why not. Only "re-run" replaces the original card.

import type { Config } from "./config.js";
import { activeCrms, writesEnabled } from "./config.js";
import type { ModelClient } from "./models.js";
import { sweepAll, CRM_LABELS, type SweepResult } from "./sweep.js";
import { slashMessage, type CardAction, type MenuOp } from "./slackblocks.js";
import { makeWriter, type CRMWriter, type WriteResult } from "./writers/index.js";
import { mute, markHandled } from "./mutes.js";

export interface ActionReply {
  text: string;
  blocks?: unknown[];
  /** Replace the card the button lives on (re-run) instead of adding an ephemeral line. */
  replace?: boolean;
  /** Post where the channel can see it rather than only the presser (prep brief). */
  inChannel?: boolean;
  /** Open this modal instead of replying — `views.open` needs the trigger_id,
   *  so the caller with the payload in hand does the call. */
  openModal?: unknown;
  /** Post this reply to a response_url the payload did not carry (a modal
   *  submission, which remembers the card's url in private_metadata). */
  postTo?: string;
}

export interface ActionContext {
  /** Slack user who pressed the button — for the audit line. */
  user?: string;
  /** The card's response_url. A `view_submission` carries none of its own, so
   *  the modal remembers where to post its outcome. */
  responseUrl?: string;
}

const ok = (lines: string[]): ActionReply => ({ text: lines.map((l) => `✅ ${l}`).join("\n") });
const no = (why: string): ActionReply => ({ text: `⛔ ${why}` });
const linked = (r: WriteResult): string => (r.url ? `${r.label} — <${r.url}|open>` : r.label);

/** Parse a button/overflow value. Overflow values are `op|arg…`; buttons carry JSON. */
export function parseActionValue(raw: string | undefined): CardAction | { menu: MenuOp; args: string[] } | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("{")) {
    try {
      const v = JSON.parse(raw);
      return typeof v?.op === "string" ? (v as CardAction) : undefined;
    } catch {
      return undefined;
    }
  }
  const [menu, ...args] = raw.split("|");
  return menu === "rerun" || menu === "copy" || menu === "mute" || menu === "handled" || menu === "brief"
    ? { menu, args }
    : undefined;
}

export async function handleMenu(
  cfg: Config,
  client: ModelClient,
  menu: MenuOp,
  args: string[],
  render: (target: string, res: SweepResult) => { text: string; blocks: unknown[] } = (t, r) =>
    slashMessage(t, r, { crms: activeCrms(cfg).map((c) => CRM_LABELS[c]).join(" + "), elapsedMs: r.elapsedMs, writes: writesEnabled(cfg) }, { interactive: { writes: writesEnabled(cfg) } }),
): Promise<ActionReply> {
  switch (menu) {
    case "rerun": {
      const target = args[0]?.trim();
      if (!target) return no("Nothing to re-run.");
      const res = await sweepAll(client, cfg, target);
      return { ...render(target, res), replace: true };
    }
    case "copy": {
      const [crm, id] = args;
      return id ? { text: `${crm} id: \`${id}\`` } : no("No id on this card.");
    }
    case "mute": {
      const domain = args[0]?.trim().toLowerCase();
      if (!domain) return no("No domain to mute.");
      mute(domain, 30);
      return ok([`${domain} muted for 30 days — the watch heads-up skips it until then.`]);
    }
    case "handled": {
      const target = args[0]?.trim();
      if (!target) return no("Nothing to mark.");
      markHandled(target);
      return ok([`${target} marked handled — the watch heads-up skips it for a day.`]);
    }
    case "brief": {
      // Same sweep as re-run, but posted where everyone on the call can read
      // it instead of only the person who pressed it. Read-only.
      const target = args[0]?.trim();
      if (!target) return no("Nothing to brief on.");
      const runUrl = args[1]?.trim();
      const res = await sweepAll(client, cfg, target);
      const card = render(target, res);
      const blocks = [...(card.blocks as unknown[])];
      if (runUrl) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${runUrl}|Replay this sweep in the Lab>` }] });
      return { ...card, blocks, inChannel: true };
    }
  }
}

const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isRec = (x: any): x is { object: "companies" | "people"; id: string; url?: string } =>
  !!x && (x.object === "companies" || x.object === "people") && isStr(x.id);

export async function handleCardAction(cfg: Config, action: CardAction, ctx: ActionContext = {}): Promise<ActionReply> {
  if (!writesEnabled(cfg)) return no("Writes are off on this Valentine — set `writes: true` in ~/.valentine/config.json or VALENTINE_WRITES=1 and restart `valentine slack`.");
  const by = ctx.user ? ` (via Slack, ${ctx.user})` : " (via Slack)";
  const sf = () => makeWriter(cfg, "salesforce");
  const at = () => makeWriter(cfg, "attio");
  const need = (w: CRMWriter | undefined, name: string): CRMWriter => {
    if (!w) throw new Error(`${name} is not configured for writes on this Valentine.`);
    return w;
  };
  try {
    switch (action.op) {
      case "add_note": {
        // The only write whose content comes from the human, so there is
        // nothing to confirm up front — the modal IS the confirmation.
        if (!isStr(action.target)) return no("Bad note payload.");
        return { text: "", openModal: noteModal(action, ctx.responseUrl) };
      }
      case "claim": {
        if (!isRec(action) || (action.crm !== "salesforce" && action.crm !== "attio")) return no("Bad claim payload.");
        const w = need(action.crm === "salesforce" ? sf() : at(), CRM_LABELS[action.crm]);
        return ok([linked(await w.claimOwner(action.object, action.id))]);
      }
      case "attio_create": {
        const w = need(at(), "Attio");
        const name = isStr(action.name) ? action.name : isStr(action.domain) ? action.domain : undefined;
        if (!name) return no("Nothing to create — no name or domain on the button.");
        const note = action.from ? `${action.from.crm}: ${action.from.url ?? action.from.id}${by}` : `Created by Valentine${by}`;
        const company = await w.createCompany({ name, domain: isStr(action.domain) ? action.domain : undefined, note });
        const lines = [linked(company)];
        if (isStr(action.person)) lines.push(linked(await w.createPerson({ name: action.person, email: isStr(action.email) ? action.email : undefined, companyId: company.id, note })));
        return ok(lines);
      }
      case "sf_create_lead": {
        const w = need(sf(), "Salesforce");
        if (!w.createLead) return no("Salesforce writer has no Lead support.");
        const name = isStr(action.name) ? action.name : isStr(action.domain) ? action.domain : undefined;
        if (!name) return no("Nothing to create — no name or domain on the button.");
        const note = action.from ? `${action.from.crm}: ${action.from.url ?? action.from.id}${by}` : `Created by Valentine${by}`;
        return ok([linked(await w.createLead({ name, domain: isStr(action.domain) ? action.domain : undefined, person: isStr(action.person) ? action.person : undefined, email: isStr(action.email) ? action.email : undefined, note }))]);
      }
      case "create_both": {
        const s = need(sf(), "Salesforce");
        const a = need(at(), "Attio");
        if (!s.createLead) return no("Salesforce writer has no Lead support.");
        const name = isStr(action.name) ? action.name : isStr(action.domain) ? action.domain : undefined;
        if (!name) return no("Nothing to create — no name or domain on the button.");
        const domain = isStr(action.domain) ? action.domain : undefined;
        const lead = await s.createLead({ name, domain, person: isStr(action.person) ? action.person : undefined, note: `Created by Valentine${by}` });
        const company = await a.createCompany({ name, domain, note: `Salesforce: ${lead.url ?? lead.id}${by}` });
        const back = await s.crosslink("people", lead.id, { crm: "Attio", id: company.id, url: company.url });
        return ok([linked(lead), linked(company), back.label]);
      }
      case "crosslink": {
        if (!isRec(action.sf) || !isRec(action.attio)) return no("Bad cross-link payload.");
        const s = need(sf(), "Salesforce");
        const a = need(at(), "Attio");
        const r1 = await s.crosslink(action.sf.object, action.sf.id, { crm: "Attio", id: action.attio.id, url: action.attio.url });
        const r2 = await a.crosslink(action.attio.object, action.attio.id, { crm: "Salesforce", id: action.sf.id, url: action.sf.url });
        return ok([linked(r1), linked(r2)]);
      }
      case "attio_rematch": {
        const a = need(at(), "Attio");
        if (!a.rematch || !isStr(action.domain) || !isStr(action.id) || !isStr(action.name)) return no("Bad fix-match payload.");
        return ok([linked(await a.rematch(action.domain, action.id, { name: action.name, note: isStr(action.note) ? `${action.note}${by}` : undefined }))]);
      }
      case "log_meeting": {
        if (!isStr(action.title) || !Array.isArray(action.targets) || !action.targets.length) return no("Bad log-meeting payload.");
        const lines: string[] = [];
        for (const t of action.targets) {
          if (!isRec(t) || (t.crm !== "salesforce" && t.crm !== "attio")) continue;
          const w = need(t.crm === "salesforce" ? sf() : at(), CRM_LABELS[t.crm]);
          const when = typeof action.start === "number" ? new Date(action.start).toISOString() : undefined;
          lines.push(linked(await w.logActivity(t.object, t.id, { kind: "meeting", subject: action.title, at: when, note: `Logged by Valentine${by}` })));
        }
        return lines.length ? ok(lines) : no("No CRM record to log to.");
      }
      default:
        return no(`Unknown action ${(action as any)?.op}.`);
    }
  } catch (e: any) {
    return no(`Write failed: ${e?.message ?? e}`);
  }
}

/** The Add-note modal. `private_metadata` carries the record it will land on
 *  so the submission needs no server-side session. */
export const NOTE_VIEW_ID = "valentine_note";

function noteModal(a: Extract<CardAction, { op: "add_note" }>, responseUrl?: string): unknown {
  const where = a.name ? `${a.name} (${a.target})` : a.target;
  return {
    type: "modal",
    callback_id: NOTE_VIEW_ID,
    private_metadata: JSON.stringify({ target: a.target, ru: responseUrl }),
    title: { type: "plain_text", text: "Add a note" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "context", elements: [{ type: "mrkdwn", text: `Lands on *${where}* — every CRM that knows it.` }] },
      {
        type: "input",
        block_id: "note",
        label: { type: "plain_text", text: "Note" },
        element: {
          type: "plain_text_input",
          action_id: "text",
          multiline: true,
          placeholder: { type: "plain_text", text: "Met Jane at SaaStr — warm, revisit in Q1." },
        },
      },
    ],
  };
}

/** A `view_submission` on the Add-note modal → the note, written wherever the
 *  target is known. Same path as `/valentine note`, so the button and the
 *  command cannot drift apart. */
export async function handleNoteSubmission(cfg: Config, client: ModelClient, view: any, ctx: ActionContext = {}): Promise<ActionReply> {
  let meta: any;
  try {
    meta = JSON.parse(view?.private_metadata ?? "{}");
  } catch {
    return no("That modal carries nothing Valentine understands.");
  }
  const ru: string | undefined = typeof meta?.ru === "string" && meta.ru ? meta.ru : undefined;
  const postTo = ru ? { postTo: ru } : {};
  if (!isStr(meta?.target)) return { ...no("Bad note payload."), ...postTo };
  const text = String(view?.state?.values?.note?.text?.value ?? "").trim();
  if (!text) return { ...no("Empty note — nothing written."), ...postTo };
  return { ...(await handleNote(cfg, client, meta.target, text, ctx)), ...postTo };
}

/** `/valentine note <target> <text…>` — a note on every record the sweep found. */
export async function handleNote(cfg: Config, client: ModelClient, target: string, text: string, ctx: ActionContext = {}): Promise<ActionReply> {
  if (!writesEnabled(cfg)) return no("Writes are off on this Valentine — set `writes: true` or VALENTINE_WRITES=1.");
  if (!text.trim()) return no("Usage: `/valentine note acme.com Met Jane at SaaStr — warm.`");
  const res = await sweepAll(client, cfg, target);
  const lines: string[] = [];
  for (const s of res.sources) {
    if (s.verdict !== "prior_contact" || !s.citations[0] || (s.crm !== "salesforce" && s.crm !== "attio")) continue;
    const w = makeWriter(cfg, s.crm);
    if (!w) continue;
    try {
      lines.push(linked(await w.addNote(s.facts?.matchObject ?? "companies", s.citations[0], `${text.trim()}${ctx.user ? ` — ${ctx.user} via Slack` : ""}`)));
    } catch (e: any) {
      lines.push(`${CRM_LABELS[s.crm]}: ${e?.message ?? e}`);
    }
  }
  return lines.length ? ok(lines) : no(`No record for ${target} in ${activeCrms(cfg).map((c) => CRM_LABELS[c]).join(" or ")} — create one first.`);
}
