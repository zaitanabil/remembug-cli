import { afterEach, describe, expect, it } from 'vitest';
import { request, type Server } from 'node:http';
import { createDaemonHttp } from './http.js';
import { SpanDetector } from './capture/span-detector.js';

interface CallOpts {
  path?: string;
  method?: string;
  host?: string;
  body?: string;
}

function call(port: number, opts: CallOpts = {}): Promise<{ status: number; json: unknown }> {
  const { path = '/healthz', method = 'GET', host = `127.0.0.1:${port}`, body } = opts;
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: { Host: host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = text;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            /* leave as text */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('daemon http server', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function start(): Promise<number> {
    const detector = new SpanDetector({ onResolved: () => {} });
    server = await createDaemonHttp({ detector }, { port: 0 });
    const addr = server.address();
    if (addr && typeof addr === 'object') return addr.port;
    throw new Error('no port');
  }

  it('serves /healthz to a loopback Host', async () => {
    const port = await start();
    const res = await call(port);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
  });

  it('rejects a non-loopback Host header (DNS-rebinding guard)', async () => {
    const port = await start();
    const res = await call(port, { host: 'evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid JSON without echoing internals', async () => {
    const port = await start();
    const res = await call(port, { path: '/hook/post-tool-use', method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'invalid json' });
  });

  it('caps an oversized body without crashing the daemon', async () => {
    const port = await start();
    try {
      await call(port, {
        path: '/hook/post-tool-use',
        method: 'POST',
        body: 'x'.repeat(5 * 1024 * 1024),
      });
    } catch {
      // The server destroys the socket past the cap; a client reset is expected.
    }
    // The daemon is still alive and serving.
    const res = await call(port);
    expect(res.status).toBe(200);
  });
});
