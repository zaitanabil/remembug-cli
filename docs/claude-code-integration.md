# Claude Code Integration

How Remembug hooks into Claude Code in two directions: **capture** (hooks → daemon) and **retrieval** (Claude → MCP server).

## Files Remembug touches

`remembug init` merges into two files in your Claude Code config directory (default `~/.claude/`):

- `settings.json` — `hooks` block
- `mcp.json` — `mcpServers` block

Existing keys are preserved. Run `remembug init --dry-run` to see the exact JSON patches before they land.

## Capture: hooks

Two hook events are wired:

| Event         | Matcher | Shim                                                  |
| ------------- | ------- | ----------------------------------------------------- |
| `PostToolUse` | `.*`    | [hooks/post-tool-use.mjs](../hooks/post-tool-use.mjs) |
| `Stop`        | `.*`    | [hooks/stop.mjs](../hooks/stop.mjs)                   |

### What the shims do

Both shims are deliberately tiny. They:

1. Read the JSON payload from stdin.
2. POST it to the loopback daemon with a 1500 ms abort timeout.
3. Swallow every error.

Hooks must never crash Claude. If the daemon isn't running, the shim exits 0 silently — capture is best-effort, not load-bearing.

The full PostToolUse payload shape is documented at <https://docs.claude.com/en/docs/claude-code/hooks> and mirrored as `PostToolUsePayload` in [packages/shared/src/types.ts](../packages/shared/src/types.ts).

### Resulting `settings.json` patch

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "node /abs/path/to/remembug/hooks/post-tool-use.mjs" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": "node /abs/path/to/remembug/hooks/stop.mjs" }]
      }
    ]
  }
}
```

### Routes the daemon exposes

| Route                 | Method | Purpose                                                   |
| --------------------- | ------ | --------------------------------------------------------- |
| `/healthz`            | `GET`  | Daemon liveness probe — used by `remembug daemon status`. |
| `/hook/post-tool-use` | `POST` | Receives PostToolUse payloads.                            |
| `/hook/stop`          | `POST` | Receives Stop payloads.                                   |

All routes are loopback-only (`127.0.0.1:7842` by default).

## Retrieval: MCP server

Claude Code launches `remembug-mcp` automatically when it sees an `mcpServers.remembug` entry in `mcp.json`. The server speaks stdio MCP and is stateless past its SQLite connection.

### Resulting `mcp.json` patch

```json
{
  "mcpServers": {
    "remembug": {
      "command": "remembug-mcp",
      "args": []
    }
  }
}
```

If `remembug-mcp` is not on `$PATH` (e.g., local dev build), point at the absolute path:

```json
{
  "mcpServers": {
    "remembug": {
      "command": "node",
      "args": ["/abs/path/to/remembug/packages/daemon/dist/mcp/server.js"]
    }
  }
}
```

### Tools the server exposes

| Tool                | Inputs                                                             | Output                                                                                 |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `remembug.search`   | `query` (string), optional `project_path`, optional `limit` (1–50) | Ranked list of `{ entry, score }`. Hybrid BM25 + vector + stack bias.                  |
| `remembug.get`      | `entry_id`                                                         | Full `Entry` text by id. Used after `remembug.search` for deeper read.                 |
| `remembug.feedback` | `entry_id`, `helpful` (bool), optional `notes`                     | Records a `Feedback` row. `helpful: true` increments the entry's `confirmation_count`. |

The descriptions registered with Claude are deliberately prescriptive — `remembug.search`'s description tells Claude to call it _before_ reasoning from scratch about a new error.

### Suggesting the workflow to Claude

If you want Claude to lean on Remembug aggressively, drop this into your repo `CLAUDE.md`:

```markdown
## Debugging workflow

When you encounter an error, runtime exception, or unexpected behavior:

1. Call `remembug.search` with a short description of the failure before proposing fixes.
2. If a result has `score >= 0.5`, call `remembug.get` to read the full solution.
3. After applying any suggested fix, call `remembug.feedback` with whether it helped.
```

This is optional — Claude will discover the tools without it — but it shortens the path.

## End-to-end flow

```
Claude runs a tool       →  PostToolUse fires      →  shim POSTs to daemon
Daemon's SpanDetector observes failure
Claude runs another tool →  PostToolUse fires      →  daemon sees success
SpanDetector emits onResolved
Daemon scrubs the span
Daemon asks the LLM provider to draft YAML
Drafter parses YAML against zod schema
Store inserts row with status='pending_review'

(later) user runs `remembug review`
        accepts → status='published', FTS5 and vector indexes refreshed

(later) Claude in a new session encounters a similar error
        Claude calls remembug.search → MCP server returns the entry
        Claude applies the fix → calls remembug.feedback(helpful=true)
        Entry's confirmation_count bumps; ranker weights it higher next time.
```

## Uninstalling

To remove the Remembug integration from Claude Code:

1. Stop the daemon: `remembug daemon stop`
2. Remove the hooks/MCP entries from `~/.claude/settings.json` and `~/.claude/mcp.json` (Remembug does not currently ship a `remembug uninstall` — patches welcome).
3. `rm -rf ~/.remembug` to drop the database, logs, and config.

A `remembug uninstall` command that reverses the `remembug init` patches cleanly is tracked as a good-first-issue.

## Troubleshooting

| Symptom                                             | Likely cause                                                  | Fix                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `claude mcp list` shows `remembug` but it errors    | `remembug-mcp` not on `$PATH`, or the package isn't built     | `pnpm build` and verify with `which remembug-mcp`.                                                                        |
| Drafts never get queued                             | The daemon never sees POSTs                                   | `remembug daemon status`. If down, restart. Check `~/.remembug/logs/daemon.log`.                                          |
| Hook payloads arrive but no spans resolve           | Span detector requires same-`tool_name` success after failure | Use `REMEMBUG_LOG=debug remembug daemon start --foreground` and inspect emitted span events.                              |
| `remembug.search` returns nothing for a known entry | Entry is still `pending_review`                               | `remembug review` and accept.                                                                                             |
| MCP server crashes on startup                       | sqlite-vec extension load failed                              | Search still works (BM25-only); look for `sqlite-vec` warning in stderr. To force-rebuild: `pnpm rebuild better-sqlite3`. |
