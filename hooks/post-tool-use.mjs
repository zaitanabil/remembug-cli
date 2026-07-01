#!/usr/bin/env node
/**
 * Remembug hook shim: PostToolUse.
 *
 * Reads the JSON payload Claude Code sends on stdin and POSTs it to
 * the local Remembug daemon. Designed to be cheap and never block Claude
 * — any failure is silently swallowed (the daemon may not be running,
 * and that's fine).
 */
import { readConfigSync } from './_shared.mjs';

const port = readConfigSync().daemon.port;
const url = `http://127.0.0.1:${port}/hook/post-tool-use`;

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  body += chunk;
});
process.stdin.on('end', async () => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    }).catch(() => undefined);
    clearTimeout(timeout);
  } catch {
    // Hooks must never crash Claude.
  }
  process.exit(0);
});
