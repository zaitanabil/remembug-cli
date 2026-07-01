#!/usr/bin/env node
/**
 * `remembug-mcp` entry point. Launched by Claude Code via `~/.claude/mcp.json`.
 * Body lives in `./run.ts` so the CLI package can expose the same bin.
 */
import { runMcpBin } from './run.js';

runMcpBin().catch((e) => {
  console.error('[remembug-mcp] failed to start:', e);
  process.exit(1);
});
