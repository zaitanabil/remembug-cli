#!/usr/bin/env node
/**
 * Published as the `remembug-daemon` bin so it lands on PATH from a global
 * `@devzen/remembug-cli` install. `remembug daemon start` spawns this file by path.
 */
import { runDaemonBin } from '@devzen/remembug-daemon';

runDaemonBin().catch((e) => {
  console.error('[remembug] daemon failed to start:', e);
  process.exit(1);
});
