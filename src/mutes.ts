// Local, non-CRM state behind the card's overflow menu: "Mute domain 30d" and
// "Mark handled". Lives in ~/.valentine/mutes.json next to the watch state —
// never in the CRM. The watch loop skips muted domains and anything marked
// handled in the last day, so a heads-up you've dealt with doesn't come back
// on the next sweep.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface Mutes {
  /** domain → epoch ms the mute expires. */
  muted: Record<string, number>;
  /** target → epoch ms it was marked handled. */
  handled: Record<string, number>;
}

const DAY = 24 * 60 * 60 * 1000;
export const HANDLED_TTL = DAY;

export function mutesFile(): string {
  return process.env.VALENTINE_MUTES_FILE ?? join(homedir(), ".valentine", "mutes.json");
}

export function loadMutes(file = mutesFile()): Mutes {
  const empty: Mutes = { muted: {}, handled: {} };
  if (!existsSync(file)) return empty;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const now = Date.now();
    const muted: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw?.muted ?? {})) if (typeof v === "number" && v > now) muted[k] = v;
    const handled: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw?.handled ?? {})) if (typeof v === "number" && now - v < HANDLED_TTL) handled[k] = v;
    return { muted, handled };
  } catch {
    return empty;
  }
}

export function saveMutes(m: Mutes, file = mutesFile()): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(m, null, 2), { mode: 0o600 });
}

export function mute(domain: string, days = 30, file = mutesFile()): Mutes {
  const m = loadMutes(file);
  m.muted[domain.toLowerCase()] = Date.now() + days * DAY;
  saveMutes(m, file);
  return m;
}

export function markHandled(target: string, file = mutesFile()): Mutes {
  const m = loadMutes(file);
  m.handled[target.toLowerCase()] = Date.now();
  saveMutes(m, file);
  return m;
}

/** True when a target should be skipped: muted, or handled within a day. */
export function isQuiet(target: string, m: Mutes = loadMutes()): boolean {
  const t = target.toLowerCase();
  return !!m.muted[t] || !!m.handled[t];
}
