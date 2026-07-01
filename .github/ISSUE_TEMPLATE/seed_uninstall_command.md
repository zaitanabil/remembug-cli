---
name: '[seed] Add `remembug uninstall` command'
about: 'Good first issue — reverse the `remembug init` patches cleanly.'
title: 'Add `remembug uninstall` command to reverse init patches'
labels: ['good-first-issue', 'help-wanted', 'cli']
assignees: ''
---

## Background

`remembug init` merges Remembug hooks and the MCP server entry into the user's Claude Code config:

- `~/.claude/settings.json` — adds entries under `hooks.PostToolUse[*]` and `hooks.Stop[*]` whose commands point at `hooks/post-tool-use.mjs` and `hooks/stop.mjs`.
- `~/.claude/mcp.json` — adds an entry under `mcpServers.remembug`.

There is currently no clean way to undo this. The README and [claude-code-integration.md](../../docs/claude-code-integration.md#uninstalling) tell users to hand-edit JSON, which is error-prone.

## Goal

Add a `remembug uninstall` subcommand that:

1. Stops the daemon if it's running (`remembug daemon stop` semantics — issue a SIGTERM via the pidfile).
2. Removes the Remembug-owned entries from `settings.json` and `mcp.json` without disturbing anything else the user added.
3. Optionally prompts for and removes `~/.remembug/` (entries DB, logs, config). Default: keep, with a printed instruction for how to delete manually.

## Acceptance criteria

- [ ] `remembug uninstall` exists and runs to completion on a freshly `init`-ed system.
- [ ] Other entries in `hooks.PostToolUse` / `hooks.Stop` arrays are preserved.
- [ ] Other entries in `mcpServers` are preserved.
- [ ] `--dry-run` prints the diff without modifying files.
- [ ] `--purge-data` (off by default) deletes `~/.remembug/`.
- [ ] Vitest coverage for the merge-removal logic, including: empty arrays after removal collapse cleanly; unrelated entries unaffected; idempotent on second run.

## Implementation hints

- The matching logic in [packages/cli/src/commands/init.ts](../../packages/cli/src/commands/init.ts) shows how the patches are structured. Removal is the inverse: walk `hooks.PostToolUse[*].hooks[*]` and drop entries whose `command` string references `hooks/post-tool-use.mjs` (and the equivalent for Stop).
- Mark an entry as Remembug-owned by string-matching the shim filename — a marker comment isn't possible in JSON.
- Use the same `deepMerge`/walker style that `init` uses to keep the diff readable.

## Out of scope

- Migrating away from the absolute-path shim references. (Tracked separately.)
- A `remembug doctor` that detects half-installed states.
