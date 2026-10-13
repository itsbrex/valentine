# Contributing to Valentine

Valentine is deliberately small: a hand-rolled agent loop, one connector
interface, and a handful of files you can read in one sitting. Contributions
that keep it that way are the most welcome kind.

## Setup

```bash
git clone https://github.com/80x-djh/valentine.git
cd valentine
npm install
npm run dev -- --help     # run the CLI from source (tsx)
```

## Checks

Both must pass before a PR:

```bash
npx tsc --noEmit          # typecheck
npm test                  # node:test suite via tsx
```

CI runs the same two commands on every push and pull request.

## Adding a CRM connector

This is the most useful contribution and it is exactly one file.

1. Create `src/connectors/<crm>.ts` implementing `CRMConnector` from
   `src/connectors/types.ts` — `whoami()`, `search()`, and `getContext()`.
   The contract has **no mutating methods, by design**; a connector that
   writes to the CRM will not be merged.
2. Register it in `makeConnector()` and `crmKey()` in
   `src/connectors/index.ts`, and add its config/env key to `src/config.ts`
   (`VALENTINE_<CRM>_KEY`, filled from env, never written back to disk).
3. Offer it in the `init` wizard in `src/cli.ts` and document the env var in
   `AGENTS.md` and `.env.example`.
4. Add a fetch-mocked test in `test/connectors.test.ts` following the
   existing pattern: assert the request your connector makes and the
   `CRMMatch`/`CRMContext` shapes it returns from a canned API response.
   If you have a live workspace, captured real response shapes make the
   best fixtures.

Degrade gracefully: missing attributes, unknown objects, and permission
errors should produce empty results, never a crash — see
`src/connectors/attio.ts` for the pattern.

## Style

- Keep files small and single-purpose; the whole `src/` tree is meant to be
  auditable in minutes.
- Comments explain *why*, not *what*.
- No new runtime dependencies without a strong reason — the dependency list
  is part of the security story.

## Releases

Versions are bumped in `package.json` and `src/version.ts` together.
Publishing to npm is done manually by the package owner.
