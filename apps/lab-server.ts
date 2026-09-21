// Valentine Lab — the backend for apps/valentine-lab.html. Runs REAL sweeps
// and benches through the same code the CLI and the watch daemon use, and
// streams every step (CRM search, context pull, judge, model call with token
// counts, render) over Server-Sent Events so the dashboard can animate the
// data flow with measured timings. Read-only against the CRMs, like everything
// else here; the only side effect is an explicit "send to Slack" click.
//
//   bun run plans serve --name valentine-lab npx tsx apps/lab-server.ts
//   → https://valentine-lab.localhost
//
// Portless injects PORT/HOST/PORTLESS_URL; never hardcode a port.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";

import { loadConfig, activeCrms, writesEnabled, type Config } from "../src/config.js";
import { makeClient, OLLAMA_MODELS, DEFAULT_OLLAMA_HOST, type ModelClient } from "../src/models.js";
import { sweepAll, CRM_LABELS, type SweepResult } from "../src/sweep.js";
import { BRIEF_SYSTEM, BRIEF_SCHEMA, briefUserPrompt, acceptSummary, templateSummary, lastUsage, type Judged } from "../src/brief.js";
import { OllamaClient } from "../src/ollama.js";
import { missingCrmCreds } from "../src/connectors/index.js";
import { meetingMessage, slashMessage, type MeetingItem } from "../src/slackblocks.js";
import { renderSweep, exitCodeFor } from "../src/output.js";
import { notify } from "../src/notify.js";
import { MacosCalendarSource } from "../src/calendar/macos.js";
import { sweepTargets } from "../src/watch.js";
import type { TraceEvent } from "../src/gather.js";
import { VERSION } from "../src/version.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGE = join(ROOT, "apps", "valentine-lab.html");

// The launchd wrapper sources .env; do the same so the Slack DM channel works
// from here. Values are never echoed anywhere.
(() => {
  const f = join(ROOT, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] != null) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
})();

// ---------------------------------------------------------------- runs + SSE

interface LabEvent {
  t: number; // ms since run start
  type: string;
  [k: string]: unknown;
}
interface Run {
  id: string;
  kind: string;
  startedAt: number;
  events: LabEvent[];
  done: boolean;
  listeners: Set<ServerResponse>;
}
const runs = new Map<string, Run>();
/** Where this lab is reachable — the Slack footer's "run <id>" link points at `${labUrl}/?run=<id>`. */
let labUrl: string | undefined;
/** The port actually bound (portless hands out PORT=0) — the simulated card's `response_url` comes back here. */
let labPort = 0;
const runLink = (run: Run) => ({ runId: run.id.slice(0, 8), runUrl: labUrl ? `${labUrl}/?run=${run.id}` : undefined });

function emit(run: Run, type: string, data: Record<string, unknown> = {}): void {
  // `type` last: trace payloads carry their own `type` (search, judge…) and
  // must not overwrite the namespaced one (trace.search…).
  const ev: LabEvent = { t: Date.now() - run.startedAt, ...data, type };
  run.events.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of run.listeners) res.write(line);
  if (type === "done" || type === "fatal") {
    run.done = true;
    for (const res of run.listeners) res.end();
    run.listeners.clear();
  }
}

function newRun(kind: string): Run {
  const run: Run = { id: randomUUID().slice(0, 8), kind, startedAt: Date.now(), events: [], done: false, listeners: new Set() };
  runs.set(run.id, run);
  // Keep memory bounded: drop finished runs beyond the last 40.
  const ids = [...runs.keys()];
  while (ids.length > 40) {
    const id = ids.shift()!;
    if (runs.get(id)?.done) runs.delete(id);
  }
  return run;
}

// Wrap a client so every raw model turn (agent loop or structured) is timed.
function tracedClient(base: ModelClient, run: Run, tag: string): ModelClient {
  return {
    messages: {
      create: async (req) => {
        const t0 = Date.now();
        emit(run, "agent.turn.start", { tag, messages: req.messages.length });
        const out = await base.messages.create(req);
        const tools = out.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({ name: b.name, input: b.input }));
        const text = out.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").slice(0, 300);
        emit(run, "agent.turn.end", { tag, ms: Date.now() - t0, tools, text });
        return out;
      },
    },
    ...(base.structured ? { structured: (req: any) => base.structured!(req) } : {}),
  };
}

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "").replace(/\]8;;[^]*/g, "");

// ---------------------------------------------------------------- scenarios

interface SweepBody {
  target: string;
  model?: string;
  strategy?: "brief" | "agent";
  noModel?: boolean;
  crms?: string[];
  timeoutMs?: number;
}

function cfgFor(body: Partial<SweepBody>): Config {
  const cfg = loadConfig();
  if (body.model) cfg.model = body.model;
  if (body.strategy) cfg.strategy = body.strategy;
  if (body.crms?.length) {
    const list = body.crms.filter((c): c is Config["crm"] => ["attio", "affinity", "salesforce"].includes(c));
    if (list.length) {
      cfg.crms = list;
      cfg.crm = list[0];
    }
  }
  return cfg;
}

async function runSweep(run: Run, body: SweepBody, tag = "sweep"): Promise<SweepResult | undefined> {
  const cfg = cfgFor(body);
  const missing = missingCrmCreds(cfg);
  if (missing.length) {
    emit(run, "fatal", { error: `credentials missing for ${missing.join(", ")}` });
    return undefined;
  }
  const client = tracedClient(makeClient(cfg), run, tag);
  emit(run, "sweep.start", { tag, target: body.target, model: cfg.model, strategy: cfg.strategy ?? "brief", crms: activeCrms(cfg) });
  const trace = (e: TraceEvent) => emit(run, `trace.${e.type}`, { tag, ...e });
  try {
    const res = await sweepAll(client, cfg, body.target, { noModel: body.noModel, timeoutMs: body.timeoutMs, trace });
    const crmNames = activeCrms(cfg).map((c) => CRM_LABELS[c]).join(" + ");
    // Preview the card the way `valentine slack` would send it: with writes on, the write buttons show too.
    const writes = writesEnabled(cfg);
    const slack = slashMessage(body.target, res, { crms: crmNames, elapsedMs: res.elapsedMs, model: cfg.model, writes, ...runLink(run) }, { interactive: { writes } });
    emit(run, "sweep.result", {
      tag,
      target: body.target,
      result: res,
      exitCode: exitCodeFor(res.combined),
      cli: strip(renderSweep(res)),
      slack,
    });
    return res;
  } catch (e: any) {
    emit(run, "sweep.error", { tag, error: String(e?.message ?? e) });
    return undefined;
  }
}

// Fixture cases for the bench — the shapes brief.ts builds, lifted from real sweeps.
const facts = (over: Record<string, unknown>) => ({ matches: 1, people: [], lists: [], notes: [], links: [], ...over });
const BENCH_CASES: { target: string; crm: string; j: Judged }[] = [
  { target: "hines.com", crm: "Attio", j: { verdict: "prior_contact", owner: "JP Roach", lastTouch: "2026-09-15 (meeting)", status: "Negotiation", citations: [], facts: facts({ matchName: "Hines", domain: "hines.com", connectionStrength: "Very strong", firstInteraction: "2025-02-26", lastEmail: "2026-08-17", lastMeeting: "2026-09-15", people: ["Drew Huffman", "Amy Higuchi", "Marquelle Sanchez"], lists: [{ list: "Pipeline", stage: "Negotiation" }], notes: ["Intro call 2025-02 — exploring HQ relocation, 40k sf. Passed for now, revisit Q3."] }) as any } },
  { target: "cyth.com", crm: "Salesforce", j: { verdict: "prior_contact", owner: "Brian Roach", lastTouch: "2026-07-02 (activity)", status: "Negotiation", citations: [], facts: facts({ matchName: "Cyth Systems", domain: "cyth.com", people: ["Shelby Thurston", "Joe Spinozzi"], lists: [{ list: "Opportunity: Cyth Expansion-San Diego", stage: "Negotiation" }], notes: ["Call: discussed San Diego expansion, 12k sf lab space, budget approved"] }) as any } },
  { target: "eksretirement.com", crm: "Attio", j: { verdict: "prior_contact", lastTouch: "2024-02-13 (email)", citations: [], facts: facts({ matchName: "EKS Group, LLC", domain: "eksretirement.com", firstInteraction: "2023-01-02", lastEmail: "2024-02-13", lastMeeting: "2023-01-05", people: ["Ed Strazzulla"] }) as any } },
  { target: "Jane Founder", crm: "Affinity", j: { verdict: "prior_contact", lastTouch: "2026-03-03 (email)", status: "Passed — too early", citations: [], facts: facts({ matchName: "Jane Founder", lastEmail: "2026-03-03", lists: [{ list: "Passed" }], notes: ["Passed — too early, pre-revenue. Sarah to track."] }) as any } },
];

async function runBench(run: Run, body: { models: string[]; rounds?: number }): Promise<void> {
  const cfg = loadConfig();
  const host = cfg.ollamaHost ?? DEFAULT_OLLAMA_HOST;
  const rounds = Math.max(1, Math.min(5, body.rounds ?? 1));
  emit(run, "bench.start", { models: body.models, cases: BENCH_CASES.map((c) => c.target), rounds });
  for (const model of body.models) {
    const client = new OllamaClient(host);
    emit(run, "bench.model.start", { model });
    try {
      const t0 = Date.now();
      await client.structured!({ model, system: 'Reply with {"summary":"ok"}', user: "go", schema: BRIEF_SCHEMA as any, max_tokens: 20 });
      emit(run, "bench.warm", { model, ms: Date.now() - t0 });
    } catch (e: any) {
      emit(run, "bench.model.error", { model, error: String(e?.message ?? e) });
      continue;
    }
    const times: number[] = [];
    let ok = 0;
    for (let r = 0; r < rounds; r++) {
      for (const c of BENCH_CASES) {
        const t0 = Date.now();
        let out: Record<string, unknown> | undefined;
        let error: string | undefined;
        try {
          out = await client.structured!({ model, system: BRIEF_SYSTEM, user: briefUserPrompt(c.j, c.target, c.crm), schema: BRIEF_SCHEMA as any, max_tokens: 160 });
        } catch (e: any) {
          error = String(e?.message ?? e);
        }
        const ms = Date.now() - t0;
        times.push(ms);
        const summary = acceptSummary(out?.summary, c.j);
        if (summary) ok++;
        emit(run, "bench.case", { model, round: r + 1, target: c.target, ms, ok: !!summary, summary, raw: out?.summary, error, template: templateSummary(c.j, c.target), usage: lastUsage.get(model) });
      }
    }
    const sorted = [...times].sort((a, b) => a - b);
    emit(run, "bench.model.done", { model, median: sorted[Math.floor(sorted.length / 2)], mean: Math.round(times.reduce((a, b) => a + b, 0) / times.length), valid: ok, total: times.length });
  }
  emit(run, "done", {});
}

async function runCompare(run: Run, body: SweepBody): Promise<void> {
  emit(run, "compare.start", { target: body.target });
  const a = await runSweep(run, { ...body, strategy: "brief" }, "brief");
  const b = await runSweep(run, { ...body, strategy: "agent" }, "agent");
  emit(run, "compare.result", { brief: a?.elapsedMs, agent: b?.elapsedMs });
  emit(run, "done", {});
}

async function runMeeting(run: Run, body: { withinMinutes?: number; title?: string; targets?: string[]; model?: string; noModel?: boolean }): Promise<void> {
  let title = body.title ?? "Ad-hoc meeting";
  let targets = body.targets ?? [];
  let minutes = 30;
  if (!targets.length) {
    try {
      const meetings = await new MacosCalendarSource().upcoming(body.withinMinutes ?? 240);
      const withExternal = meetings.map((m) => ({ m, targets: sweepTargets(m).slice(0, 3) })).filter((x) => x.targets.length);
      emit(run, "meeting.calendar", { count: meetings.length, candidates: withExternal.map((x) => ({ title: x.m.title, start: x.m.start, targets: x.targets })) });
      if (!withExternal.length) {
        emit(run, "done", { note: "no upcoming meetings with external attendees" });
        return;
      }
      title = withExternal[0].m.title;
      targets = withExternal[0].targets;
      minutes = Math.max(1, Math.round((withExternal[0].m.start - Date.now()) / 60000));
    } catch (e: any) {
      emit(run, "fatal", { error: `calendar: ${String(e?.message ?? e)}` });
      return;
    }
  }
  emit(run, "meeting.start", { title, targets, minutes });
  const t0 = Date.now();
  const items: MeetingItem[] = await Promise.all(
    targets.map(async (target) => {
      const res = await runSweep(run, { target, model: body.model, noModel: body.noModel }, target);
      return res ? { target, res } : { target, error: "sweep failed" };
    }),
  );
  const cfg = loadConfig();
  const writes = writesEnabled(cfg);
  const msg = meetingMessage(title, minutes, items, { crms: activeCrms(cfg).map((c) => CRM_LABELS[c]).join(" + "), model: body.model ?? cfg.model, elapsedMs: Date.now() - t0, writes, ...runLink(run) }, writes ? { interactive: { writes } } : {});
  emit(run, "meeting.result", { title, minutes, text: msg.text, blocks: msg.blocks, elapsedMs: Date.now() - t0 });
  emit(run, "done", {});
}

// ------------------------------------------------------- simulate a card click
//
// The Slack app's Interactivity Request URL isn't wired up yet, so the card's
// ··· menu can't be pressed from Slack. This signs a real `block_actions`
// payload exactly the way Slack does — v0 HMAC-SHA256 over `v0:<ts>:<raw body>`
// with the signing secret — POSTs it to the local `valentine slack`, and waits
// for the reply that server sends back through `response_url`, which points at
// this lab. That exercises signature verification, dispatch and the reply path
// with Slack out of the loop. Nothing is faked: a bad secret gets a real 401.
//
// Only the ··· menu ops are simulatable (`rerun` · `copy` · `mute` ·
// `handled`): re-run and copy are read-only, mute/handled touch local state in
// ~/.valentine/mutes.json, and none of them reaches a CRM. A write button's
// value is a `CardAction` JSON and is refused here — with writes switched on,
// `valentine slack` would really write to Salesforce/Attio, and the lab stays
// read-only.

const DEFAULT_SLACK_PORT = 3141;
const SIM_MENU_OPS = new Set(["rerun", "copy", "mute", "handled"]);
/** How long to wait for `response_url` — a `rerun` runs a whole sweep. */
const SIM_REPLY_MS = 45_000;

/** Pending `response_url` callbacks, keyed by the id in the URL we handed out. */
const simReplies = new Map<string, (body: unknown) => void>();

const slackPort = (): number => Number(process.env.VALENTINE_SLACK_PORT || DEFAULT_SLACK_PORT);

/** What the page needs to decide whether the control is usable, and why not. */
function simState(): Record<string, unknown> {
  const cfg = loadConfig();
  const secret = !!cfg.slackSigningSecret?.trim();
  return {
    ready: secret,
    secret,
    port: slackPort(),
    writes: writesEnabled(cfg),
    ops: [...SIM_MENU_OPS],
    reason: secret ? undefined : "no signing secret — set VALENTINE_SLACK_SIGNING_SECRET (or SLACK_SIGNING_SECRET) and reload",
  };
}

interface SimBody {
  action_id?: string;
  value?: string;
  label?: string;
  /** "overflow" puts the value in `selected_option`, like Slack does. */
  kind?: string;
  block_id?: string;
}

async function simulate(body: SimBody): Promise<{ code: number; out: Record<string, unknown> }> {
  const cfg = loadConfig();
  // `valentine slack` accepts a comma-separated list (two Slack apps); sign
  // with the first, which is the one the slash command uses.
  const secret = (cfg.slackSigningSecret ?? "").split(",")[0].trim();
  if (!secret) return { code: 409, out: { ok: false, error: simState().reason } };

  const actionId = String(body.action_id ?? "").trim();
  const value = String(body.value ?? "").trim();
  if (!actionId || !value) return { code: 400, out: { ok: false, error: "action_id and value required" } };
  if (!SIM_MENU_OPS.has(value.split("|")[0]))
    return {
      code: 400,
      out: {
        ok: false,
        error: `only the ··· menu ops are simulatable (${[...SIM_MENU_OPS].join(" · ")}) — a write button would reach the CRM`,
      },
    };

  const port = slackPort();
  const id = randomUUID().slice(0, 8);
  const ts = Math.floor(Date.now() / 1000);
  const stamp = `${ts}.000100`;
  const label = body.label || value;
  const overflow = body.kind === "overflow";
  const payload = {
    type: "block_actions",
    token: "valentine-lab-simulated",
    user: { id: "U0LAB", username: "valentine-lab", name: "valentine-lab", team_id: "T0LAB" },
    api_app_id: "A0LAB",
    team: { id: "T0LAB", domain: "valentine-lab" },
    container: { type: "message", message_ts: stamp, channel_id: "D0LAB", is_ephemeral: true },
    channel: { id: "D0LAB", name: "directmessage" },
    message: { type: "message", ts: stamp, text: "Valentine card — simulated from the Lab" },
    trigger_id: `${ts}.lab.${id}`,
    response_url: `http://127.0.0.1:${labPort}/api/simulate/reply/${id}`,
    actions: [
      {
        type: overflow ? "overflow" : "button",
        action_id: actionId,
        block_id: body.block_id || "lab_sim",
        action_ts: stamp,
        ...(overflow
          ? { selected_option: { text: { type: "plain_text", text: label }, value } }
          : { text: { type: "plain_text", text: label }, value }),
      },
    ],
  };
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;

  // Register the callback before the POST — the ack can beat the await.
  const t0 = Date.now();
  let settle: (v: { body: unknown; ms: number } | undefined) => void = () => {};
  const replied = new Promise<{ body: unknown; ms: number } | undefined>((resolve) => (settle = resolve));
  const timer = setTimeout(() => {
    simReplies.delete(id);
    settle(undefined);
  }, SIM_REPLY_MS);
  timer.unref?.();
  const cancel = () => {
    clearTimeout(timer);
    simReplies.delete(id);
    settle(undefined);
  };
  simReplies.set(id, (b) => {
    clearTimeout(timer);
    simReplies.delete(id);
    settle({ body: b, ms: Date.now() - t0 });
  });

  let ack: { status: number; body: string; ms: number };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": String(ts),
        "X-Slack-Signature": signature,
      },
      body: raw,
    });
    ack = { status: r.status, body: (await r.text()).slice(0, 2000), ms: Date.now() - t0 };
  } catch (e: any) {
    cancel();
    const code = e?.cause?.code ?? e?.code;
    return {
      code: 200,
      out: {
        ok: false,
        reached: false,
        port,
        code,
        error: code === "ECONNREFUSED" ? `valentine slack is not running on :${port}` : String(e?.message ?? e),
        elapsedMs: Date.now() - t0,
        payload,
      },
    };
  }

  // Only a verified request gets acked with 200; anything else never calls back.
  if (ack.status !== 200) cancel();
  const reply = await replied;
  return {
    code: 200,
    out: {
      ok: ack.status === 200,
      reached: true,
      verified: ack.status !== 401,
      port,
      ack,
      reply: reply?.body ?? null,
      replyMs: reply?.ms ?? null,
      timedOut: ack.status === 200 && !reply,
      elapsedMs: Date.now() - t0,
      payload,
    },
  };
}

// ---------------------------------------------------------------- state

async function ollamaJson(host: string, path: string): Promise<any> {
  try {
    const r = await fetch(`${host}${path}`);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

async function state(): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const host = cfg.ollamaHost ?? DEFAULT_OLLAMA_HOST;
  const [tags, ps] = await Promise.all([ollamaJson(host, "/api/tags"), ollamaJson(host, "/api/ps")]);
  let traits: Record<string, unknown> = {};
  try {
    traits = JSON.parse(readFileSync(join(process.env.HOME ?? "", ".valentine", "model-traits.json"), "utf8"));
  } catch {
    /* none yet */
  }
  const loaded = new Set<string>((ps?.models ?? []).map((m: any) => m.name));
  const models = (tags?.models ?? []).map((m: any) => ({
    name: m.name,
    size: m.size,
    family: m.details?.family,
    params: m.details?.parameter_size,
    quant: m.details?.quantization_level,
    loaded: loaded.has(m.name),
    trait: traits[m.name],
    known: OLLAMA_MODELS.find((o) => o.id === m.name)?.label,
  }));
  return {
    version: VERSION,
    config: { crms: activeCrms(cfg), provider: cfg.provider, model: cfg.model, strategy: cfg.strategy ?? "brief", ollamaHost: host, missing: missingCrmCreds(cfg) },
    ollama: { reachable: !!tags, models, loaded: (ps?.models ?? []).map((m: any) => ({ name: m.name, vram: m.size_vram, until: m.expires_at, ctx: m.context_length })) },
    slack: { dm: !!(process.env.VALENTINE_SLACK_BOT_TOKEN && process.env.VALENTINE_SLACK_DM_USER), simulate: simState() },
    benchCases: BENCH_CASES.map((c) => ({ target: c.target, crm: c.crm })),
    knownModels: OLLAMA_MODELS,
    runs: [...runs.values()].map((r) => ({ id: r.id, kind: r.kind, startedAt: r.startedAt, done: r.done, events: r.events.length })),
  };
}

// ---------------------------------------------------------------- http

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) =>
  new Promise<any>((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/lab")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(readFileSync(PAGE));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, await state());

    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = await readBody(req);
      const kind = String(body.kind ?? "sweep");
      const run = newRun(kind);
      json(res, 202, { id: run.id });
      // Detached: the SSE stream carries progress.
      (async () => {
        if (kind === "sweep") {
          if (!body.target) return emit(run, "fatal", { error: "target required" });
          await runSweep(run, body);
          emit(run, "done", {});
        } else if (kind === "bench") await runBench(run, { models: body.models ?? [loadConfig().model], rounds: body.rounds });
        else if (kind === "compare") await runCompare(run, body);
        else if (kind === "meeting") await runMeeting(run, body);
        else emit(run, "fatal", { error: `unknown kind ${kind}` });
      })().catch((e) => emit(run, "fatal", { error: String(e?.message ?? e) }));
      return;
    }

    const m = /^\/api\/runs\/([\w-]+)\/events$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: "no such run" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (run.done) return res.end();
      run.listeners.add(res);
      req.on("close", () => run.listeners.delete(res));
      return;
    }

    // A card button pressed in the lab's Slack preview: sign, POST to
    // `valentine slack`, report the round-trip. Menu ops only — see above.
    if (req.method === "POST" && url.pathname === "/api/simulate") {
      const { code, out } = await simulate(await readBody(req));
      return json(res, code, out);
    }
    // …and the other half of the trip: `valentine slack` answers through the
    // `response_url` we handed it, which is this.
    const back = /^\/api\/simulate\/reply\/([\w-]+)$/.exec(url.pathname);
    if (req.method === "POST" && back) {
      const waiting = simReplies.get(back[1]);
      const body = await readBody(req);
      if (waiting) waiting(body);
      return json(res, 200, { ok: !!waiting });
    }

    if (req.method === "POST" && url.pathname === "/api/notify") {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: "text required" });
      await notify("slack", String(body.title ?? "Valentine Lab"), String(body.text), { blocks: body.blocks });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/calendar") {
      const minutes = Number(url.searchParams.get("minutes") ?? 480);
      const meetings = await new MacosCalendarSource().upcoming(minutes);
      return json(res, 200, meetings.map((mm) => ({ title: mm.title, start: mm.start, calendar: mm.calendar, targets: sweepTargets(mm) })));
    }

    // Slack preview of an arbitrary sweep result is client-side; nothing else here.
    json(res, 404, { error: "not found" });
  } catch (e: any) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

const port = Number(process.env.PORT || 0);
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  const addr = server.address();
  if (typeof addr === "object" && addr) labPort = addr.port;
  const where = process.env.PORTLESS_URL ?? (typeof addr === "object" && addr ? `http://${host}:${addr.port}` : "?");
  if (where !== "?") labUrl = where.replace(/\/+$/, "");
  console.log(`✦ valentine lab ${VERSION} · ${where} · read-only`);
});
