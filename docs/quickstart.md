# Quickstart

Zero to first captured entry in about five minutes.

## Prerequisites

- **Node.js 20+** (`.nvmrc` pins the exact minor)
- **Claude Code** installed and working (`claude --version`)
- An **Anthropic API key** (`sk-ant-...`) — the default drafter uses Claude. Ollama and OpenAI providers are scaffolded but not required for v0.1.

## 1. Install the CLI

```bash
npm install -g @devzen/remembug-cli
remembug --version
```

Local development install instead:

```bash
git clone https://github.com/zaitanabil/remembug-cli.git
cd remembug
corepack enable
pnpm install
pnpm build
node packages/cli/dist/index.js --version
```

## 2. Initialize

```bash
remembug init
```

This creates `~/.remembug/` (database, config, logs) and merges hook + MCP entries into your Claude Code config. It is non-destructive — existing keys in `~/.claude/settings.json` and `~/.claude/mcp.json` are preserved.

Run `remembug init --dry-run` first if you want to inspect the patches before they land.

## 3. Configure your API key

```bash
remembug config set anthropic-key sk-ant-...
```

Or via env var (recommended for shared shells):

```bash
export REMEMBUG_ANTHROPIC_KEY=sk-ant-...
```

## 4. Start the daemon

```bash
remembug daemon start
remembug daemon status
# [remembug] daemon is up on port 7842
```

The daemon binds to `127.0.0.1:7842` only — it is never on a public socket.

## 5. Use Claude Code normally

There is no new workflow. Open a project, ask Claude to do something, hit a failure, watch Claude fix it. Remembug captures the span in the background.

A draft is queued only when:

1. A tool call failed,
2. A subsequent same-kind tool call succeeded, and
3. The drafter LLM produced a parseable, schema-valid YAML draft.

## 6. Review and accept drafts

```bash
remembug review
```

You'll see an [Ink](https://github.com/vadimdemedes/ink) TUI with one queued draft at a time:

```
(1/2) Fix EADDRINUSE when running multiple vitest workers
  tags: vitest, eaddrinuse, ports
  stack: node@20, vitest@2

  — problem —
  Vitest workers fail to bind to a port when more than one suite runs in parallel...

  [a]ccept  [r]eject  [e]dit  [n]ext  [q]uit
> a
published 3f8a91b2-...
```

Only `published` entries are surfaced to Claude through MCP.

## 7. Search

```bash
remembug search "vitest port already in use"
```

Or, from inside Claude Code, just ask: _"have I hit something like this before?"_ — Claude has access to `remembug.search`, `remembug.get`, and `remembug.feedback` via MCP and will call them on its own.

## Troubleshooting

Start with `remembug doctor` — it probes config, API key, daemon, hooks, MCP wiring, and the store in one shot, and prints a fix hint for whatever's red. The table below covers specific symptoms.

| Symptom                                     | Fix                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `remembug daemon status` says not reachable | Check `~/.remembug/logs/daemon.log`. Most likely the port is taken — change it with `remembug config set daemon-port 7843` and restart.                      |
| Drafts never appear                         | The drafter only fires on resolved spans. Run with `REMEMBUG_LOG=debug remembug daemon start --foreground` to see span lifecycle.                            |
| Claude isn't calling `remembug.search`      | Restart Claude Code so it re-reads `~/.claude/mcp.json`. Verify with `claude mcp list`.                                                                      |
| Drafter returns `REFUSE:secrets`            | Good — your transcript still had something that looked like a key after scrubbing. Inspect `~/.remembug/logs/scrubber.log` and consider tightening patterns. |

See [claude-code-integration.md](claude-code-integration.md) for the full hook + MCP wiring details.
