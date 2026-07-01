/**
 * Provider-agnostic LLM contract.
 *
 * Implementations live in this directory and are wired up in
 * `../index.ts`. The interface intentionally returns *raw text* — the
 * drafter is responsible for parsing the YAML response — so providers
 * don't need to understand the prompt format.
 */
export interface LLMCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Hard upper bound. Providers may emit fewer tokens. */
  maxTokens?: number;
  /** Lower = more deterministic. Defaults are provider-specific. */
  temperature?: number;
}

export interface LLMCompletionResult {
  text: string;
  /** Raw provider response for debugging/audit, opaque to callers. */
  raw?: unknown;
}

export interface LLMProvider {
  /** Free-form name surfaced in logs. */
  readonly name: string;
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
