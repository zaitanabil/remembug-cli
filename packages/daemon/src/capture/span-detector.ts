/**
 * Problem-span detection.
 *
 * A *problem span* is a contiguous slice of a Claude Code session
 * starting at the first failing tool call and ending when one of:
 *   - the same fingerprint stops appearing AND a subsequent tool call
 *     succeeds (resolution)
 *   - the session reaches a `Stop` event without resolution (give up)
 *
 * The detector is held in memory and keyed by session_id; it
 * intentionally does not persist anything until the daemon decides to
 * pass the slice to the drafter.
 */
import type {
  PostToolUsePayload,
  ProblemSpan,
  SpanEvent,
  StopPayload,
} from '@devzen/remembug-shared';
import { canonicalizeError, fingerprint } from '../fingerprint/index.js';

interface OpenSpan extends ProblemSpan {
  triggerFingerprint: string;
}

export interface SpanDetectorEvents {
  /** Called when a problem-span resolves. Daemon turns this into a draft. */
  onResolved: (span: ProblemSpan) => void;
  /** Called when a session ends without resolution. Useful for telemetry. */
  onAbandoned?: (span: ProblemSpan) => void;
}

export class SpanDetector {
  private readonly bySession = new Map<string, OpenSpan>();

  constructor(private readonly listeners: SpanDetectorEvents) {}

  /** Forward a PostToolUse event. Opens, extends, or closes a span. */
  observeToolUse(payload: PostToolUsePayload): void {
    const failed = isFailure(payload);
    const existing = this.bySession.get(payload.session_id);

    if (failed) {
      const errorText =
        payload.tool_response.error ??
        payload.tool_response.stderr ??
        payload.tool_response.stdout ??
        '';
      const fp = fingerprint({
        toolName: payload.tool_name,
        errorText,
        exitCode: payload.tool_response.exit_code,
      });

      if (existing) {
        existing.events.push(toolUseEvent(payload, errorText));
        existing.triggerFingerprint = fp;
        return;
      }

      const span: OpenSpan = {
        session_id: payload.session_id,
        cwd: payload.cwd,
        started_at: Date.now(),
        triggerFingerprint: fp,
        trigger: {
          tool_name: payload.tool_name,
          error_signature: canonicalizeError(errorText).slice(0, 200),
        },
        events: [toolUseEvent(payload, errorText)],
        resolved: false,
      };
      this.bySession.set(payload.session_id, span);
      return;
    }

    if (!existing) return;
    existing.events.push(toolUseEvent(payload, ''));

    // Heuristic: a successful tool call after a failure is *probably* progress.
    // Many real fixes are: failed Bash → Edit/Write a file → successful Bash.
    // We only declare a span "resolved" once we see a success matching the
    // same trigger (e.g. the same Bash command succeeds), to avoid declaring
    // resolution on unrelated tool calls.
    if (sameKindAsTrigger(existing, payload)) {
      existing.resolved = true;
      existing.resolved_at = Date.now();
      this.bySession.delete(payload.session_id);
      this.listeners.onResolved(existing);
    }
  }

  /** Forward a Stop event. Marks any open span abandoned. */
  observeStop(payload: StopPayload): void {
    const open = this.bySession.get(payload.session_id);
    if (!open) return;
    this.bySession.delete(payload.session_id);
    if (open.resolved) return;
    this.listeners.onAbandoned?.(open);
  }

  /** Test seam: peek at current open spans. */
  openSpans(): ProblemSpan[] {
    return Array.from(this.bySession.values()).map(stripInternal);
  }

  /** Drop all in-flight spans, e.g. on daemon shutdown. */
  reset(): void {
    this.bySession.clear();
  }
}

function isFailure(p: PostToolUsePayload): boolean {
  const { exit_code, error, stderr } = p.tool_response;
  if (typeof exit_code === 'number' && exit_code !== 0) return true;
  if (error && error.trim().length > 0) return true;
  if (stderr && /error|failed|fatal|cannot|denied/i.test(stderr)) return true;
  return false;
}

function sameKindAsTrigger(span: OpenSpan, p: PostToolUsePayload): boolean {
  return p.tool_name === span.trigger.tool_name && !isFailure(p);
}

function toolUseEvent(p: PostToolUsePayload, errorText: string): SpanEvent {
  const summary = errorText
    ? `${p.tool_name} failed: ${truncate(errorText, 200)}`
    : `${p.tool_name} ok`;
  const detail = extractDetail(p.tool_name, p.tool_input);
  return {
    at: Date.now(),
    kind: errorText ? 'tool_result' : 'tool_use',
    summary,
    exit_code: p.tool_response.exit_code,
    ...(detail ? { detail } : {}),
  };
}

/**
 * Pull *what was actually done* out of a tool call's input — the Bash
 * command, the Edit/Write diff — so the resolved span carries the fix, not
 * just the fact that a fix happened. This is the difference between the
 * drafter writing a real solution and hallucinating one. The detail is
 * rendered into the transcript and runs through the scrubber like
 * everything else, so secrets in a command or diff are still redacted.
 */
function extractDetail(toolName: string, input: Record<string, unknown>): string | undefined {
  const str = (v: unknown): string =>
    typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  const name = toolName.toLowerCase();

  if (name === 'bash') {
    const cmd = str(input.command).trim();
    return cmd ? `$ ${truncate(cmd, 400)}` : undefined;
  }
  if (name === 'edit') {
    return diffDetail(str(input.file_path), str(input.old_string), str(input.new_string));
  }
  if (name === 'multiedit' && Array.isArray(input.edits)) {
    const file = str(input.file_path);
    const diffs = (input.edits as Array<Record<string, unknown>>)
      .slice(0, 6)
      .map((e) => diffDetail('', str(e.old_string), str(e.new_string)))
      .filter(Boolean)
      .join('\n');
    return [file && `edit ${file}`, diffs].filter(Boolean).join('\n') || undefined;
  }
  if (name === 'write') {
    const file = str(input.file_path);
    const content = str(input.content).trim();
    return (
      [file && `write ${file}`, content && truncate(content, 800)].filter(Boolean).join('\n') ||
      undefined
    );
  }
  // Unknown tool: a compact view of its input beats nothing.
  const json = truncate(str(input), 400);
  return json && json !== '{}' ? json : undefined;
}

function diffDetail(file: string, oldStr: string, newStr: string): string | undefined {
  if (!oldStr && !newStr) return undefined;
  return [
    file && `edit ${file}`,
    oldStr && `- ${truncate(oldStr.trim(), 300)}`,
    newStr && `+ ${truncate(newStr.trim(), 300)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function stripInternal(s: OpenSpan): ProblemSpan {
  // strip the internal triggerFingerprint when surfacing externally
  const { triggerFingerprint: _drop, ...rest } = s;
  void _drop;
  return rest;
}
