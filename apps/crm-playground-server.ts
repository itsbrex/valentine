// CRM Query Playground — a local, READ-ONLY query console over the CRMs
// Valentine already reads. Serves apps/crm-playground.html and proxies queries
// to Salesforce (via the shared SalesforceSession, so the sid self-refreshes)
// and Attio. Nothing here writes:
//   - Salesforce goes through GET /query only. The query REST resource cannot
//     perform DML; on top of that every statement is validated SELECT-only.
//   - Attio goes through the records `query` endpoint (a read) only.
// The one local write: saved grid views (filters, sorts, hidden columns) go to
// ~/.valentine/playground-views.json, never to a CRM.
// Start it portless so no port is ever hardcoded:
//   bun run plans serve --name crm-playground npx tsx apps/crm-playground-server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, activeCrms } from "../src/config.js";
import { SalesforceSession } from "../src/connectors/salesforce.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "crm-playground.html");
// Local review exports (gitignored). Served read-only from this one folder, by
// basename only — the name regex blocks any path separator or traversal.
const REVIEW = join(HERE, "..", "review-local");
// Saved grid views, keyed by dataset ("csv:<file>", "query:salesforce", "bulk").
// Each dataset keeps the last grid state (restored on load) and named views.
const VIEWS = process.env.VALENTINE_PLAYGROUND_VIEWS ?? join(homedir(), ".valentine", "playground-views.json");
type ViewsDoc = { version: 1; datasets: Record<string, { last?: unknown; views?: { name: string; state: unknown; updatedAt: string }[] }> };
async function loadViews(): Promise<ViewsDoc> {
  try {
    const d = JSON.parse(await readFile(VIEWS, "utf8"));
    if (d && typeof d === "object" && d.datasets && typeof d.datasets === "object") return { version: 1, datasets: d.datasets };
  } catch {}
  return { version: 1, datasets: {} };
}
// Read-modify-write runs one at a time, and the file is replaced atomically
// (temp file + rename), so two tabs saving at once never interleave a write.
let viewsQueue: Promise<unknown> = Promise.resolve();
function updateViews(fn: (d: ViewsDoc) => void): Promise<ViewsDoc> {
  const run = viewsQueue.then(async () => {
    const d = await loadViews();
    fn(d);
    await mkdir(dirname(VIEWS), { recursive: true, mode: 0o700 });
    const tmp = `${VIEWS}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    await rename(tmp, VIEWS);
    return d;
  });
  viewsQueue = run.catch(() => {});
  return run;
}

const cfg = loadConfig();
const crms = activeCrms(cfg);

// --- Salesforce session (shared refresh-on-401), only if configured ---
const sf =
  cfg.salesforceInstanceUrl && (cfg.salesforceKey || cfg.salesforceSidCommand)
    ? new SalesforceSession({ token: cfg.salesforceKey, command: cfg.salesforceSidCommand }, cfg.salesforceInstanceUrl)
    : undefined;

// --- Attio raw read helper ---
const attioKey = cfg.attioKey;
let attioSlug: string | undefined;
async function attioWorkspaceSlug(): Promise<string | undefined> {
  if (attioSlug !== undefined || !attioKey) return attioSlug;
  try {
    const res = await fetch("https://api.attio.com/v2/self", { headers: { Authorization: `Bearer ${attioKey}` } });
    const body = await res.json();
    const s = body?.data ?? body;
    attioSlug = s?.workspace_slug ?? "";
  } catch {
    attioSlug = "";
  }
  return attioSlug;
}
async function attioQuery(object: string, filter: unknown, limit: number, offset: number): Promise<any[]> {
  if (!attioKey) throw new Error("Attio not configured");
  if (!/^[a-z_]+$/.test(object)) throw new Error("bad object");
  const res = await fetch(`https://api.attio.com/v2/objects/${object}/records/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${attioKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...(filter ? { filter } : {}), limit: Math.min(limit || 25, 500), offset: offset || 0 }),
  });
  if (!res.ok) throw new Error(`Attio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())?.data ?? [];
}

/** SELECT-only guard. The /query endpoint can't write anyway; this rejects
 *  early and clearly, and blocks the obvious footguns. */
function assertSelect(q: string): void {
  const s = q.trim().replace(/^\(+/, "");
  if (!/^select\s/i.test(s)) throw new Error("Only SELECT queries are allowed (this console is read-only).");
  if (/\b(insert|update|delete|upsert|merge|undelete)\b/i.test(q)) throw new Error("Write keyword rejected — read-only console.");
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) =>
  new Promise<any>((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

function host(u?: string): string | undefined {
  if (!u) return undefined;
  const h = String(u).trim().toLowerCase().split("//").pop()!.split("/")[0];
  return h.startsWith("www.") ? h.slice(4) : h || undefined;
}

// The 18 Ownership Desk Account fields (verified on the cresa org). SOQL column
// → friendly name. Probe-tiered: an org missing the custom fields answers
// INVALID_FIELD once, then this drops to the standard subset for the session.
const ACCT18: [string, string][] = [
  ["Id", "sf_id"], ["Name", "sf_name"], ["Website", "website"], ["Type", "account_type"],
  ["OwnerId", "owner_id"], ["Owner.Name", "owner"], ["Account_Owner_s_Email__c", "owner_email"],
  ["Account_Owner_Territory_s__c", "owner_territories"], ["LastActivityDate", "last_activity"],
  ["Inactivity_Date__c", "inactivity_date"], ["BillingCity", "hq_city"], ["BillingState", "hq_state"],
  ["BillingCountry", "hq_country"], ["ZoomInfo_Number_of_Locations__c", "zi_locations"],
  ["Portfolio_Locations__c", "portfolio_locations"], ["of_Locations__c", "num_locations"],
  ["NumberOfEmployees", "employees"], ["AnnualRevenue", "annual_revenue"],
];
const ACCT18_BARE: [string, string][] = [["Id", "sf_id"], ["Name", "sf_name"], ["Website", "website"], ["OwnerId", "owner_id"], ["Owner.Name", "owner"], ["LastActivityDate", "last_activity"]];
let acctFull = true;
function flatAcct(r: any, map: [string, string][]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [col, name] of map) {
    let v: any = r;
    for (const p of col.split(".")) v = v && typeof v === "object" ? v[p] : undefined;
    o[name] = v ?? "";
  }
  return o;
}
/** Batched Account read with the 18-field set, falling back to bare once. */
async function acctBatch(where: string): Promise<{ rows: any[]; map: [string, string][] }> {
  if (acctFull) {
    try {
      const rows = await sf!.soql(`SELECT ${ACCT18.map((f) => f[0]).join(", ")} FROM Account WHERE ${where} LIMIT 2000`);
      return { rows, map: ACCT18 };
    } catch (e: any) {
      if (!/INVALID_FIELD|No such column|FIELD_INTEGRITY/i.test(String(e?.message))) throw e;
      acctFull = false;
    }
  }
  const rows = await sf!.soql(`SELECT ${ACCT18_BARE.map((f) => f[0]).join(", ")} FROM Account WHERE ${where} LIMIT 2000`);
  return { rows, map: ACCT18_BARE };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/playground")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(readFileSync(PAGE));
      return;
    }

    // List the CSVs in review-local/ (basename + size + approx row count).
    if (req.method === "GET" && url.pathname === "/api/files") {
      try {
        const files = readdirSync(REVIEW)
          .filter((f) => /\.csv$/i.test(f))
          .map((f) => {
            const p = join(REVIEW, f);
            let rows = 0;
            try { rows = Math.max(0, readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length - 1); } catch {}
            return { name: f, size: statSync(p).size, rows };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        return json(res, 200, { files });
      } catch {
        return json(res, 200, { files: [] });
      }
    }

    // Serve one CSV's raw text. basename only — no separators, no traversal.
    if (req.method === "GET" && url.pathname === "/api/file") {
      const name = url.searchParams.get("name") ?? "";
      if (!/^[\w.-]+\.csv$/i.test(name)) return json(res, 400, { error: "bad file name" });
      const p = join(REVIEW, name);
      if (!p.startsWith(REVIEW + "/")) return json(res, 400, { error: "outside review folder" });
      try {
        const text = readFileSync(p, "utf8");
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" });
        res.end(text);
      } catch {
        json(res, 404, { error: "not found" });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/views") {
      return json(res, 200, await loadViews());
    }

    // Merge one dataset's `last` state and/or its `views` list. Only fields
    // present in the body change; `last: null` forgets the remembered state.
    if (req.method === "POST" && url.pathname === "/api/views") {
      const body = await readBody(req);
      const key = body?.key;
      if (typeof key !== "string" || !key || key.length > 300) return json(res, 400, { error: "bad key" });
      if (JSON.stringify(body).length > 1_000_000) return json(res, 413, { error: "too large" });
      if ("views" in body && !Array.isArray(body.views)) return json(res, 400, { error: "views must be an array" });
      const doc = await updateViews((d) => {
        const ds = (d.datasets[key] ??= {});
        if ("last" in body) { if (body.last == null) delete ds.last; else ds.last = body.last; }
        if ("views" in body) {
          ds.views = body.views
            .filter((v: any) => v && typeof v.name === "string" && v.name.trim())
            .map((v: any) => ({ name: String(v.name).trim().slice(0, 80), state: v.state ?? {}, updatedAt: v.updatedAt || new Date().toISOString() }));
        }
        if (!ds.last && !ds.views?.length) delete d.datasets[key];
      });
      return json(res, 200, { ok: true, dataset: doc.datasets[key] ?? {} });
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, {
        crms,
        salesforce: sf ? { instance: cfg.salesforceInstanceUrl } : null,
        attio: attioKey ? { ok: true, slug: await attioWorkspaceSlug() } : null,
        readOnly: true,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/soql") {
      if (!sf) return json(res, 400, { error: "Salesforce is not configured" });
      const { q } = await readBody(req);
      if (typeof q !== "string" || !q.trim()) return json(res, 400, { error: "empty query" });
      try {
        assertSelect(q);
        const t0 = Date.now();
        const rows = await sf.soql(q);
        return json(res, 200, { rows, count: rows.length, elapsedMs: Date.now() - t0 });
      } catch (e: any) {
        return json(res, 200, { error: String(e?.message ?? e) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/attio") {
      const { object, filter, limit, offset } = await readBody(req);
      try {
        const t0 = Date.now();
        const rows = await attioQuery(object ?? "companies", filter, limit ?? 25, offset ?? 0);
        return json(res, 200, { rows, count: rows.length, elapsedMs: Date.now() - t0 });
      } catch (e: any) {
        return json(res, 200, { error: String(e?.message ?? e) });
      }
    }

    // Bulk domain existence check: one batched SOQL over up to 100 domains,
    // broad LIKE + exact host post-filter. Read-only; the accuracy trick from
    // SOQL_QUERIES.md, exposed as a button.
    if (req.method === "POST" && url.pathname === "/api/bulk") {
      if (!sf) return json(res, 400, { error: "Salesforce is not configured" });
      const { domains, field } = await readBody(req);
      const list: string[] = Array.isArray(domains)
        ? domains.map((d) => String(d).trim().toLowerCase()).filter((d) => d.includes("."))
        : [];
      if (!list.length) return json(res, 400, { error: "no domains" });
      const useEmail = field === "email";
      const esc = (s: string) => s.replace(/(['\\])/g, "\\$1");
      const t0 = Date.now();
      // Each matched account carries the full 18-field Ownership Desk set.
      const matched: Record<string, Record<string, unknown>[]> = {};
      try {
        for (let i = 0; i < list.length; i += 100) {
          const chunk = list.slice(i, i + 100);
          const where = chunk.map((d) => (useEmail ? `Account_Owner_s_Email__c LIKE '%@${esc(d)}'` : `Website LIKE '%${esc(d)}%'`)).join(" OR ");
          const { rows, map } = await acctBatch(where);
          const want = new Set(chunk);
          for (const r of rows) {
            const h = useEmail ? host(String(r.Account_Owner_s_Email__c ?? "").split("@")[1]) : host(r.Website);
            if (h && want.has(h)) (matched[h] ??= []).push(flatAcct(r, map));
          }
        }
      } catch (e: any) {
        return json(res, 200, { error: String(e?.message ?? e) });
      }
      const inSf = Object.keys(matched);
      const notInSf = list.filter((d) => !matched[d]);
      const dupes = Object.fromEntries(Object.entries(matched).filter(([, v]) => v.length > 1));
      return json(res, 200, {
        checked: list.length,
        matched: matched,
        summary: {
          checked: list.length,
          in_salesforce: inSf.length,
          not_in_salesforce: notInSf.length,
          duplicates: Object.keys(dupes).length,
        },
        notInSf,
        dupes,
        elapsedMs: Date.now() - t0,
      });
    }

    res.writeHead(404).end("not found");
  } catch (e: any) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

const port = Number(process.env.PORT || 0);
server.listen(port, process.env.HOST || "127.0.0.1", () => {
  const a = server.address();
  const where = process.env.PORTLESS_URL || (a && typeof a === "object" ? `http://127.0.0.1:${a.port}` : "");
  console.log(`✦ CRM query playground · ${where} · read-only · ${crms.join(" + ")}`);
});
