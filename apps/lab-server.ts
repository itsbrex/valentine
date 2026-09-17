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
import { randomUUID } from "node:crypto";

import { loadConfig, activeCrms, type Config } from "../src/config.js";
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
    const slack = slashMessage(body.target, res, { crms: crmNames, elapsedMs: res.elapsedMs });
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
  const msg = meetingMessage(title, minutes, items, { crms: activeCrms(cfg).map((c) => CRM_LABELS[c]).join(" + "), model: body.model ?? cfg.model, elapsedMs: Date.now() - t0 });
  emit(run, "meeting.result", { title, minutes, text: msg.text, blocks: msg.blocks, elapsedMs: Date.now() - t0 });
  emit(run, "done", {});
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
    slack: { dm: !!(process.env.VALENTINE_SLACK_BOT_TOKEN && process.env.VALENTINE_SLACK_DM_USER) },
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
  const where = process.env.PORTLESS_URL ?? (typeof addr === "object" && addr ? `http://${host}:${addr.port}` : "?");
  console.log(`✦ valentine lab ${VERSION} · ${where} · read-only`);
});
