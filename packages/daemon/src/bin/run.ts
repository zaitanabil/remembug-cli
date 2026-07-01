/**
 * Shared entry-point bodies for the `remembug-daemon` and `remembug-mcp`
 * binaries. Lives here (not in the bin shims) so the CLI package can own
 * the published bins too: when `@devzen/remembug-cli` is the global install, the
 * daemon package's own bins are NOT on PATH, so the CLI re-exports thin
 * wrappers that call these. Single source, two callers each.
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { remembugPaths, ensurePaths } from '../config.js';
import { startDaemon } from '../index.js';
import { startMcpServer } from '../mcp/server.js';

/** `remembug-daemon` — long-lived HTTP daemon. Writes a pidfile so stop works. */
export async function runDaemonBin(): Promise<void> {
  const paths = ensurePaths(remembugPaths());
  const ctx = await startDaemon();
  writeFileSync(paths.pidFile, String(process.pid), { mode: 0o600 });
  console.log(`[remembug] daemon listening on http://127.0.0.1:${ctx.port}`);

  const shutdown = (): void => {
    if (existsSync(paths.pidFile)) {
      try {
        unlinkSync(paths.pidFile);
      } catch {
        // pidfile may already be gone if `remembug daemon stop` raced us
      }
    }
    void ctx.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** `remembug-mcp` — stdio MCP server launched by Claude Code via mcp.json. */
export async function runMcpBin(): Promise<void> {
  const paths = ensurePaths(remembugPaths());
  await startMcpServer({ dbPath: paths.db });
}
