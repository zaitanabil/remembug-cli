/**
 * Zod schemas mirroring the types in `./types.ts`.
 *
 * Every payload crossing a trust boundary (hook HTTP, MCP, config file)
 * should be parsed through a schema here so we never operate on
 * partially-formed input.
 */
import { z } from 'zod';
import type { RemembugConfig } from './types.js';

export const EntryOriginSchema = z.enum([
  'ai_drafted',
  'ai_drafted_human_edited',
  'human_authored',
]);

export const EntryStatusSchema = z.enum(['pending_review', 'published', 'rejected']);

export const EntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  problem_body: z.string(),
  solution_body: z.string(),
  tags: z.array(z.string()),
  stack: z.array(z.string()),
  fingerprint: z.string().min(1),
  origin: EntryOriginSchema,
  status: EntryStatusSchema,
  confirmation_count: z.number().int().nonnegative(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

export const DraftSchema = z.object({
  title: z.string().min(1),
  tags: z.array(z.string()),
  stack: z.array(z.string()),
  problem: z.object({
    symptom: z.string(),
    reproduction: z.string(),
  }),
  root_cause: z.string(),
  solution: z.string(),
  verification: z.string(),
  confidence: z.number().min(0).max(1),
});

export const ProjectSchema = z.object({
  id: z.string().min(1),
  repo_path: z.string().min(1),
  stack_fingerprint: z.string().min(1),
  name: z.string().min(1),
});

export const FeedbackSchema = z.object({
  id: z.string().min(1),
  entry_id: z.string().min(1),
  helpful: z.boolean(),
  notes: z.string().optional(),
  created_at: z.number().int(),
});

export const RawTranscriptSchema = z.object({
  id: z.string().min(1),
  entry_id: z.string().optional(),
  scrubbed_content: z.string(),
  created_at: z.number().int(),
});

export const RemembugConfigSchema = z.object({
  version: z.literal(1),
  llm: z.object({
    provider: z.enum(['anthropic', 'ollama', 'openai']),
    model: z.string().min(1),
    api_key_env: z.string().min(1),
    /** Ollama server URL (provider="ollama"). Defaults to the local daemon. */
    base_url: z.string().url().optional(),
  }),
  daemon: z.object({
    port: z.number().int().min(1).max(65535),
  }),
  scrubber: z.object({
    entropy_threshold: z.number().min(0).max(8),
  }),
  review: z.object({
    mode: z.enum(['manual', 'auto']),
  }),
});

export const PostToolUsePayloadSchema = z.object({
  hook_event_name: z.literal('PostToolUse'),
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  tool_name: z.string().min(1),
  tool_input: z.record(z.unknown()),
  tool_response: z
    .object({
      stdout: z.string().optional(),
      stderr: z.string().optional(),
      exit_code: z.number().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
});

export const StopPayloadSchema = z.object({
  hook_event_name: z.literal('Stop'),
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  stop_hook_active: z.boolean().optional(),
});

export const SpanEventSchema = z.object({
  at: z.number().int(),
  kind: z.enum(['tool_use', 'tool_result', 'message']),
  summary: z.string(),
  exit_code: z.number().int().optional(),
  /**
   * The meaningful slice of the tool's input — the Bash command, the
   * Edit/Write diff — i.e. *what was actually done*. Without it the drafter
   * only sees that a fix happened, not what the fix was.
   */
  detail: z.string().optional(),
});

export const ProblemSpanSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  started_at: z.number().int(),
  resolved_at: z.number().int().optional(),
  trigger: z.object({
    tool_name: z.string().min(1),
    error_signature: z.string(),
  }),
  events: z.array(SpanEventSchema),
  resolved: z.boolean(),
});

/** Default config used by `remembug init`. Kept here so other packages can import it. */
export function defaultConfig(): RemembugConfig {
  return {
    version: 1,
    llm: {
      // Current Sonnet per Anthropic's live model catalog (cheaper than the
      // legacy 4.6). If a model id ever drifts out of date, `remembug doctor`
      // pings it live and prints the exact `config set llm.model` fix.
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      api_key_env: 'REMEMBUG_ANTHROPIC_KEY',
    },
    daemon: {
      port: 7842,
    },
    scrubber: {
      entropy_threshold: 4.5,
    },
    review: {
      mode: 'manual',
    },
  };
}
