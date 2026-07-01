/**
 * Drafting orchestrator: scrubbed transcript → YAML draft → parsed Draft.
 *
 * Refuses to call the LLM if the scrubber tripwire fires. Refuses to
 * trust the LLM output if the response is a `REFUSE:...` sentinel or
 * fails schema validation.
 */
import { parse as parseYaml } from 'yaml';
import { DraftSchema, type Draft } from '@devzen/remembug-shared';
import { looksLikeSecretLeak } from '../scrubber/index.js';
import { buildUserPrompt, DRAFTER_SYSTEM_PROMPT } from './prompt.js';
import type { LLMProvider } from './providers/types.js';

export type DraftOutcome =
  | { kind: 'drafted'; draft: Draft }
  | { kind: 'refused'; reason: 'secrets' | 'unresolved' | 'insufficient' | 'invalid_yaml' }
  | { kind: 'error'; error: Error };

export interface DraftRequest {
  scrubbedTranscript: string;
  stackHints: string[];
  triggerSummary?: string;
}

export interface DrafterOptions {
  provider: LLMProvider;
}

export class Drafter {
  constructor(private readonly opts: DrafterOptions) {}

  async draft(request: DraftRequest): Promise<DraftOutcome> {
    if (looksLikeSecretLeak(request.scrubbedTranscript)) {
      return { kind: 'refused', reason: 'secrets' };
    }

    const userPrompt = buildUserPrompt(request);
    let response;
    try {
      response = await this.opts.provider.complete({
        systemPrompt: DRAFTER_SYSTEM_PROMPT,
        userPrompt,
        temperature: 0.2,
      });
    } catch (e) {
      return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) };
    }

    const text = response.text.trim();
    const refusal = text.match(/^REFUSE:(secrets|unresolved|insufficient)\b/);
    if (refusal) {
      return { kind: 'refused', reason: refusal[1] as 'secrets' | 'unresolved' | 'insufficient' };
    }

    const yamlBody = extractYamlBlock(text);
    if (!yamlBody) {
      return { kind: 'refused', reason: 'invalid_yaml' };
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(yamlBody);
    } catch {
      return { kind: 'refused', reason: 'invalid_yaml' };
    }

    const result = DraftSchema.safeParse(normalizeDraftShape(parsed));
    if (!result.success) {
      return { kind: 'refused', reason: 'invalid_yaml' };
    }
    return { kind: 'drafted', draft: result.data };
  }
}

/**
 * Smooth over harmless shape variance before schema validation. Models —
 * especially smaller local ones — routinely render "steps" fields
 * (reproduction/solution/verification) as YAML lists when the schema wants
 * a string. Coerce those lists into a markdown bullet string rather than
 * rejecting an otherwise-good draft. Also coerce a stringified confidence
 * back to a number. Strict schema stays the contract; this just widens the
 * funnel into it.
 */
export function normalizeDraftShape(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const o = parsed as Record<string, unknown>;
  for (const k of ['title', 'root_cause', 'solution', 'verification']) {
    if (k in o) o[k] = coerceToString(o[k]);
  }
  if (o.problem && typeof o.problem === 'object') {
    const p = o.problem as Record<string, unknown>;
    for (const k of ['symptom', 'reproduction']) {
      if (k in p) p[k] = coerceToString(p[k]);
    }
  }
  if (typeof o.confidence === 'string' && o.confidence.trim() !== '') {
    const n = Number(o.confidence);
    if (Number.isFinite(n)) o.confidence = n;
  }
  return o;
}

/** A YAML list of steps → a markdown bullet string; scalars pass through. */
function coerceToString(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .map((s) => (s.trimStart().startsWith('-') ? s : `- ${s}`))
    .join('\n');
}

/** Extract the YAML body from a ```yaml ... ``` fence. Returns null on miss. */
export function extractYamlBlock(text: string): string | null {
  // Prefer fences whose closing ``` sits at the start of a line. The prompt
  // asks the model to put ```bash/```ts snippets inside the `solution` field,
  // and those inner fences are indented within a YAML block scalar, so a
  // column-0 anchor skips them instead of truncating at the first inner fence.
  const outer = [...text.matchAll(/^```(?:yaml|yml)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm)];
  // More than one top-level block is ambiguous — and an injection vector, since
  // an extra earlier block could shadow the real one. Refuse rather than guess.
  if (outer.length > 1) return null;
  if (outer.length === 1) return outer[0]![1]!.trim();
  // No column-0 close: a simple single block with no embedded fences. If the
  // captured body still contains a fence it was truncated at an inner/indented
  // fence — ambiguous, so refuse rather than return a fragment.
  const fence = text.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1]!.includes('```') ? null : fence[1]!.trim();
  // Fallback: maybe the model emitted bare YAML.
  if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(text)) return text;
  return null;
}

export * from './providers/types.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OllamaProvider } from './providers/ollama.js';
export { DRAFTER_SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

/** Flatten a structured Draft into the two markdown bodies stored on Entry. */
export function flattenDraft(draft: Draft): { problem_body: string; solution_body: string } {
  const problem_body = [
    `**Symptom**`,
    '',
    draft.problem.symptom,
    '',
    `**Reproduction**`,
    '',
    draft.problem.reproduction,
    '',
    `**Root cause**`,
    '',
    draft.root_cause,
  ].join('\n');

  const solution_body = [
    draft.solution,
    '',
    `**Verification**`,
    '',
    draft.verification,
    '',
    `*Draft confidence: ${draft.confidence.toFixed(2)}*`,
  ].join('\n');

  return { problem_body, solution_body };
}
