/**
 * Daemon process entry — wires capture → drafter → store → HTTP.
 *
 * Exposed as both a long-running process (`remembug-daemon` bin) and as a
 * library function so the CLI can embed it without forking.
 */
import { Drafter } from './drafter/index.js';
import { AnthropicProvider } from './drafter/providers/anthropic.js';
import { OllamaProvider } from './drafter/providers/ollama.js';
import type { LLMProvider } from './drafter/providers/types.js';
import { SpanDetector } from './capture/span-detector.js';
import { detectStack } from './capture/stack-detect.js';
import { fingerprint, stackFingerprint } from './fingerprint/index.js';
import { createDaemonHttp } from './http.js';
import { LocalEmbedder, type EmbeddingProvider } from './embeddings/index.js';
import { Store } from './store/index.js';
import { scrub } from './scrubber/index.js';
import { flattenDraft } from './drafter/index.js';
import { remembugPaths, ensurePaths, loadDotenv, readConfig, resolveApiKey } from './config.js';
import { Logger } from './logger.js';
import type { ProblemSpan } from '@devzen/remembug-shared';

export interface DaemonContext {
  store: Store;
  detector: SpanDetector;
  drafter?: Drafter;
  embedder: EmbeddingProvider;
  logger: Logger;
  port: number;
  stop: () => Promise<void>;
}

export interface StartDaemonOptions {
  /** Override LLM provider — used by tests. */
  llmProvider?: LLMProvider;
  /** Override embedder — used by tests. */
  embedder?: EmbeddingProvider;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonContext> {
  const paths = ensurePaths(remembugPaths());
  loadDotenv(paths);
  const config = readConfig(paths);
  const logger = new Logger({ logsDir: paths.logsDir });
  const store = new Store({ path: paths.db });
  const embedder = options.embedder ?? new LocalEmbedder();

  const drafter = await maybeMakeDrafter(options, config);
  if (!drafter) {
    logger.daemon(
      'warn',
      'drafter disabled: no LLM API key resolved; resolved spans will be stored as raw transcripts only',
      { api_key_env: config.llm.api_key_env },
    );
  }

  const detector = new SpanDetector({
    onResolved: (span) => {
      onResolvedSpan(span, { store, drafter, embedder, logger }).catch((e) => {
        logger.daemon('error', 'onResolvedSpan threw', {
          session_id: span.session_id,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    },
  });

  const server = createDaemonHttp({ detector }, { port: config.daemon.port });
  logger.daemon('info', 'daemon started', { port: config.daemon.port });

  return {
    store,
    detector,
    drafter,
    embedder,
    logger,
    port: config.daemon.port,
    stop: async () =>
      new Promise<void>((resolve) => {
        logger.daemon('info', 'daemon stopping');
        server.close(() => resolve());
        store.close();
      }),
  };
}

async function maybeMakeDrafter(
  options: StartDaemonOptions,
  config: ReturnType<typeof readConfig>,
): Promise<Drafter | undefined> {
  if (options.llmProvider) return new Drafter({ provider: options.llmProvider });

  // Ollama: free + local, no API key. The user opts in by setting
  // llm.provider = "ollama" (and an installed model in llm.model).
  if (config.llm.provider === 'ollama') {
    const baseUrl = config.llm.base_url ?? process.env.REMEMBUG_OLLAMA_URL;
    return new Drafter({ provider: new OllamaProvider({ model: config.llm.model, baseUrl }) });
  }

  const apiKey = resolveApiKey(config);
  if (!apiKey) return undefined;
  const provider = new AnthropicProvider({ apiKey, model: config.llm.model });
  return new Drafter({ provider });
}

async function onResolvedSpan(
  span: ProblemSpan,
  deps: {
    store: Store;
    drafter: Drafter | undefined;
    embedder: EmbeddingProvider;
    logger: Logger;
  },
): Promise<void> {
  const transcript = renderSpan(span);
  const { content: scrubbed, redactions } = scrub(transcript);
  if (redactions.length > 0) {
    deps.logger.scrubber('redactions applied', {
      session_id: span.session_id,
      cwd: span.cwd,
      counts: Object.fromEntries(redactions.map((r) => [r.type, r.count])),
    });
  }
  const fp = fingerprint({
    toolName: span.trigger.tool_name,
    errorText: span.trigger.error_signature,
  });
  const stack = detectStack(span.cwd);
  const project = deps.store.upsertProject({
    repo_path: span.cwd,
    stack_fingerprint: stackFingerprint(stack.tokens),
    name: stack.projectName,
  });
  deps.logger.daemon('debug', 'span resolved', {
    session_id: span.session_id,
    fingerprint: fp,
    trigger: span.trigger.tool_name,
    project_id: project.id,
    stack: stack.tokens,
  });

  // Dedup: if we already have an entry with this fingerprint, bump its
  // confirmation count rather than creating a duplicate draft.
  const existing = deps.store.findByFingerprint(fp).filter((e) => e.status === 'published');
  if (existing.length > 0) {
    deps.store.incrementConfirmation(existing[0]!.id);
    deps.logger.daemon('info', 'span matched existing entry; confirmation incremented', {
      entry_id: existing[0]!.id,
      fingerprint: fp,
    });
    return;
  }

  if (!deps.drafter) {
    deps.store.saveRawTranscript(scrubbed);
    deps.logger.daemon('info', 'span saved as raw transcript (no drafter)', { fingerprint: fp });
    return;
  }

  const outcome = await deps.drafter.draft({
    scrubbedTranscript: scrubbed,
    stackHints: stack.tokens,
    triggerSummary: `${span.trigger.tool_name}: ${span.trigger.error_signature.slice(0, 80)}`,
  });
  if (outcome.kind !== 'drafted') {
    deps.store.saveRawTranscript(scrubbed);
    deps.logger.daemon('info', 'drafter declined', {
      fingerprint: fp,
      outcome: outcome.kind,
      reason: outcome.kind === 'refused' ? outcome.reason : undefined,
      error: outcome.kind === 'error' ? outcome.error.message : undefined,
    });
    return;
  }
  const flat = flattenDraft(outcome.draft);
  const draftStack = outcome.draft.stack.length > 0 ? outcome.draft.stack : stack.tokens;
  const entry = deps.store.insertEntry({
    title: outcome.draft.title,
    problem_body: flat.problem_body,
    solution_body: flat.solution_body,
    tags: outcome.draft.tags,
    stack: draftStack,
    fingerprint: fp,
    origin: 'ai_drafted',
    status: 'pending_review',
    project_ids: [project.id],
  });
  deps.store.saveRawTranscript(scrubbed, entry.id);
  deps.logger.daemon('info', 'draft queued for review', {
    entry_id: entry.id,
    fingerprint: fp,
    confidence: outcome.draft.confidence,
  });

  if (deps.store.hasVectorSupport) {
    const v = await deps.embedder.embed(
      `${entry.title}\n${entry.problem_body}\n${entry.solution_body}`,
    );
    deps.store.upsertVector(entry.id, v);
  }
}

function renderSpan(span: ProblemSpan): string {
  const lines: string[] = [];
  lines.push(`# Problem span in ${span.cwd}`);
  lines.push(`Trigger: ${span.trigger.tool_name} — ${span.trigger.error_signature}`);
  lines.push('');
  for (const e of span.events) {
    lines.push(`[${e.kind}] ${e.summary}`);
    if (e.detail) {
      for (const dl of e.detail.split('\n')) lines.push(`    ${dl}`);
    }
  }
  return lines.join('\n');
}

export { Store } from './store/index.js';
export { SpanDetector } from './capture/span-detector.js';
export { Drafter, flattenDraft } from './drafter/index.js';
export { scrub, looksLikeSecretLeak } from './scrubber/index.js';
export { fingerprint, stackFingerprint } from './fingerprint/index.js';
export { LocalEmbedder } from './embeddings/index.js';
export { Logger } from './logger.js';
export type { LogLevel } from './logger.js';
export {
  remembugPaths,
  readConfig,
  writeConfig,
  ensurePaths,
  loadDotenv,
  resolveApiKey,
} from './config.js';
export { startMcpServer } from './mcp/server.js';
export { runDaemonBin, runMcpBin } from './bin/run.js';
export { pingLlm } from './llm-health.js';
export type { LlmPing } from './llm-health.js';
export { rank } from './mcp/ranker.js';
export type { RankedResult } from './mcp/ranker.js';
export { searchTool, SearchInputSchema } from './mcp/tools/search.js';
export type { SearchInput } from './mcp/tools/search.js';
export { getTool, GetInputSchema } from './mcp/tools/get.js';
export { feedbackTool, FeedbackInputSchema } from './mcp/tools/feedback.js';
export type { EmbeddingProvider } from './embeddings/index.js';
export type { LLMProvider } from './drafter/providers/types.js';
