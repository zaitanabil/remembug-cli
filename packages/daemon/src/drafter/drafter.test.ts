import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drafter, OllamaProvider, normalizeDraftShape } from './index.js';
import type { LLMProvider } from './providers/types.js';

const fence = (yaml: string) => '```yaml\n' + yaml + '\n```';
const stub = (text: string): LLMProvider => ({ name: 'stub', complete: async () => ({ text }) });

describe('normalizeDraftShape', () => {
  it('coerces YAML list "steps" fields into markdown bullet strings', () => {
    const out = normalizeDraftShape({
      solution: ['Set a unique port', 'Re-run the suite'],
      verification: ['Run vitest twice'],
      problem: { symptom: 'EADDRINUSE', reproduction: ['Run pnpm vitest run'] },
    }) as Record<string, unknown>;
    expect(out.solution).toBe('- Set a unique port\n- Re-run the suite');
    expect((out.problem as Record<string, unknown>).reproduction).toBe('- Run pnpm vitest run');
  });

  it('leaves scalar fields untouched and coerces a stringified confidence', () => {
    const out = normalizeDraftShape({ solution: 'do x', confidence: '0.8' }) as Record<
      string,
      unknown
    >;
    expect(out.solution).toBe('do x');
    expect(out.confidence).toBe(0.8);
  });
});

describe('Drafter', () => {
  it('accepts a draft whose steps came back as YAML lists (small-model shape)', async () => {
    // The exact shape qwen2.5-coder:3b produced — lists where the schema wants strings.
    const yaml = [
      'title: Fix EADDRINUSE when running multiple vitest workers',
      'tags: [vitest, ports]',
      'stack: [node@20]',
      'problem:',
      '  symptom: listen EADDRINUSE address already in use',
      '  reproduction:',
      '    - Run pnpm vitest run in parallel',
      'root_cause: Two workers bound the same port.',
      'solution:',
      '  - Assign a unique port per worker',
      'verification:',
      '  - Re-run the suite; no EADDRINUSE',
      'confidence: 0.9',
    ].join('\n');
    const outcome = await new Drafter({ provider: stub(fence(yaml)) }).draft({
      scrubbedTranscript: 'x',
      stackHints: [],
    });
    expect(outcome.kind).toBe('drafted');
    if (outcome.kind === 'drafted') {
      expect(outcome.draft.solution).toContain('- Assign a unique port');
      expect(outcome.draft.confidence).toBe(0.9);
    }
  });

  it('refuses on the secrets sentinel', async () => {
    const outcome = await new Drafter({ provider: stub('REFUSE:secrets') }).draft({
      scrubbedTranscript: 'x',
      stackHints: [],
    });
    expect(outcome).toEqual({ kind: 'refused', reason: 'secrets' });
  });
});

describe('OllamaProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs system+user messages to /api/chat and returns message.content', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ message: { content: 'drafted text' } }) } as Response;
    });
    const provider = new OllamaProvider({ model: 'qwen2.5-coder:3b', baseUrl: 'http://h:11434/' });
    const res = await provider.complete({ systemPrompt: 'sys', userPrompt: 'usr' });

    expect(res.text).toBe('drafted text');
    expect(calls[0]!.url).toBe('http://h:11434/api/chat'); // trailing slash trimmed
    expect(calls[0]!.body.model).toBe('qwen2.5-coder:3b');
    expect(calls[0]!.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('throws a useful error on a non-OK response', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'model not found',
    }));
    await expect(
      new OllamaProvider({ model: 'missing' }).complete({ systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toThrow(/404 Not Found/);
  });
});
