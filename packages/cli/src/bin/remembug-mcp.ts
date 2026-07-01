#!/usr/bin/env node
/**
 * Published as the `remembug-mcp` bin so Claude Code's mcp.json entry
 * (`command: "remembug-mcp"`) resolves from a global `@devzen/remembug-cli` install.
 */
import { runMcpBin } from '@devzen/remembug-daemon';

runMcpBin().catch((e) => {
  console.error('[remembug-mcp] failed to start:', e);
  process.exit(1);
});
