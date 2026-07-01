import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '@devzen/remembug-shared';
import { pingLlm } from './llm-health.js';

const ollamaConfig = (model: string) => ({
  ...defaultConfig(),
  llm: { provider: 'ollama' as const, model, api_key_env: 'UNUSED' },
});

describe('pingLlm — ollama', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ok when the server is up and the model is pulled', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen2.5-coder:3b' }] }),
    }));
    const r = await pingLlm(ollamaConfig('qwen2.5-coder:3b'));
    expect(r.status).toBe('ok');
  });

  it('warns with a pull hint when the model is missing', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ models: [] }) }));
    const r = await pingLlm(ollamaConfig('llama3.2:3b'));
    expect(r.status).toBe('warn');
    expect(r.fix).toContain('ollama pull llama3.2:3b');
  });

  it('fails when the server is unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await pingLlm(ollamaConfig('x'));
    expect(r.status).toBe('fail');
  });
});

describe('pingLlm — anthropic', () => {
  it('warns (does not call the API) when no key is set', async () => {
    const cfg = {
      ...defaultConfig(),
      llm: {
        provider: 'anthropic' as const,
        model: 'claude-sonnet-5',
        api_key_env: 'REMEMBUG_TEST_DEFINITELY_UNSET_KEY',
      },
    };
    delete process.env.REMEMBUG_TEST_DEFINITELY_UNSET_KEY;
    const r = await pingLlm(cfg);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('unset');
  });
});
