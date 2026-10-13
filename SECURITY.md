# Security Policy

Valentine handles live CRM credentials and an Anthropic API key, and its
pitch is "clone it, read every line". Security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting: on the repository page, go to
**Security → Report a vulnerability**. Reports go directly to the
maintainers and stay private until a fix is released.

Include what you can: affected file/line, reproduction steps, and impact.
You will get an acknowledgement within a few days.

## Scope

Things we consider vulnerabilities:

- Anything that makes Valentine **write** to a CRM — the connector contract
  (`src/connectors/types.ts`) is read-only by design.
- Credential exposure: keys leaking into files, logs, process listings, or
  network destinations other than the configured CRM/model provider.
- Slack request-signature bypass in `src/slack.ts`.
- Prompt-injection paths that let CRM data exfiltrate credentials or alter
  the verdict contract beyond its documented shape.

Out of scope: vulnerabilities in the CRMs, model providers, or npm
dependencies themselves (report those upstream), and social engineering.

## Supported versions

Only the latest published release receives security fixes.
