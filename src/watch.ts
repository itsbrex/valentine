// `valentine watch` — the P1 ambient trigger. Read the calendar, resolve each
// external attendee's domain, sweep the CRM with the same read-only agent as
// the CLI, and surface a heads-up before the meeting starts.
//
//   valentine watch                     poll every 5 min, notify 30 min out
//   valentine watch --once              single pass (cron/launchd-friendly)
//   valentine watch --lead 45           heads-up window in minutes
//   valentine watch --interval 10       poll cadence in minutes
//   valentine watch --notify fullscreen macos (default) | fullscreen | stdout
//
// Calendar layer is provider-agnostic (CalendarSource); macOS Calendar is the
// wired source, which covers Outlook/M365 via Internet Accounts with no Graph
// API access. Each meeting is notified once (state in ~/.valentine/).

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import pc from "picocolors";
import type { Config } from "./config.js";
import { makeConnector, crmKey } from "./connectors/index.js";
import { makeClient } from "./models.js";
import { lookup } from "./agent.js";
import type { Verdict } from "./connectors/types.js";
import type { Meeting } from "./calendar/types.js";
import { MacosCalendarSource } from "./calendar/macos.js";
import { notify, type NotifyChannel } from "./notify.js";

const STATE_FILE = join(homedir(), ".valentine", "watch-state.json");

/** Personal-mail domains — a domain sweep of gmail.com is meaningless. */
export const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "hey.com", "fastmail.com",
]);

const domainOf = (email?: string) => email?.split("@")[1]?.toLowerCase();

/**
 * What to sweep for a meeting: external attendee domains, deduped. Your own
 * side is excluded by the `self` attendee's domain (plus any extra domains
 * passed in). Freemail attendees fall back to a name sweep when we have one.
 */
export function sweepTargets(m: Meeting, ownDomains: Iterable<string> = []): string[] {
  const own = new Set([...ownDomains].map((d) => d.toLowerCase()));
  for (const a of m.attendees) {
    const d = domainOf(a.email);
    if (a.self && d) own.add(d);
  }
  const targets = new Set<string>();
  for (const a of m.attendees) {
    if (a.self) continue;
    const d = domainOf(a.email);
    if (!d || own.has(d)) continue;
    if (FREEMAIL.has(d)) {
      if (a.name) targets.add(a.name);
    } else {
      targets.add(d);
    }
  }
  return [...targets];
}

/** One line per target for the notification body. */
export function verdictLine(target: string, v: Verdict): string {
  const mark = v.verdict === "prior_contact" ? "⚠" : v.verdict === "clean" ? "✅" : "❓";
  return `${mark} ${target} — ${v.summary}`;
}

// --- notified-once state, pruned so it can't grow forever ---

function loadState(): Record<string, number> {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
    return Object.fromEntries(Object.entries(s).filter(([, t]) => Number(t) > cutoff)) as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
}

function saveState(state: Record<string, number>): void {
  mkdirSync(join(homedir(), ".valentine"), { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

// --- the loop ---

function flag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("-") ? args[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function watch(cfg: Config, args: string[] = []): Promise<void> {
  if (process.platform !== "darwin") {
    console.error(
      "valentine watch currently reads the macOS Calendar (which also carries Outlook/M365 " +
        "accounts added in System Settings → Internet Accounts). Other calendar sources: " +
        "see backlog.md — PRs welcome against src/calendar/types.ts.",
    );
    process.exit(1);
  }
  if (!crmKey(cfg) || (cfg.provider === "anthropic" && !cfg.anthropicKey)) {
    console.error("valentine watch: not configured — run `valentine init` first (see --help).");
    process.exit(1);
  }

  const lead = Number(flag(args, "lead") ?? 30);
  const interval = Number(flag(args, "interval") ?? 5);
  const channel = (flag(args, "notify") ?? "macos") as NotifyChannel;
  const once = args.includes("--once");

  const source = new MacosCalendarSource();
  const crm = makeConnector(cfg);
  const client = makeClient(cfg);

  console.log(
    pc.magenta(pc.bold("✦ valentine watch")) +
      pc.dim(
        `  ${source.name} · heads-up ${lead} min out · ${channel}` +
          (once ? " · single pass" : ` · every ${interval} min`),
    ),
  );

  const state = loadState();

  do {
    let meetings: Meeting[] = [];
    try {
      meetings = await source.upcoming(lead);
    } catch (e: any) {
      console.error(pc.red(e.message));
      process.exit(1);
    }

    for (const m of meetings) {
      if (state[m.id]) continue;
      const targets = sweepTargets(m).slice(0, 3); // cap the model spend per meeting
      if (targets.length === 0) continue;

      const mins = Math.max(1, Math.round((m.start - Date.now()) / 60000));
      console.log(pc.dim(`sweeping for "${m.title}" (${mins} min out): ${targets.join(", ")}`));

      const lines: string[] = [];
      for (const t of targets) {
        try {
          lines.push(verdictLine(t, await lookup(client, cfg.model, crm, t)));
        } catch (e: any) {
          lines.push(`❓ ${t} — sweep failed: ${e.message?.slice(0, 80)}`);
        }
      }

      await notify(channel, `${m.title} in ${mins} min`, lines.join("\n"));
      state[m.id] = Date.now();
      saveState(state);
    }

    if (!once) await sleep(interval * 60 * 1000);
  } while (!once);
}
