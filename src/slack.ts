// `valentine slack` — the /valentine slash command (P2 trigger) and the
// interactivity endpoint for the card's buttons. A tiny HTTP server for
// Slack's webhooks: verify the signing secret, ack within Slack's 3-second
// window, sweep with the same read-only agent, then deliver the verdict
// through Slack's response_url — ephemeral, visible only to whoever asked.
// No bot token needed; it cannot post anywhere on its own.
//
// Two request shapes land here, both signed the same way:
//   slash command   form body with `text` + `response_url`
//   block_actions   form body with `payload=<json>` — a button or ··· menu on
//                   a card. Menu ops are local (re-run, copy id, mute,
//                   handled). Write buttons only exist on cards rendered with
//                   writes on, and the handler refuses them otherwise.
//
// Setup: Slack app → Slash Commands → /valentine → Request URL = this server;
// Interactivity & Shortcuts → Request URL = the same server (expose it with
// ngrok/cloudflared or run it on a host Slack can reach). For buttons on the
// `watch --notify slack` DMs, point that app's Interactivity URL here too and
// list its signing secret as well (comma-separated).
// Env: VALENTINE_SLACK_SIGNING_SECRET (required; comma list allowed) ·
// VALENTINE_SLACK_PORT (default 3141, or --port) · VALENTINE_WRITES.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import pc from "picocolors";
import type { Config } from "./config.js";
import { missingCrmCreds } from "./connectors/index.js";
import { makeClient, type ModelClient } from "./models.js";
import { sweepAll, CRM_LABELS, type SweepResult } from "./sweep.js";
import { activeCrms, writesEnabled } from "./config.js";
import { slashMessage } from "./slackblocks.js";
import { handleCardAction, handleMenu, handleNote, parseActionValue, type ActionReply } from "./slackactions.js";
import type { Verdict } from "./connectors/types.js";

const DEFAULT_PORT = 3141;

function flag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

/** Slack request signing (v0): HMAC-SHA256 over `v0:<ts>:<raw body>`. Several
 *  secrets (comma-separated) let one server answer two Slack apps — the slash
 *  command's and the DM bot's — so buttons work on both. */
export function verifySignature(secrets: string, req: Pick<IncomingMessage, "headers">, raw: string): boolean {
  const ts = String(req.headers["x-slack-request-timestamp"] ?? "");
  const sig = String(req.headers["x-slack-signature"] ?? "");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard
  const b = Buffer.from(sig);
  return secrets
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((secret) => {
      const a = Buffer.from("v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex"));
      return a.length === b.length && timingSafeEqual(a, b);
    });
}

/** A block_actions payload → one reply. Exported for tests; no HTTP here. */
export async function handleInteraction(cfg: Config, client: ModelClient, payload: any): Promise<ActionReply> {
  if (payload?.type !== "block_actions") return { text: "⛔ Unsupported interaction." };
  const a = payload.actions?.[0];
  const raw: string | undefined = a?.selected_option?.value ?? a?.value;
  const parsed = parseActionValue(raw);
  if (!parsed) return { text: "⛔ That button carries nothing Valentine understands." };
  const user: string | undefined = payload.user?.username ?? payload.user?.name ?? payload.user?.id;
  if ("menu" in parsed) return handleMenu(cfg, client, parsed.menu, parsed.args);
  return handleCardAction(cfg, parsed, { user });
}

/** Verdict → Slack mrkdwn, mirroring the CLI's renderVerdict without ANSI codes. */
function verdictText(v: Verdict): string {
  const lines = [v.summary];
  const meta: string[] = [];
  if (v.owner) meta.push(`Owner: ${v.owner}`);
  if (v.lastTouch) meta.push(`Last touch: ${v.lastTouch}`);
  if (v.status) meta.push(`Status: ${v.status}`);
  if (meta.length) lines.push(meta.join(" · "));
  if (v.citations.length) lines.push(`Records: ${v.citations.join(", ")}`);
  return lines.join("\n");
}

const headFor = (v: Verdict): string =>
  v.verdict === "prior_contact"
    ? "⚠ *Prior contact*"
    : v.verdict === "clean"
      ? "✅ *Clear*"
      : "❓ *Ambiguous*";

/** Sweep → mrkdwn. Single CRM keeps the old shape; multi gets one labeled
 *  section per CRM under a combined headline. */
function slackText(res: SweepResult, target: string): string {
  if (res.sources.length === 1)
    return [`${headFor(res.combined)} — ${target}`, verdictText(res.combined)].join("\n");
  const sections = res.sources.map(
    ({ crm, ...v }) => `*${CRM_LABELS[crm]}* — ${headFor(v)}\n${verdictText(v)}`,
  );
  return [`${headFor(res.combined)} — ${target}`, ...sections].join("\n\n");
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
  const missing = missingCrmCreds(cfg);
  if (missing.length || (cfg.provider === "anthropic" && !cfg.anthropicKey)) {
    console.error(
      `valentine slack: ${missing.length ? `credentials missing for ${missing.join(", ")}` : "model key missing"} — ` +
        "run `valentine init` or set the env vars (see --help).",
    );
    process.exit(1);
  }

  const port = Number(flag(args, "port") ?? process.env.VALENTINE_SLACK_PORT ?? DEFAULT_PORT);
  const client = makeClient(cfg);
  const writes = writesEnabled(cfg);
  const crms = activeCrms(cfg).map((c) => CRM_LABELS[c]).join(" + ");

  const respond = (responseUrl: string, body: Record<string, unknown>) =>
    fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", ...body }),
    }).catch(() => {
      /* Slack retracted the response_url (30-min TTL) — nothing to do */
    });

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

      // --- a button / ··· menu on a card (Interactivity request URL)
      const interaction = form.get("payload");
      if (interaction) {
        let payload: any;
        try {
          payload = JSON.parse(interaction);
        } catch {
          res.writeHead(400).end("bad payload");
          return;
        }
        res.writeHead(200).end(); // ack; the outcome follows via response_url
        const responseUrl: string | undefined = payload?.response_url;
        if (!responseUrl) return;
        const reply = await handleInteraction(cfg, client, payload);
        await respond(responseUrl, reply.replace ? { replace_original: true, text: reply.text, blocks: reply.blocks } : { replace_original: false, text: reply.text, ...(reply.blocks ? { blocks: reply.blocks } : {}) });
        return;
      }

      // --- the slash command
      const text = (form.get("text") ?? "").trim();
      const responseUrl = form.get("response_url");
      if (!text || !responseUrl) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(ephemeral(`Usage: \`/valentine acme.com\` — a domain or a company/founder name.${writes ? " `/valentine note acme.com <text>` adds a note to the record." : ""}`));
        return;
      }

      // `/valentine note <target> <text…>` — the one write the slash command itself offers.
      const note = /^note\s+(\S+)\s*([\s\S]*)$/i.exec(text);
      if (note) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(ephemeral(writes ? `📝 adding a note to *${note[1]}*…` : "⛔ Writes are off on this Valentine."));
        if (!writes) return;
        const reply = await handleNote(cfg, client, note[1], note[2], { user: form.get("user_name") ?? undefined });
        await respond(responseUrl, { replace_original: true, text: reply.text });
        return;
      }

      const target = text;
      // Ack inside the 3-second window; the sweep result follows via response_url.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(ephemeral(`🔍 sweeping fund memory for *${target}*…`));

      // Block Kit reply with a mrkdwn fallback (`text`) for clients that
      // cannot render blocks — the old plain rendering, unchanged. The card is
      // interactive because this very server answers its buttons.
      let payload: { text: string; blocks?: unknown[] };
      try {
        const res = await sweepAll(client, cfg, target);
        const rich = slashMessage(target, res, { crms, elapsedMs: res.elapsedMs, writes }, { interactive: { writes } });
        payload = { text: slackText(res, target), blocks: rich.blocks };
      } catch (e: any) {
        payload = { text: `Sweep failed: ${e?.message ?? e}` };
      }
      await respond(responseUrl, { replace_original: true, ...payload });
    });
  });

  server.listen(port, () => {
    console.log(
      pc.magenta(pc.bold("✦ valentine slack")) +
        pc.dim(
          `  listening on :${port} — point your /valentine slash command and Interactivity URL here.\n` +
            (writes ? "writes ON (each behind a confirm dialog)" : "read-only") +
            " · replies only to the asker · never posts on its own",
        ),
    );
  });
}
