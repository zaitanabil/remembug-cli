import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Command } from 'commander';
import { remembugPaths, readConfig } from '@devzen/remembug-daemon';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * `remembug daemon <start|stop|status>` — fire-and-forget process control.
 *
 * v0.1 uses the dumb-and-reliable approach: spawn detached, write the
 * pidfile, kill via SIGTERM. No supervisor, no PM2. The daemon is
 * idempotent on restart.
 */
export function registerDaemon(program: Command): void {
  const cmd = program.command('daemon').description('Control the Remembug background daemon.');

  cmd
    .command('start')
    .option('--foreground', 'Run in the foreground (do not detach).', false)
    .action(async (opts: { foreground: boolean }) => {
      const config = readConfig(remembugPaths());
      // Spawn the CLI's own published bin (dist/bin/remembug-daemon.js),
      // not a path into the daemon package — only this layout survives a
      // global install where node_modules hoisting is unpredictable.
      const daemonBin = resolve(__dirname, '../bin/remembug-daemon.js');
      const child = spawn(process.execPath, [daemonBin], {
        detached: !opts.foreground,
        stdio: opts.foreground ? 'inherit' : 'ignore',
        env: process.env,
      });
      if (!opts.foreground) {
        child.unref();

        console.log(
          `[remembug] daemon started (port ${config.daemon.port}); detached pid=${child.pid}`,
        );
      }
    });

  cmd.command('status').action(async () => {
    const config = readConfig(remembugPaths());
    try {
      const res = await fetch(`http://127.0.0.1:${config.daemon.port}/healthz`);
      if (res.ok) {
        console.log(`[remembug] daemon is up on port ${config.daemon.port}`);
        return;
      }
    } catch {
      // fallthrough
    }
    console.log(`[remembug] daemon is not reachable on port ${config.daemon.port}`);
    process.exitCode = 1;
  });

  cmd
    .command('stop')
    .description('Terminate the running daemon (reads the pidfile).')
    .option('--timeout <ms>', 'Max time to wait for graceful exit.', '3000')
    .action(async (opts: { timeout: string }) => {
      const paths = remembugPaths();
      if (!existsSync(paths.pidFile)) {
        console.log('[remembug] no pidfile; daemon is not running.');
        return;
      }
      const pid = Number(readFileSync(paths.pidFile, 'utf8').trim());
      if (!Number.isFinite(pid) || pid <= 0) {
        console.log('[remembug] pidfile is malformed; removing.');
        unlinkSync(paths.pidFile);
        return;
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          console.log(`[remembug] no process with pid ${pid}; cleaning pidfile.`);
          unlinkSync(paths.pidFile);
          return;
        }
        throw e;
      }
      const timeoutMs = Number(opts.timeout);
      const deadline =
        Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000);
      while (Date.now() < deadline) {
        if (!existsSync(paths.pidFile)) {
          console.log(`[remembug] daemon stopped (pid ${pid}).`);
          return;
        }
        await sleep(100);
      }
      console.log(`[remembug] sent SIGTERM to ${pid} but pidfile is still present after timeout.`);
      process.exitCode = 1;
    });
}
