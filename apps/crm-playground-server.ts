// CRM Query Playground — a local, READ-ONLY query console over the CRMs
// Valentine already reads. Serves apps/crm-playground.html and proxies queries
// to Salesforce (via the shared SalesforceSession, so the sid self-refreshes)
// and Attio. Nothing here writes:
//   - Salesforce goes through GET /query only. The query REST resource cannot
//     perform DML; on top of that every statement is validated SELECT-only.
//   - Attio goes through the records `query` endpoint (a read) only.
// Start it portless so no port is ever hardcoded:
//   bun run plans serve --name crm-playground npx tsx apps/crm-playground-server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, activeCrms } from "../src/config.js";
import { SalesforceSession } from "../src/connectors/salesforce.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "crm-playground.html");
const cfg = loadConfig();
const crms = activeCrms(cfg);

// --- Salesforce session (shared refresh-on-401), only if configured ---
const sf =
  cfg.salesforceInstanceUrl && (cfg.salesforceKey || cfg.salesforceSidCommand)
    ? new SalesforceSession({ token: cfg.salesforceKey, command: cfg.salesforceSidCommand }, cfg.salesforceInstanceUrl)
    : undefined;

// --- Attio raw read helper ---
const attioKey = cfg.attioKey;
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/playground")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(readFileSync(PAGE));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, {
        crms,
        salesforce: sf ? { instance: cfg.salesforceInstanceUrl } : null,
        attio: attioKey ? { ok: true } : null,
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
      const col = field === "email" ? "Email" : "Website";
      const esc = (s: string) => s.replace(/(['\\])/g, "\\$1");
      const t0 = Date.now();
      const matched: Record<string, { id: string; name?: string; website?: string }[]> = {};
      try {
        for (let i = 0; i < list.length; i += 100) {
          const chunk = list.slice(i, i + 100);
          const where = chunk.map((d) => (col === "Email" ? `Email LIKE '%@${esc(d)}'` : `Website LIKE '%${esc(d)}%'`)).join(" OR ");
          const sel = col === "Email" ? "Id, Name, Email, Website" : "Id, Name, Website";
          const rows = await sf.soql(`SELECT ${sel} FROM Account WHERE ${where} LIMIT 2000`);
          const want = new Set(chunk);
          for (const r of rows) {
            const h = host(col === "Email" ? r.Email?.split("@")[1] : r.Website);
            if (h && want.has(h)) (matched[h] ??= []).push({ id: r.Id, name: r.Name, website: r.Website });
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
