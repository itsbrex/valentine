// `valentine slack` — the /valentine slash command (P2 trigger). A tiny HTTP
// server for Slack's slash-command webhook: verify the signing secret, ack
// within Slack's 3-second window, sweep with the same read-only agent, then
// deliver the verdict through Slack's response_url — ephemeral, visible only
// to whoever asked. No bot token needed; it cannot post anywhere on its own.
//
// Setup: Slack app → Slash Commands → /valentine → point the Request URL at
// this server (expose it with ngrok/cloudflared or run it on a host Slack can
// reach). Env: VALENTINE_SLACK_SIGNING_SECRET (required) ·
// VALENTINE_SLACK_PORT (default 3141, or --port).

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import pc from "picocolors";
import type { Config } from "./config.js";
import { makeConnector, crmKey } from "./connectors/index.js";
import { makeClient } from "./models.js";
import { lookup } from "./agent.js";
import type { Verdict } from "./connectors/types.js";

const DEFAULT_PORT = 3141;

function flag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

/** Slack request signing (v0): HMAC-SHA256 over `v0:<ts>:<raw body>`. */
function verifySignature(secret: string, req: IncomingMessage, raw: string): boolean {
  const ts = String(req.headers["x-slack-request-timestamp"] ?? "");
  const sig = String(req.headers["x-slack-signature"] ?? "");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard
  const expected = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verdict → Slack mrkdwn, mirroring the CLI's renderVerdict without ANSI codes. */
function slackText(v: Verdict, target: string): string {
  const head =
    v.verdict === "prior_contact"
      ? "⚠ *Prior contact*"
      : v.verdict === "clean"
        ? "✅ *Clear*"
        : "❓ *Ambiguous*";
  const lines = [`${head} — ${target}`, v.summary];
  const meta: string[] = [];
  if (v.owner) meta.push(`Owner: ${v.owner}`);
  if (v.lastTouch) meta.push(`Last touch: ${v.lastTouch}`);
  if (v.status) meta.push(`Status: ${v.status}`);
  if (meta.length) lines.push(meta.join(" · "));
  if (v.citations.length) lines.push(`Records: ${v.citations.join(", ")}`);
  return lines.join("\n");
}

const ephemeral = (text: string) => JSON.stringify({ response_type: "ephemeral", text });

export async function runSlack(cfg: Config, args: string[]): Promise<void> {
  const secret = cfg.slackSigningSecret;
  if (!secret) {
    console.error(
      "valentine slack: set VALENTINE_SLACK_SIGNING_SECRET " +
        "(Slack app → Basic Information → Signing Secret).",
    );
    process.exit(1);
  }
  if (!crmKey(cfg) || (cfg.provider === "anthropic" && !cfg.anthropicKey)) {
    console.error(
      "valentine slack: CRM/model keys missing — run `valentine init` or set the env vars (see --help).",
    );
    process.exit(1);
  }

  const port = Number(flag(args, "port") ?? process.env.VALENTINE_SLACK_PORT ?? DEFAULT_PORT);
  const crm = makeConnector(cfg); // throws early on missing pieces (e.g. instance URL)
  const client = makeClient(cfg);

  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (!verifySignature(secret, req, raw)) {
        res.writeHead(401).end("bad signature");
        return;
      }
      const form = new URLSearchParams(raw);
      const target = (form.get("text") ?? "").trim();
      const responseUrl = form.get("response_url");
      if (!target || !responseUrl) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(ephemeral("Usage: `/valentine acme.com` — a domain or a company/founder name."));
        return;
      }

      // Ack inside the 3-second window; the sweep result follows via response_url.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(ephemeral(`🔍 sweeping fund memory for *${target}*…`));

      let text: string;
      try {
        text = slackText(await lookup(client, cfg.model, crm, target), target);
      } catch (e: any) {
        text = `Sweep failed: ${e?.message ?? e}`;
      }
      await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_type: "ephemeral", replace_original: true, text }),
      }).catch(() => {
        /* Slack retracted the response_url (30-min TTL) — nothing to do */
      });
    });
  });

  server.listen(port, () => {
    console.log(
      pc.magenta(pc.bold("✦ valentine slack")) +
        pc.dim(
          `  listening on :${port} — point your /valentine slash command here.\n` +
            "read-only · replies only to the asker · never posts on its own",
        ),
    );
  });
}
