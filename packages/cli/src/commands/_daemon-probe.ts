import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Is the remembug daemon actually answering on this port? Used to confirm a
 * start succeeded and, critically, to avoid SIGTERMing a recycled PID: if the
 * daemon isn't responding, the pidfile is stale and the recorded pid may now
 * belong to an unrelated process.
 */
export async function daemonResponds(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll `daemonResponds` until it's true or the deadline passes. */
export async function waitForDaemon(port: number, deadlineMs = 3000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await daemonResponds(port, 500)) return true;
    await sleep(150);
  }
  return false;
}
