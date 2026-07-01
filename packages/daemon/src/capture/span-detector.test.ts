import { describe, expect, it, vi } from 'vitest';
import { SpanDetector } from './span-detector.js';
import type { PostToolUsePayload, StopPayload } from '@devzen/remembug-shared';

function bashPayload(opts: {
  session?: string;
  command?: string;
  exit_code?: number;
  stderr?: string;
  stdout?: string;
}): PostToolUsePayload {
  return {
    hook_event_name: 'PostToolUse',
    session_id: opts.session ?? 's1',
    transcript_path: '/tmp/transcript.json',
    cwd: '/home/dev/proj',
    tool_name: 'Bash',
    tool_input: { command: opts.command ?? 'echo hi' },
    tool_response: {
      exit_code: opts.exit_code,
      stderr: opts.stderr,
      stdout: opts.stdout,
    },
  };
}

function stopPayload(session = 's1'): StopPayload {
  return {
    hook_event_name: 'Stop',
    session_id: session,
    transcript_path: '/tmp/transcript.json',
    cwd: '/home/dev/proj',
  };
}

describe('SpanDetector', () => {
  it('does not open a span for a successful tool call', () => {
    const onResolved = vi.fn();
    const det = new SpanDetector({ onResolved });
    det.observeToolUse(bashPayload({ exit_code: 0 }));
    expect(det.openSpans()).toHaveLength(0);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('opens a span when a tool call fails', () => {
    const det = new SpanDetector({ onResolved: vi.fn() });
    det.observeToolUse(bashPayload({ exit_code: 1, stderr: 'ENOENT' }));
    expect(det.openSpans()).toHaveLength(1);
    expect(det.openSpans()[0]!.trigger.tool_name).toBe('Bash');
  });

  it('captures WHAT the fix was, not just that one happened', () => {
    // fail Bash -> Edit (the actual fix) -> pass Bash. The fix lives in the
    // Edit's tool_input and must survive into the resolved span, or the
    // drafter would have to hallucinate the solution.
    let resolved: { events: Array<{ summary: string; detail?: string }> } | undefined;
    const det = new SpanDetector({ onResolved: (s) => (resolved = s) });
    det.observeToolUse(bashPayload({ exit_code: 1, stderr: 'ECONNREFUSED 127.0.0.1:5432' }));
    det.observeToolUse({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      transcript_path: '/tmp/t',
      cwd: '/home/dev/proj',
      tool_name: 'Edit',
      tool_input: { file_path: '.env', old_string: 'DB_HOST=db', new_string: 'DB_HOST=localhost' },
      tool_response: {},
    });
    det.observeToolUse(bashPayload({ exit_code: 0, stdout: '12 passed' }));

    expect(resolved).toBeDefined();
    const editEvent = resolved!.events.find((e) => e.detail?.includes('edit .env'));
    expect(editEvent?.detail).toContain('- DB_HOST=db');
    expect(editEvent?.detail).toContain('+ DB_HOST=localhost');
    // the failing command is captured too
    expect(resolved!.events.some((e) => e.detail === '$ echo hi')).toBe(true);
  });

  it('resolves a span when the same tool succeeds afterwards', () => {
    const onResolved = vi.fn();
    const det = new SpanDetector({ onResolved });
    det.observeToolUse(bashPayload({ exit_code: 1, stderr: 'ENOENT' }));
    det.observeToolUse(bashPayload({ exit_code: 0 }));
    expect(onResolved).toHaveBeenCalledOnce();
    const span = onResolved.mock.calls[0]![0];
    expect(span.resolved).toBe(true);
    expect(span.events.length).toBe(2);
  });

  it('does not resolve when a different tool succeeds', () => {
    const onResolved = vi.fn();
    const det = new SpanDetector({ onResolved });
    det.observeToolUse(bashPayload({ exit_code: 1, stderr: 'ENOENT' }));
    det.observeToolUse({
      ...bashPayload({ exit_code: 0 }),
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(det.openSpans()).toHaveLength(1);
  });

  it('tracks distinct sessions independently', () => {
    const onResolved = vi.fn();
    const det = new SpanDetector({ onResolved });
    det.observeToolUse(bashPayload({ session: 's1', exit_code: 1, stderr: 'a' }));
    det.observeToolUse(bashPayload({ session: 's2', exit_code: 1, stderr: 'b' }));
    expect(det.openSpans()).toHaveLength(2);
    det.observeToolUse(bashPayload({ session: 's1', exit_code: 0 }));
    expect(onResolved).toHaveBeenCalledOnce();
    expect(det.openSpans()).toHaveLength(1);
    expect(det.openSpans()[0]!.session_id).toBe('s2');
  });

  it('Stop event abandons an unresolved span via the callback', () => {
    const onResolved = vi.fn();
    const onAbandoned = vi.fn();
    const det = new SpanDetector({ onResolved, onAbandoned });
    det.observeToolUse(bashPayload({ exit_code: 1, stderr: 'oops' }));
    det.observeStop(stopPayload());
    expect(onAbandoned).toHaveBeenCalledOnce();
    expect(onResolved).not.toHaveBeenCalled();
    expect(det.openSpans()).toHaveLength(0);
  });

  it('Stop after resolution is a no-op', () => {
    const onResolved = vi.fn();
    const onAbandoned = vi.fn();
    const det = new SpanDetector({ onResolved, onAbandoned });
    det.observeToolUse(bashPayload({ exit_code: 1, stderr: 'oops' }));
    det.observeToolUse(bashPayload({ exit_code: 0 }));
    det.observeStop(stopPayload());
    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('detects failure from non-zero exit and from textual stderr cues', () => {
    const det = new SpanDetector({ onResolved: vi.fn() });
    det.observeToolUse(bashPayload({ exit_code: 0, stderr: 'fatal error: nope' }));
    expect(det.openSpans()).toHaveLength(1);
  });

  it('reset drops all in-flight spans', () => {
    const det = new SpanDetector({ onResolved: vi.fn() });
    det.observeToolUse(bashPayload({ exit_code: 1, stderr: 'x' }));
    det.reset();
    expect(det.openSpans()).toHaveLength(0);
  });
});
