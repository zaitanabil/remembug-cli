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
  /** The failing Bash command, if the trigger was Bash — used to detect a re-run that passes. */
  triggerCommand?: string;
  /** True once an Edit/Write/MultiEdit is seen after the failure (a code change = a candidate fix). */
  hasFixEdit: boolean;
}

export interface SpanDetectorEvents {
  /**
   * Called when a problem-span resolves. The fingerprint is the detection-time
   * one (raw error text + exit code) — computed once here so the daemon dedups
   * on the same value the detector used, instead of recomputing from the
   * already-canonicalized signature.
   */
  onResolved: (span: ProblemSpan, fingerprint: string) => void;
  /** Called when a session ends without resolution. Useful for telemetry. */
  onAbandoned?: (span: ProblemSpan) => void;
}

/** Bound in-memory spans: sessions that fail but never resolve or Stop leak otherwise. */
const MAX_OPEN_SPANS = 1000;
const MAX_SPAN_IDLE_MS = 30 * 60 * 1000;

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
        triggerCommand: commandOf(payload),
        hasFixEdit: false,
        trigger: {
          tool_name: payload.tool_name,
          error_signature: canonicalizeError(errorText).slice(0, 200),
        },
        events: [toolUseEvent(payload, errorText)],
        resolved: false,
      };
      this.evictStale();
      this.bySession.set(payload.session_id, span);
      return;
    }

    if (!existing) return;
    const priorEvents = existing.events.length;
    existing.events.push(toolUseEvent(payload, ''));

    // An Edit/Write/MultiEdit after the failure is a code change — the candidate
    // fix. It doesn't resolve on its own (we wait for a verifying success), but
    // it marks the span as having a real fix.
    if (isEditTool(payload.tool_name)) {
      existing.hasFixEdit = true;
      return;
    }

    // Resolve on a success when there's an actual fix signal:
    //   (a) a code change happened since the failure (then ANY tool succeeds —
    //       covers cross-tool verification, not just re-running the same tool), or
    //   (b) the exact command that failed now succeeds, with something in between
    //       (an install/config step) — not a bare flaky re-run.
    const sameCommandReran =
      existing.triggerCommand !== undefined &&
      commandOf(payload) === existing.triggerCommand &&
      priorEvents > 1;
    if (existing.hasFixEdit || sameCommandReran) {
      existing.resolved = true;
      existing.resolved_at = Date.now();
      this.bySession.delete(payload.session_id);
      this.listeners.onResolved(existing, existing.triggerFingerprint);
    }
  }

  /**
   * Drop spans that have gone idle past the TTL, and hard-cap the total. A
   * failing session that never re-runs the failing tool and never emits a Stop
   * would otherwise pin its span (and all its event detail) in memory forever.
   */
  private evictStale(): void {
    const now = Date.now();
    const lastActivity = (s: OpenSpan): number => s.events[s.events.length - 1]?.at ?? s.started_at;
    for (const [id, span] of this.bySession) {
      if (now - lastActivity(span) > MAX_SPAN_IDLE_MS) this.bySession.delete(id);
    }
    if (this.bySession.size >= MAX_OPEN_SPANS) {
      const oldestFirst = [...this.bySession.entries()].sort(
        (a, b) => lastActivity(a[1]) - lastActivity(b[1]),
      );
      const excess = this.bySession.size - MAX_OPEN_SPANS + 1;
      for (let i = 0; i < excess; i++) this.bySession.delete(oldestFirst[i]![0]);
    }
  }

  /**
   * Forward a Stop event. A session that failed, then edited a file, then ended
   * without an explicit verifying success is STILL a likely fix (the developer
   * changed code and moved on) — draft it and let the drafter's REFUSE:unresolved
   * guard reject it if the transcript doesn't actually show a resolution. A span
   * with no code change is genuinely abandoned.
   */
  observeStop(payload: StopPayload): void {
    const open = this.bySession.get(payload.session_id);
    if (!open) return;
    this.bySession.delete(payload.session_id);
    if (open.resolved) return;
    if (open.hasFixEdit) {
      open.resolved = true;
      open.resolved_at = Date.now();
      this.listeners.onResolved(open, open.triggerFingerprint);
      return;
    }
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
  // A tool-level error field always means failure (non-Bash tools have no code).
  if (error && error.trim().length > 0) return true;
  // When an exit code is present, TRUST it: git/npm/docker routinely write
  // "error"/"warning"-ish text to stderr on a successful (exit 0) run, so the
  // stderr-keyword heuristic must not override a clean exit.
  if (typeof exit_code === 'number') return exit_code !== 0;
  // No exit code (e.g. a non-shell tool): fall back to the stderr heuristic.
  if (stderr && /error|failed|fatal|cannot|denied/i.test(stderr)) return true;
  return false;
}

function isEditTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return n === 'edit' || n === 'write' || n === 'multiedit';
}

/** The Bash command for a payload, if any — used to spot a failed command re-running clean. */
function commandOf(p: PostToolUsePayload): string | undefined {
  if (p.tool_name.toLowerCase() !== 'bash') return undefined;
  const cmd = p.tool_input.command;
  return typeof cmd === 'string' ? cmd.trim() : undefined;
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
  // strip internal-only bookkeeping when surfacing externally
  const { triggerFingerprint: _fp, triggerCommand: _cmd, hasFixEdit: _edit, ...rest } = s;
  void _fp;
  void _cmd;
  void _edit;
  return rest;
}
