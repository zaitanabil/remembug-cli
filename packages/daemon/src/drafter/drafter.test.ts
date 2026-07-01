import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  Drafter,
  OllamaProvider,
  extractYamlBlock,
  normalizeDraftShape,
} from './index.js';
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

describe('AnthropicProvider', () => {
  it('does not send `temperature` (current Sonnet/Opus models reject it with a 400)', async () => {
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5' });
    const client = (
      provider as unknown as {
        client: { messages: { create: (p: Record<string, unknown>) => Promise<unknown> } };
      }
    ).client;
    let sent: Record<string, unknown> | undefined;
    client.messages.create = async (params) => {
      sent = params;
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    const res = await provider.complete({ systemPrompt: 's', userPrompt: 'u', temperature: 0.2 });
    expect(res.text).toBe('ok');
    expect(sent).toBeDefined();
    expect('temperature' in sent!).toBe(false);
    expect(sent!.max_tokens).toBe(4096);
  });
});

// A full, valid draft in which the model followed the prompt's instruction to
// put a fenced ```ts block inside `solution`. Before the extractYamlBlock fix
// this truncated at the inner fence and dropped `verification`/`confidence`.
const EMBEDDED_FENCE_DOC = [
  '```yaml',
  'title: Fix EADDRINUSE when Vitest binds a fixed port',
  'tags: [vitest, node]',
  'stack: [node@20, vitest@2]',
  'problem:',
  '  symptom: listen EADDRINUSE address already in use :::4000',
  '  reproduction: bind a server to port 4000 in setup, run vitest multi-threaded',
  'root_cause: parallel workers collide on a shared fixed listen port',
  'solution: |',
  '  Bind to an ephemeral port and read it back:',
  '  ```ts',
  '  const srv = app.listen(0);',
  '  const { port } = srv.address();',
  '  ```',
  'verification: run vitest 20x; no EADDRINUSE and each worker logs a distinct port',
  'confidence: 0.88',
  '```',
].join('\n');

describe('extractYamlBlock', () => {
  it('keeps later keys when the model embeds a fenced code block in `solution`', () => {
    const body = extractYamlBlock(EMBEDDED_FENCE_DOC)!;
    expect(body).toContain('verification:');
    expect(body).toContain('confidence:');
    expect(body).toContain('```ts'); // inner code fence preserved, not truncated
  });

  it('still extracts a simple fenced block with no inner fences', () => {
    const body = extractYamlBlock('```yaml\ntitle: x\nconfidence: 0.5\n```')!;
    expect(body).toContain('title: x');
    expect(body).toContain('confidence: 0.5');
  });

  it('falls back to bare YAML when there is no fence', () => {
    expect(extractYamlBlock('title: x\nconfidence: 0.5')).toContain('title: x');
  });
});

describe('Drafter with embedded code fences', () => {
  it('drafts a valid entry when the model puts a ```ts block in solution', async () => {
    const outcome = await new Drafter({ provider: stub(EMBEDDED_FENCE_DOC) }).draft({
      scrubbedTranscript: 'x',
      stackHints: [],
    });
    expect(outcome.kind).toBe('drafted');
    if (outcome.kind === 'drafted') {
      expect(outcome.draft.confidence).toBe(0.88);
      expect(outcome.draft.solution).toContain('app.listen(0)');
      expect(outcome.draft.verification).toContain('EADDRINUSE');
    }
  });
});
