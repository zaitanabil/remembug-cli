import Anthropic from '@anthropic-ai/sdk';
import type { LLMCompletionRequest, LLMCompletionResult, LLMProvider } from './types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
}

/**
 * Anthropic SDK adapter. Cached at module scope per (apiKey, model) so
 * we don't re-spin a client per draft.
 *
 * The model is configured rather than pinned so users on the bleeding
 * edge can switch to a newer Sonnet/Opus without code changes.
 */
export class AnthropicProvider implements LLMProvider {
  public readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    // No `temperature`: current Sonnet/Opus model ids reject it with a 400
    // ("temperature is deprecated for this model"), and drafting doesn't need
    // a specific sampling temperature. The Ollama provider still honours it.
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userPrompt }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return { text, raw: response };
  }
}
