/**
 * Loopback HTTP server for hook payloads.
 *
 * Binds only to 127.0.0.1 — never an externally reachable interface —
 * because nothing about Remembug should be on a public socket. The hook
 * shims POST JSON here; the daemon owns all the actual capture/draft
 * orchestration.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handlePostToolUse } from './hooks/post-tool-use.js';
import { handleStop } from './hooks/stop.js';
import type { SpanDetector } from './capture/span-detector.js';

export interface DaemonHttpDeps {
  detector: SpanDetector;
}

export interface DaemonHttpOptions {
  port: number;
}

const ROUTES = {
  postToolUse: '/hook/post-tool-use',
  stop: '/hook/stop',
  health: '/healthz',
} as const;

/** Hook payloads are small; anything larger is not a real hook call. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** An error from readJson carrying the HTTP status the caller should return. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Only accept requests whose Host header names the loopback interface. Binding
 * to 127.0.0.1 stops off-box traffic, but a browser on the same machine can be
 * pointed at us via DNS rebinding; that request arrives with the attacker's
 * hostname in Host, which this rejects. Real local callers use 127.0.0.1.
 */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new HttpError(413, 'request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function createDaemonHttp(
  deps: DaemonHttpDeps,
  options: DaemonHttpOptions,
): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      if (!isLoopbackHost(req.headers.host)) {
        return respond(res, 403, { error: 'forbidden' });
      }
      if (req.method !== 'POST' && req.url !== ROUTES.health) {
        return respond(res, 405, { error: 'method not allowed' });
      }
      try {
        switch (req.url) {
          case ROUTES.health:
            return respond(res, 200, { ok: true });
          case ROUTES.postToolUse: {
            const body = await readJson(req);
            const result = handlePostToolUse(body, { detector: deps.detector });
            return respond(res, result.ok ? 200 : 400, result);
          }
          case ROUTES.stop: {
            const body = await readJson(req);
            const result = handleStop(body, { detector: deps.detector });
            return respond(res, result.ok ? 200 : 400, result);
          }
          default:
            return respond(res, 404, { error: 'not found' });
        }
      } catch (e) {
        // Never echo internal exception text to the client.
        const status = e instanceof HttpError ? e.status : 500;
        const error = e instanceof HttpError ? e.message : 'internal error';
        return respond(res, status, { error });
      }
    })();
  });

  // Slow-loris / hung-connection guards.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;

  return new Promise((resolve, reject) => {
    let listening = false;
    server.on('error', (err) => {
      if (!listening) {
        reject(err);
        return;
      }
      // Post-listen socket errors must not crash the daemon.
      process.stderr.write(`[remembug] http server error: ${(err as Error).message}\n`);
    });
    server.listen(options.port, '127.0.0.1', () => {
      listening = true;
      resolve(server);
    });
  });
}
