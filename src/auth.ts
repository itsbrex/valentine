// Auth resolution. API key today. The subscription/OAuth path is stubbed and
// deliberately disabled — Anthropic prohibits third-party tools from using
// Pro/Max subscriptions (see SPEC §10). One place to flip if/when terms allow.

import type { Config } from "./config.js";

export function resolveAuth(cfg: Config): { apiKey: string } {
  if (cfg.authMethod === "subscription") {
    throw new Error(
      "Subscription (Claude Pro/Max) auth isn't supported for third-party tools yet — " +
        "Anthropic's terms prohibit it. Run `valentine init` and choose an API key.",
    );
  }
  const apiKey = cfg.anthropicKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("No Anthropic API key found. Run `valentine init`.");
  return { apiKey };
}
