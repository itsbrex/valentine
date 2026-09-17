// THE FAST PATH, step two: judge and brief. The verdict is a rule over the
// evidence (any real signal → prior_contact — the same rule the system prompt
// gave the agent), so it never depends on a model getting it right. The model's
// only job is the one-line summary, produced in a single structured call with
// a timeout and a template fallback — so a slow or flaky local model can cost
// you a nicer sentence, never the verdict, and never the meeting heads-up.

import type { CRMConnector, CRMMatch, CRMContext, Verdict, BriefFacts, RecordLink } from "./connectors/types.js";
import type { ModelClient } from "./models.js";
import { gather, hasSignal, type Evidence, type TraceFn, type ModelUsage } from "./gather.js";

export interface Judged {
  verdict: Verdict["verdict"];
  owner?: string;
  lastTouch?: string;
  status?: string;
  citations: string[];
  facts: BriefFacts;
}

/** Latest of the YYYY-MM-DD-ish dates on a match, labelled by kind. */
function lastTouchOf(m: CRMMatch): string | undefined {
  const cands: { date: string; kind: string }[] = [];
  if (m.lastMeeting) cands.push({ date: m.lastMeeting, kind: "meeting" });
  if (m.lastEmail) cands.push({ date: m.lastEmail, kind: "email" });
  if (m.lastInteraction) {
    const [kind, date] = m.lastInteraction.split(" · ");
    if (date) cands.push({ date, kind });
    else cands.push({ date: m.lastInteraction, kind: "touch" });
  }
  if (!cands.length) return undefined;
  cands.sort((a, b) => (a.date < b.date ? 1 : -1));
  return `${cands[0].date} (${cands[0].kind})`;
}

/** The outcome a partner cares about: pipeline stage first, else a note that
 *  reads like an outcome ("passed", "portfolio", "tracking", "in DD"…). */
function statusOf(ctx?: CRMContext): string | undefined {
  if (!ctx) return undefined;
  const staged = ctx.lists.find((l) => l.stage);
  if (staged) return staged.stage;
  if (ctx.lists.length) return ctx.lists[0].list;
  const outcome = ctx.notes.find((n) => /\b(pass(ed)?|portfolio|tracking|invest|term sheet|dd|diligence|declin|lost|won|signed)\b/i.test(n));
  return outcome ? outcome.replace(/\s+/g, " ").slice(0, 80) : undefined;
}

function linksFor(top: CRMMatch | undefined, crmName: string, target: Evidence["target"]): RecordLink[] {
  const links: RecordLink[] = [];
  if (top?.url) links.push({ label: `Open in ${crmName}`, url: top.url });
  const domain = top?.domain ?? (target.kind === "domain" ? target.value : undefined);
  if (domain) links.push({ label: "Website", url: `https://${domain}` });
  const q = top?.name ?? target.value;
  links.push({
    label: "LinkedIn",
    url: `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(q)}`,
  });
  return links;
}

export function judge(ev: Evidence, crmName: string): Judged {
  const top = ev.matches[0];
  const ctx = top ? ev.contexts.get(top.recordId) : undefined;
  const flagged = ev.matches.filter((m) => hasSignal(m, ev.contexts.get(m.recordId)));

  const facts: BriefFacts = {
    matchName: top?.name,
    domain: top?.domain,
    matches: ev.matches.length,
    connectionStrength: top?.connectionStrength,
    firstInteraction: top?.firstInteraction,
    lastEmail: top?.lastEmail,
    lastMeeting: top?.lastMeeting,
    people: (ctx?.people ?? []).slice(0, 5),
    lists: (ctx?.lists ?? []).slice(0, 5),
    notes: (ctx?.notes ?? []).slice(0, 3).map((n) => n.replace(/\s+/g, " ").trim().slice(0, 240)),
    links: linksFor(top, crmName, ev.target),
  };

  let verdict: Verdict["verdict"];
  if (flagged.length > 0) verdict = "prior_contact";
  else if (ev.matches.length > 3 && ev.target.kind === "name") verdict = "ambiguous";
  else verdict = "clean";

  return {
    verdict,
    owner: top?.owner,
    lastTouch: top ? lastTouchOf(top) : undefined,
    status: statusOf(ctx),
    citations: flagged.length ? flagged.slice(0, 3).map((m) => m.recordId) : top ? [top.recordId] : [],
    facts,
  };
}

/** The no-model summary. Always available, always true. */
export function templateSummary(j: Judged, target: string): string {
  const name = j.facts.matchName ?? target;
  if (j.verdict === "clean") return `No prior contact on record for ${name}.`;
  if (j.verdict === "ambiguous")
    return `${j.facts.matches} records match "${target}" — none clearly it. Check the CRM before the call.`;
  const bits: string[] = [];
  if (j.owner) bits.push(`${j.owner} owns the relationship`);
  if (j.lastTouch) bits.push(`last ${j.lastTouch.replace(/^(\S+) \((\w+)\)$/, "$2 $1")}`);
  if (j.status) bits.push(j.status);
  if (j.facts.connectionStrength) bits.push(`${j.facts.connectionStrength.toLowerCase()} connection`);
  if (!bits.length && j.facts.people.length) bits.push(`${j.facts.people.length} known contact(s)`);
  return `${name}: ${bits.join(" · ") || "prior contact on record"}.`;
}

// --- the one model call ---

export const BRIEF_SYSTEM = `You write one-line pre-meeting briefs from CRM facts.
Reply with a JSON object: {"summary": string}.
- summary: ONE sentence, at most 22 words, plain text, no markdown, no domain name. Write prose; never copy the field labels below.
- Lead with the most actionable fact: the outcome or deal stage if there is one, who owns the relationship, when it was last touched.
- State facts only. Do not characterize them (no "active", "strong", "recent") unless the word is in the facts, and never say what is missing.
- Use only the facts given. Never invent people, dates, owners, or outcomes. "Their people" are contacts at the company, not the owner.
- Keep dates exactly as written.`;

export const BRIEF_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string", description: "One sentence, max 22 words" } },
  required: ["summary"],
} as const;

export function briefUserPrompt(j: Judged, target: string, crmName: string): string {
  // Only facts that exist. A line like "Owner: none" is an invitation for a
  // small model to write "has no owner" — or worse, to make one up.
  const f = j.facts;
  const lines = [`Target: ${target}`, `Source: ${crmName}`];
  if (f.matchName) lines.push(`Record: ${f.matchName}`);
  if (j.owner) lines.push(`Owner (our side): ${j.owner}`);
  if (j.status) lines.push(`Outcome / stage: ${j.status}`);
  if (j.lastTouch) lines.push(`Last touch: ${j.lastTouch}`);
  if (f.lastMeeting && j.lastTouch && !j.lastTouch.startsWith(f.lastMeeting)) lines.push(`Last meeting: ${f.lastMeeting}`);
  if (f.lastEmail && j.lastTouch && !j.lastTouch.startsWith(f.lastEmail)) lines.push(`Last email: ${f.lastEmail}`);
  if (f.firstInteraction) lines.push(`First interaction: ${f.firstInteraction}`);
  if (f.connectionStrength) lines.push(`Connection strength: ${f.connectionStrength}`);
  if (f.lists.length)
    lines.push(`Lists / pipeline: ${f.lists.map((l) => (l.stage ? `${l.list} — ${l.stage}` : l.list)).join("; ")}`);
  if (f.people.length) lines.push(`Their people in the CRM: ${f.people.join(", ")}`);
  if (f.notes.length) lines.push(`Notes: ${f.notes.map((n) => JSON.stringify(n)).join(" ")}`);
  return lines.join("\n");
}

/** Pull a JSON object out of model text that may carry fences or prose. */
export function parseJsonLoose(text: string): Record<string, unknown> | undefined {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const v = JSON.parse(cleaned.slice(start, end + 1));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** One structured call, provider-agnostic: providers with a native fast path
 *  (Ollama) use it; the Anthropic client gets a single forced tool call. */
export async function structured(
  client: ModelClient,
  req: { model: string; system: string; user: string; schema: Record<string, unknown>; max_tokens: number },
): Promise<Record<string, unknown> | undefined> {
  if (client.structured) return client.structured(req);
  const res = await client.messages.create({
    model: req.model,
    max_tokens: req.max_tokens,
    system: req.system,
    tools: [{ name: "write_brief", description: "Return the brief.", input_schema: req.schema }] as never,
    tool_choice: { type: "tool", name: "write_brief" },
    messages: [{ role: "user", content: req.user }],
  });
  const tu = res.content.find((b) => b.type === "tool_use") as { input?: unknown } | undefined;
  if (tu && tu.input && typeof tu.input === "object") return tu.input as Record<string, unknown>;
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ");
  return parseJsonLoose(text);
}

/** A summary the model wrote is only used if it is a plausible one-liner AND
 *  every checkable claim in it is backed by the facts: an owner is only
 *  mentioned when we have one, every date in it appears in the evidence, and
 *  every capitalized name is one the CRM gave us. Small models are fluent
 *  liars; the template is not. */
export function acceptSummary(s: unknown, j?: Judged): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length < 8 || t.length > 280) return undefined;
  if (/^\{|\bnull\b|undefined/.test(t)) return undefined;
  if (!j) return t;
  if (!j.owner && /\b(own(s|ed|er|ership)?|handl(es|ed|ing))\b/i.test(t)) return undefined;
  const known = [j.owner, j.lastTouch, j.status, j.facts.matchName, j.facts.firstInteraction, j.facts.lastEmail, j.facts.lastMeeting, ...j.facts.people, ...j.facts.lists.flatMap((l) => [l.list, l.stage]), ...j.facts.notes]
    .filter((x): x is string => !!x)
    .join(" ");
  for (const date of t.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []) if (!known.includes(date)) return undefined;
  for (const year of t.match(/\b(19|20)\d{2}\b/g) ?? []) if (!known.includes(year)) return undefined;
  return t;
}

export interface BriefOptions {
  /** Skip the model entirely — template summaries only. */
  noModel?: boolean;
  /** Give up on the model after this long and use the template. */
  timeoutMs?: number;
  /** Receive every step as it happens (search, context, judge, model…). */
  trace?: TraceFn;
}

/** Last usage reported by a provider's structured() call, keyed by model.
 *  Providers that know their token counts set it; the trace reads it once. */
export const lastUsage = new Map<string, ModelUsage>();

/** Sweep one CRM for a target and return a verdict with structured facts. */
export async function brief(
  client: ModelClient,
  model: string,
  crm: CRMConnector,
  target: string,
  opts: BriefOptions = {},
): Promise<Verdict> {
  const t0 = Date.now();
  const trace = opts.trace ?? (() => {});
  const ev = await gather(crm, target, { trace });
  const j = judge(ev, crm.name);
  trace({ type: "judge", crm: crm.name, verdict: j.verdict, owner: j.owner, lastTouch: j.lastTouch, status: j.status });
  const fallback = templateSummary(j, target);
  let summary = fallback;

  // Clean = nothing to say beyond "nothing found". Don't spend a model call.
  if (opts.noModel) trace({ type: "model.skip", crm: crm.name, reason: "noModel" });
  else if (j.verdict === "clean") trace({ type: "model.skip", crm: crm.name, reason: "clean verdict — nothing to summarize" });
  else {
    const timeoutMs = opts.timeoutMs ?? 25_000;
    const user = briefUserPrompt(j, target, crm.name);
    trace({ type: "model.start", crm: crm.name, model, prompt: user });
    const m0 = Date.now();
    // A referenced timer, cleared on settle: an unref'd one let Node's test
    // runner exit before the race resolved ("Promise resolution is still
    // pending but the event loop has already resolved") on Linux CI.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        structured(client, {
          model,
          system: BRIEF_SYSTEM,
          user,
          schema: BRIEF_SCHEMA as unknown as Record<string, unknown>,
          max_tokens: 160,
        }),
        new Promise<undefined>((r) => {
          timer = setTimeout(() => r(undefined), timeoutMs);
        }),
      ]);
      const accepted = acceptSummary(out?.summary, j);
      summary = accepted ?? fallback;
      trace({
        type: "model.end", crm: crm.name, model, ms: Date.now() - m0,
        raw: typeof out?.summary === "string" ? out.summary : out === undefined ? undefined : JSON.stringify(out),
        summary, accepted: !!accepted,
        reason: accepted ? undefined : out === undefined ? `no answer within ${timeoutMs} ms (or unparseable)` : "rejected by grounding check — template used",
        usage: lastUsage.get(model),
      });
    } catch (e: any) {
      summary = fallback;
      trace({ type: "model.end", crm: crm.name, model, ms: Date.now() - m0, accepted: false, reason: `error: ${e?.message ?? e}`, summary });
    } finally {
      clearTimeout(timer);
    }
  }
  trace({ type: "source.done", crm: crm.name, verdict: j.verdict, ms: Date.now() - t0, summary });

  return {
    verdict: j.verdict,
    summary,
    owner: j.owner,
    lastTouch: j.lastTouch,
    status: j.status,
    citations: j.citations,
    facts: j.facts,
    elapsedMs: Date.now() - t0,
  };
}
