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

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
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

export function createDaemonHttp(deps: DaemonHttpDeps, options: DaemonHttpOptions): Server {
  const server = createServer((req, res) => {
    void (async () => {
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
        return respond(res, 500, { error: e instanceof Error ? e.message : 'internal error' });
      }
    })();
  });

  server.listen(options.port, '127.0.0.1');
  return server;
}
