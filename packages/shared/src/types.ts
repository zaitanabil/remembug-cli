/**
 * Remembug shared type definitions.
 *
 * These types are the contract between the daemon, the CLI, and (eventually) the
 * team-sync server. Every persisted record is mirrored as a {@link import('./schemas.js').} zod schema
 * so payloads crossing trust boundaries (hooks, MCP, HTTP) can be validated.
 */

/** Origin of an entry. AI-drafted entries can be promoted to human-edited after review. */
export type EntryOrigin = 'ai_drafted' | 'ai_drafted_human_edited' | 'human_authored';

/** Lifecycle of an entry. Only `published` entries are surfaced by MCP search. */
export type EntryStatus = 'pending_review' | 'published' | 'rejected';

/**
 * A persisted Stack-Overflow-style knowledge base entry.
 *
 * `problem_body` and `solution_body` are markdown text, flattened from the
 * structured {@link Draft} fields at acceptance time so they survive future
 * schema changes.
 */
export interface Entry {
  id: string;
  title: string;
  problem_body: string;
  solution_body: string;
  tags: string[];
  stack: string[];
  fingerprint: string;
  origin: EntryOrigin;
  status: EntryStatus;
  confirmation_count: number;
  created_at: number;
  updated_at: number;
}

/**
 * The structured shape the LLM is asked to produce. Matches the YAML in
 * `packages/daemon/src/drafter/prompt.ts` exactly.
 */
export interface Draft {
  title: string;
  tags: string[];
  stack: string[];
  problem: {
    symptom: string;
    reproduction: string;
  };
  root_cause: string;
  solution: string;
  verification: string;
  confidence: number;
}

/** A project the user works in. Used to bias search by stack overlap. */
export interface Project {
  id: string;
  repo_path: string;
  stack_fingerprint: string;
  name: string;
}

/** Recorded by `remembug.feedback` MCP tool. Drives confirmation counts. */
export interface Feedback {
  id: string;
  entry_id: string;
  helpful: boolean;
  notes?: string;
  created_at: number;
}

/**
 * Raw, *scrubbed* transcript slice retained for audit/debugging. The unscrubbed
 * original never touches disk.
 */
export interface RawTranscript {
  id: string;
  entry_id?: string;
  scrubbed_content: string;
  created_at: number;
}

/**
 * Search result returned by `remembug.search`. `score` is the blended BM25/vector
 * rank used to order results — higher is more relevant.
 */
export interface SearchResult {
  entry: Entry;
  score: number;
}

/** Provider-agnostic config persisted in `~/.remembug/config.json`. */
export interface RemembugConfig {
  version: 1;
  llm: {
    provider: 'anthropic' | 'ollama' | 'openai';
    model: string;
    api_key_env: string;
    /** Ollama server URL (provider="ollama"). Defaults to the local daemon. */
    base_url?: string;
  };
  daemon: {
    port: number;
  };
  scrubber: {
    entropy_threshold: number;
  };
  review: {
    mode: 'manual' | 'auto';
  };
}

/**
 * PostToolUse hook payload, as posted by Claude Code's hook system.
 * Documented at https://docs.claude.com/en/docs/claude-code/hooks.
 */
export interface PostToolUsePayload {
  hook_event_name: 'PostToolUse';
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    error?: string;
  } & Record<string, unknown>;
}

/** Stop hook payload — fired when Claude finishes a turn. */
export interface StopPayload {
  hook_event_name: 'Stop';
  session_id: string;
  transcript_path: string;
  cwd: string;
  stop_hook_active?: boolean;
}

/**
 * A "problem span" — the contiguous slice of a session bracketing one failure
 * and (hopefully) its resolution. The capture pipeline emits these and feeds
 * them to the drafter.
 */
export interface ProblemSpan {
  session_id: string;
  cwd: string;
  started_at: number;
  resolved_at?: number;
  trigger: {
    tool_name: string;
    error_signature: string;
  };
  events: SpanEvent[];
  resolved: boolean;
}

/** One event recorded inside a {@link ProblemSpan}. */
export interface SpanEvent {
  at: number;
  kind: 'tool_use' | 'tool_result' | 'message';
  summary: string;
  exit_code?: number;
  /** What was actually done — Bash command, Edit/Write diff. */
  detail?: string;
}
