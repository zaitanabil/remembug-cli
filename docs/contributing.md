# Contributing

Developer setup for working on Remembug itself. If you're just trying to _use_ it, see [quickstart.md](quickstart.md).

The short version of the contribution policy is in [CONTRIBUTING.md](../CONTRIBUTING.md) at the repo root. This file is the deep version: how the codebase is organized, how to run things, and what we look for in a PR.

## Local setup

```bash
git clone https://github.com/zaitanabil/remembug-cli.git
cd remembug
corepack enable           # pins pnpm@9.x via packageManager field
pnpm install
pnpm build
pnpm test
pnpm lint
```

Node ≥20 is required (the `.nvmrc` pins the exact tested minor). If you use `fnm` or `nvm`, both honor `.nvmrc`:

```bash
fnm use     # or: nvm use
```

## Repo layout

```
packages/
  shared/   types + zod schemas. Pure, no I/O.
  daemon/   capture pipeline, scrubber, drafter, store, MCP server.
            Most of the interesting code lives here.
  cli/      commander + ink. Talks to the daemon's store directly for
            read commands; HTTP only for daemon control.
  server/   v0.2 team-sync federation (stub).
hooks/      Tiny Node scripts Claude Code executes on tool events.
docs/       This documentation. Keep it in sync with the code.
```

Cross-package imports work via pnpm workspaces. The dependency graph is intentionally simple: `shared ← daemon ← cli`. `server` depends only on `shared`.

## Running things in development

Daemon, foreground, with debug logging:

```bash
REMEMBUG_LOG=debug pnpm --filter @devzen/remembug-daemon dev
```

CLI against the dev build:

```bash
node packages/cli/dist/index.js search "vitest"
node packages/cli/dist/index.js review
```

MCP server (rarely invoked manually — Claude launches it):

```bash
node packages/daemon/dist/mcp/server.js < /dev/null
```

## Tests

We use Vitest, configured at the repo root in `vitest.config.ts`. Each package's tests live alongside the code as `*.test.ts`.

```bash
pnpm test             # one shot
pnpm test:watch       # watch mode
pnpm vitest scrubber  # filter by name
```

What's well-covered:

- **Scrubber** — 30+ adversarial cases, mostly around false positives (commit SHAs, base64 PNGs, JWT lookalikes).
- **Fingerprint** — canonicalization invariants.
- **Span detector** — span lifecycle, abandon path, multi-session interleaving.
- **Ranker** — RRF ordering, stack-bias tie-breaks.

What's lighter:

- **Drafter** — currently relies on the provider interface being mockable. Property-based tests on the YAML extractor would be welcome.
- **Store** — happy-path coverage. Migration replay tests are a known gap.

If you're adding a feature, the bar is one test per branch of new behavior, and at least one adversarial test if your code touches anything security-sensitive (scrubber, drafter, anything that touches `tool_response`).

## Style

- **TypeScript strict.** No `any` outside test fixtures.
- **ESM only.** No CommonJS in source. Built outputs are ESM.
- **No barrel files** larger than ~20 re-exports.
- **No comments that just restate the code.** Add a comment when the _why_ is non-obvious — invariants, workarounds, references to a spec.

Lint and formatter are authoritative:

```bash
pnpm lint
pnpm format         # writes
pnpm format:check   # CI-style
```

## What a good PR looks like

- One concern per PR. A scrubber pattern addition is one PR; refactoring the scrubber pipeline is a separate one.
- A short description (1–3 paragraphs) of **what** and **why**. The diff shows how.
- Tests for the new behavior, including at least one adversarial case if the change is in the scrubber, fingerprint, or drafter.
- Docs touched if user-visible behavior changed. New flags → `quickstart.md`. New patterns → `privacy.md`. New tools or routes → `claude-code-integration.md`.

## Where to start

Look for `good-first-issue` and `help-wanted` labels in GitHub Issues. Three concrete starter ideas:

1. **`remembug uninstall`** — reverse the `init` patches in `~/.claude/settings.json` and `mcp.json` cleanly. Self-contained, mostly tests.
2. **Ollama provider** — `packages/daemon/src/drafter/providers/` already has the `LLMProvider` interface and an Anthropic implementation. Mirror it for Ollama. Bonus: a smoke test against a local model.
3. **More scrubber patterns.** Common gaps: GCP service-account JSON blobs, Azure connection strings, Twilio auth tokens, npm tokens. Each addition is one entry in `SECRET_PATTERNS` plus 2–3 cases in `scrubber.test.ts`.

## Releasing

Maintainers only. The release workflow in `.github/workflows/release.yml` runs on a tag push:

```bash
pnpm version <patch|minor|major>
git push --follow-tags
```

This builds, tests, lints, and publishes `@devzen/remembug-cli` to npm. The daemon and server packages are not published — `@devzen/remembug-cli` bundles or `npx`-references them as needed.

## Code of conduct

[Contributor Covenant 2.1](../CODE_OF_CONDUCT.md). Be the kind of reviewer you'd want.

## Security

Don't open a public issue for security reports. See [SECURITY.md](../SECURITY.md).
