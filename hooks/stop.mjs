#!/usr/bin/env node
/**
 * Remembug hook shim: Stop. See post-tool-use.mjs for the design.
 */
import { readConfigSync } from './_shared.mjs';

const port = readConfigSync().daemon.port;
const url = `http://127.0.0.1:${port}/hook/stop`;

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
