#!/usr/bin/env node
/**
 * `remembug-daemon` entry point. Run by `remembug daemon start`. The body
 * lives in `./run.ts` so the CLI package can expose the same bin.
 */
import { runDaemonBin } from './run.js';

runDaemonBin().catch((e) => {
  console.error('[remembug] daemon failed to start:', e);
  process.exit(1);
});
