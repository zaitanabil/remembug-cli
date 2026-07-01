import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Command } from 'commander';
import { remembugPaths, readConfig, writeFileAtomic } from '@devzen/remembug-daemon';
import { daemonResponds } from './_daemon-probe.js';

export function registerUninstall(program: Command): void {
  program
    .command('uninstall')
    .description(
      'Reverse remembug init: stop daemon, remove hooks/MCP entries, optionally purge data.',
    )
    .option(
      '--claude-dir <path>',
      'Override Claude Code config directory.',
      join(homedir(), '.claude'),
    )
    .option('--dry-run', 'Show what would happen but make no changes.', false)
    .option('--purge-data', 'Also delete ~/.remembug/ directory.', false)
    .action(async (opts: { claudeDir: string; dryRun: boolean; purgeData: boolean }) => {
      const paths = remembugPaths();
      const settingsPath = join(opts.claudeDir, 'settings.json');
      const mcpPath = join(opts.claudeDir, 'mcp.json');

      console.log('[remembug] uninstall starting...');
      console.log(`  claude-dir: ${opts.claudeDir}`);
      console.log(`  remembug-home: ${paths.home}`);

      if (opts.dryRun) {
        console.log('\n[remembug] --dry-run mode — no changes will be made.\n');
      }

      await stopDaemon(paths, opts.dryRun);
      removeHooksFromSettings(settingsPath, paths.hooksDir, opts.dryRun);
      removeMcpEntry(mcpPath, opts.dryRun);
      purgeDataIfRequested(paths.home, opts.purgeData, opts.dryRun);

      console.log('[remembug] uninstall complete.');
    });
}

async function stopDaemon(paths: ReturnType<typeof remembugPaths>, dryRun: boolean): Promise<void> {
  if (!existsSync(paths.pidFile)) {
    console.log('[remembug] uninstall: no pidfile found; daemon not running or already stopped.');
    return;
  }

  const pidStr = readFileSync(paths.pidFile, 'utf8').trim();
  const pid = Number(pidStr);

  if (!Number.isFinite(pid) || pid <= 0) {
    console.log('[remembug] uninstall: pidfile is malformed; skipping daemon stop.');
    if (!dryRun) {
      try {
        unlinkSync(paths.pidFile);
      } catch {
        /* noop */
      }
    }
    return;
  }

  if (dryRun) {
    console.log(`[remembug] uninstall: would send SIGTERM to daemon pid=${pid}.`);
    return;
  }

  // Only signal if a daemon is actually answering on its port. A stale pidfile
  // (crash/reboot) may name a recycled PID belonging to an unrelated process.
  const config = readConfig(paths);
  if (!(await daemonResponds(config.daemon.port))) {
    console.log(
      '[remembug] uninstall: daemon not responding; pidfile is stale, removing (no SIGTERM).',
    );
    try {
      unlinkSync(paths.pidFile);
    } catch {
      /* noop */
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[remembug] uninstall: sent SIGTERM to daemon (pid=${pid}).`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
      console.log(`[remembug] uninstall: no process with pid ${pid}; cleaning pidfile.`);
      try {
        unlinkSync(paths.pidFile);
      } catch {
        /* noop */
      }
      return;
    }
    throw e;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!existsSync(paths.pidFile)) {
      console.log('[remembug] uninstall: daemon stopped gracefully.');
      return;
    }
    await sleep(100);
  }
  console.log('[remembug] uninstall: daemon did not exit within timeout; pidfile still present.');
}

export function removeHooksFromSettings(
  settingsPath: string,
  hooksDir: string,
  dryRun: boolean,
): void {
  if (!existsSync(settingsPath)) {
    console.log('[remembug] uninstall: settings.json does not exist; skipping hook removal.');
    return;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    console.warn('[remembug] uninstall: settings.json is not valid JSON; leaving untouched.');
    return;
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) {
    console.log('[remembug] uninstall: no hooks key in settings.json; nothing to remove.');
    return;
  }

  let changed = false;

  // Match the ABSOLUTE shim path `init` wrote (`<hooksDir>/<shim>`), not the bare
  // filename: a user's own hook that happens to be named post-tool-use.mjs must
  // not be removed. Using the full path also works for a custom REMEMBUG_HOME.
  const SHIM: Record<'PostToolUse' | 'Stop', string> = {
    PostToolUse: join(hooksDir, 'post-tool-use.mjs'),
    Stop: join(hooksDir, 'stop.mjs'),
  };

  for (const hookKey of ['PostToolUse', 'Stop'] as const) {
    const arr = hooks[hookKey];
    if (!Array.isArray(arr)) continue;

    const shimPath = SHIM[hookKey];
    const beforeLen = arr.length;
    const filtered = arr.filter((entry: Record<string, unknown>) => {
      const entryHooks = entry.hooks as Array<{ type?: string; command?: string }> | undefined;
      if (!Array.isArray(entryHooks)) return true;
      return !entryHooks.some((h) => typeof h.command === 'string' && h.command.includes(shimPath));
    });

    if (filtered.length !== beforeLen) {
      (hooks as Record<string, unknown>)[hookKey] = filtered;
      changed = true;
      console.log(
        `[remembug] uninstall: removed ${beforeLen - filtered.length} remembug entry/entries from hooks.${hookKey}.`,
      );
    }
  }

  if (dryRun) {
    if (changed) {
      console.log('[remembug] uninstall: would update settings.json with hook removals.');
    } else {
      console.log('[remembug] uninstall: no remembug hooks found in settings.json.');
    }
    return;
  }

  if (changed) {
    writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log('[remembug] uninstall: settings.json updated.');
  } else {
    console.log('[remembug] uninstall: no remembug hooks found in settings.json; file unchanged.');
  }
}

export function removeMcpEntry(mcpPath: string, dryRun: boolean): void {
  if (!existsSync(mcpPath)) {
    console.log('[remembug] uninstall: mcp.json does not exist; skipping MCP removal.');
    return;
  }

  let mcp: Record<string, unknown>;
  try {
    mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
  } catch {
    console.warn('[remembug] uninstall: mcp.json is not valid JSON; leaving untouched.');
    return;
  }

  const servers = mcp.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !('remembug' in servers)) {
    console.log('[remembug] uninstall: no remembug entry in mcpServers; nothing to remove.');
    return;
  }

  if (dryRun) {
    console.log('[remembug] uninstall: would remove mcpServers.remembug from mcp.json.');
    return;
  }

  delete servers.remembug;
  writeFileAtomic(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  console.log('[remembug] uninstall: removed mcpServers.remembug from mcp.json.');
}

export function purgeDataIfRequested(home: string, purgeData: boolean, dryRun: boolean): void {
  if (!purgeData) {
    console.log('[remembug] uninstall: keeping ~/.remembug/ (use --purge-data to delete).');
    return;
  }

  if (!existsSync(home)) {
    console.log('[remembug] uninstall: ~/.remembug/ does not exist; nothing to purge.');
    return;
  }

  if (dryRun) {
    console.log('[remembug] uninstall: would delete ~/.remembug/ entirely.');
    return;
  }

  rmSync(home, { recursive: true, force: true });
  console.log('[remembug] uninstall: deleted ~/.remembug/.');
}
