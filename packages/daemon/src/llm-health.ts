/**
 * Live LLM reachability check for `remembug doctor`.
 *
 * Knowing the API key env var is *set* is not the same as knowing drafting
 * works — a typo'd model, a revoked key, no network, or an unpulled Ollama
 * model all leave the key "set" while every draft silently fails. So doctor
 * does a real, minimal round-trip against the configured provider and reports
 * the actual outcome.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { RemembugConfig } from '@devzen/remembug-shared';
import { resolveApiKey } from './config.js';

export interface LlmPing {
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export async function pingLlm(
  config: RemembugConfig,
  opts: { timeoutMs?: number } = {},
): Promise<LlmPing> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  return config.llm.provider === 'ollama'
    ? pingOllama(config, timeoutMs)
    : pingAnthropic(config, timeoutMs);
}

async function pingOllama(config: RemembugConfig, timeoutMs: number): Promise<LlmPing> {
  const baseUrl = (
    config.llm.base_url ??
    process.env.REMEMBUG_OLLAMA_URL ??
    'http://127.0.0.1:11434'
  ).replace(/\/+$/, '');
  let tags: { models?: Array<{ name?: string }> };
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return {
        status: 'fail',
        detail: `Ollama at ${baseUrl} returned ${res.status}`,
        fix: 'is `ollama serve` running?',
      };
    }
    tags = (await res.json()) as typeof tags;
  } catch {
    return {
      status: 'fail',
      detail: `Ollama not reachable at ${baseUrl}`,
      fix: 'install + start Ollama (https://ollama.com), then `ollama serve`',
    };
  }
  const names = (tags.models ?? []).map((m) => m.name);
  if (!names.includes(config.llm.model)) {
    return {
      status: 'warn',
      detail: `Ollama up, but model "${config.llm.model}" is not pulled`,
      fix: `ollama pull ${config.llm.model}`,
    };
  }
  return { status: 'ok', detail: `Ollama reachable; model "${config.llm.model}" available` };
}

async function pingAnthropic(config: RemembugConfig, timeoutMs: number): Promise<LlmPing> {
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    return {
      status: 'warn',
      detail: `${config.llm.api_key_env} is unset — drafting is disabled`,
      fix: 'remembug config set anthropic-key sk-ant-…  (or use the free Ollama path)',
    };
  }
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs });
    await client.messages.create({
      model: config.llm.model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { status: 'ok', detail: `Anthropic reachable; model "${config.llm.model}" accepted` };
  } catch (e) {
    if (e instanceof Anthropic.NotFoundError) {
      return {
        status: 'fail',
        detail: `model "${config.llm.model}" was rejected (404)`,
        fix: 'remembug config set llm.model claude-sonnet-5  (or another current model id)',
      };
    }
    if (e instanceof Anthropic.AuthenticationError) {
      return {
        status: 'fail',
        detail: 'API key was rejected (401)',
        fix: 're-set a valid key with: remembug config set anthropic-key …',
      };
    }
    if (e instanceof Anthropic.PermissionDeniedError) {
      return { status: 'fail', detail: 'API key lacks permission / billing (403)' };
    }
    // Network/timeout/5xx — can't confirm, but don't claim it's broken.
    return {
      status: 'warn',
      detail: `couldn't reach Anthropic to verify: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
