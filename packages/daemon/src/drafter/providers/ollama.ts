import type { LLMCompletionRequest, LLMCompletionResult, LLMProvider } from './types.js';

export interface OllamaProviderOptions {
  /** Model tag, e.g. "qwen2.5-coder:3b" or "llama3.1:8b". */
  model: string;
  /** Ollama server URL. Defaults to the local daemon. */
  baseUrl?: string;
}

/**
 * Ollama adapter — free, local, no API key. Talks to a running Ollama
 * server over its `/api/chat` endpoint, so drafting works for anyone with
 * Ollama installed instead of requiring a paid Anthropic key.
 *
 * The drafter parses the model's response as fenced YAML and validates it
 * against {@link DraftSchema}, so a small model that ignores the format
 * simply yields a `refused: invalid_yaml` outcome — never a bad entry.
 * Pick a model that follows instructions well (a coder/instruct tune).
 */
export class OllamaProvider implements LLMProvider {
  public readonly name = 'ollama';
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: OllamaProviderOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        options: {
          temperature: request.temperature ?? 0.2,
          num_predict: request.maxTokens ?? 4096,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Ollama at ${this.baseUrl} returned ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return { text: data.message?.content ?? '', raw: data };
  }
}
