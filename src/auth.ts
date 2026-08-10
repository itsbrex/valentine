// Auth resolution. API key today. The subscription/OAuth path is stubbed and
// deliberately disabled — Anthropic's Consumer Terms restrict Pro/Max OAuth
// tokens to Anthropic's own products (Claude.ai, Claude Code), and this has
// been actively enforced since early 2026 (see SPEC §10). One place to flip
// in the unlikely event the terms change.

import type { Config } from "./config.js";

export function resolveAuth(cfg: Config): { apiKey: string } {
  if (cfg.authMethod === "subscription") {
    throw new Error(
      "Subscription (Claude Pro/Max) auth isn't available: Anthropic's terms restrict " +
        "Pro/Max tokens to Anthropic's own products, enforced since early 2026. " +
        "Run `valentine init` and choose an API key.",
    );
  }
  const apiKey = cfg.anthropicKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("No Anthropic API key found. Run `valentine init`.");
  return { apiKey };
}
