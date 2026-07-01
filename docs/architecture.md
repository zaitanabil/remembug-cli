# Architecture

This is the design doc. If you're trying to use Remembug, read [quickstart.md](quickstart.md) first.

## One-paragraph summary

Remembug is a Node-only, local-first capture pipeline plus an MCP server. Claude Code's `PostToolUse` and `Stop` hooks POST events to a loopback HTTP daemon. The daemon detects "problem spans" (failure → resolution), scrubs the transcript, asks an LLM to draft a Q&A entry, and stores it in SQLite as `pending_review`. A small Ink TUI lets the user accept/edit/reject drafts. Accepted entries become searchable through an MCP stdio server that exposes `remembug.search`, `remembug.get`, and `remembug.feedback` back to Claude. Everything lives in `~/.remembug/`.

## Topology

```
 ┌─────────────────────────┐         ┌───────────────────────────────┐
 │ Claude Code             │         │ Remembug daemon (long-running)   │
 │   PostToolUse hook ──┐  │         │                               │
 │   Stop hook ─────────┼──┼─POST──▶ │  http.ts (127.0.0.1:7842)     │
 │                      │  │         │     ↓                         │
 └─────────────────────────┘         │  SpanDetector  (in-memory)    │
                                     │     ↓ onResolved              │
                                     │  Scrubber                     │
                                     │     ↓                         │
                                     │  Drafter (LLM)                │
                                     │     ↓                         │
                                     │  Store (SQLite + FTS5 + vec)  │
                                     └──────────────┬────────────────┘
                                                    │
                                ┌───────────────────┴────────────────┐
                                ↓                                    ↓
                       ┌────────────────┐                  ┌──────────────────┐
                       │ remembug review   │                  │ remembug-mcp        │
                       │ (Ink TUI)      │                  │ (stdio server)   │
                       └────────┬───────┘                  └────────┬─────────┘
                                │ accept                            │ tools
                                ↓                                   ↓
                       status='published'                  Claude Code
```

## Processes

| Process                    | Lifetime                                        | Talks to                                |
| -------------------------- | ----------------------------------------------- | --------------------------------------- |
| `remembug daemon`          | Long-running (user-managed)                     | HTTP on 127.0.0.1; SQLite; LLM provider |
| `remembug-mcp`             | One per Claude Code session (spawned by Claude) | stdio (MCP); SQLite (read-mostly)       |
| `remembug review`          | One-shot interactive                            | SQLite                                  |
| Hook shims (`hooks/*.mjs`) | One-shot per tool call                          | HTTP to daemon                          |

Two processes (`daemon`, `mcp`) reach the same SQLite file. `better-sqlite3` opens both with `journal_mode=WAL`, which permits a single writer plus many readers without lock contention in practice.

## Package layout

```
packages/
  shared/    types + zod schemas. No runtime deps beyond zod.
  daemon/    capture, scrubber, fingerprint, drafter, store, mcp, http.
             Also exports the bin entrypoints used by `remembug daemon`.
  cli/       commander + ink. Imports daemon-internal modules for store + paths.
  server/    v0.2 team-sync server. Stub only.
hooks/
  *.mjs      Tiny Node scripts that Claude Code's hook system executes.
```

The CLI deliberately imports daemon internals rather than going through HTTP for read operations like `remembug review` and `remembug search` — those don't need the daemon running, just the SQLite file.

## The capture pipeline

### Span detection

`SpanDetector` keeps an in-memory map of `session_id → OpenSpan`. A `PostToolUse` payload with `exit_code !== 0` (or `error`, or stderr containing common failure tokens) opens a span. A subsequent success of the **same `tool_name`** closes it as `resolved` and emits `onResolved`. A `Stop` event without resolution emits `onAbandoned`.

This heuristic intentionally favors precision over recall — we'd rather miss a draft than fill the KB with non-resolutions. The drafter is also given another chance to refuse with `REFUSE:unresolved`.

### Fingerprint

`fingerprint({ toolName, errorText, exitCode })` canonicalizes timestamps, hex addresses, line numbers, paths, durations, version triples, and pid/port numbers, lowercases the result, SHA-256s it, and truncates to 16 hex chars. This is used both inside the span detector (to recognize "same error fired again") and at store-time to dedup entries.

### Scrubber

Three layers, applied in order, in [packages/daemon/src/scrubber/index.ts](../packages/daemon/src/scrubber/index.ts):

1. **Pattern bank** — `AKIA...`, `ghp_...`, `github_pat_...`, JWTs, BEGIN PRIVATE KEY blocks, Slack/Stripe/OpenAI/Anthropic/Google keys.
2. **Env-line heuristic** — `KEY=value` lines, redacted when value is long, near a secret-looking path, or high-entropy.
3. **Entropy catch-all** — tokens ≥20 chars with Shannon entropy ≥4.5 bits/char are redacted, except hash-like tokens (commit SHAs, etc.) which pass through.

`looksLikeSecretLeak()` re-runs the pattern bank after scrubbing as a tripwire — the drafter refuses to call the LLM if it fires.

See [privacy.md](privacy.md) for the threat model.

### Drafter

The drafter sends the **scrubbed** transcript + stack hints + trigger summary to an LLM provider (`AnthropicProvider` is the only one implemented in v0.1) and parses the response as YAML against a strict zod schema. The system prompt instructs the model to emit one of three refusal sentinels (`REFUSE:secrets`, `REFUSE:unresolved`, `REFUSE:insufficient`) when appropriate. Refusals do not become entries.

### Store

SQLite via `better-sqlite3` with three relevant constructs:

- `entries` table — the durable record.
- `entries_fts` — FTS5 virtual table, kept in sync via triggers. Tokenized with `porter unicode61`.
- `entry_vectors` — `sqlite-vec` virtual table for cosine-similarity search, optional (only initialized when the extension loads).

Migrations are a flat array of SQL strings keyed off `PRAGMA user_version` — adequate for a local-only store. Bumping `CURRENT_SCHEMA_VERSION` triggers each new migration on next daemon boot.

## Search & ranking

`remembug.search` runs two independent retrievers:

1. **BM25** via FTS5
2. **Vector** via sqlite-vec cosine distance against the query embedding

Then [packages/daemon/src/mcp/ranker.ts](../packages/daemon/src/mcp/ranker.ts) fuses both lists with **Reciprocal Rank Fusion** (RRF with `k=60`) and adds a small additive bonus (`STACK_BOOST = 0.05`) for entries whose stack tokens overlap the calling project's stack fingerprint.

RRF was chosen because it is robust to score-scale differences between BM25 and cosine and doesn't need normalization or hand-tuned weights. The stack bonus is in rank space, so it can't drown out a much stronger textual match — it only tips ties.

## Configuration

`~/.remembug/config.json` (matches `RemembugConfig` in `packages/shared/src/types.ts`):

```json
{
  "version": 1,
  "llm": {
    "provider": "anthropic",
    "model": "claude-opus-4-7",
    "api_key_env": "REMEMBUG_ANTHROPIC_KEY"
  },
  "daemon": { "port": 7842 },
  "scrubber": { "entropy_threshold": 4.5 },
  "review": { "mode": "manual" }
}
```

`api_key_env` is **the name of an env var to read**, never the key itself. The key never lands in config.

## v0.2 (team sync) — currently stubbed

[packages/server/](../packages/server/) is a placeholder for a federation endpoint that lets multiple developers' Remembug instances push published entries to a shared bucket. The wire protocol is unspecified, deliberately — we want to live with solo mode for a release cycle first.

## Non-goals

- **A web UI.** Remembug is for engineers in a terminal. `remembug review` is the UI.
- **Fancy embeddings.** A local 1536-dim embedding model is fine. BM25 carries most of the signal.
- **Auto-acceptance.** Drafts always require a human pass before publication. This is what keeps the KB worth reading.
- **Cross-machine sync in v0.1.** Files in `~/.remembug/` are syncable however you like (Dropbox, rsync). Real federation comes in v0.2.
