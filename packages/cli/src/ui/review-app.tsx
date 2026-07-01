/**
 * Ink TUI for `remembug review`.
 *
 * Keys:
 *   a — accept and publish the draft
 *   r — reject the draft
 *   e — open the entry's bodies in $EDITOR, then mark
 *       origin=ai_drafted_human_edited and publish
 *   n — skip (next)
 *   q — quit
 */
import { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry } from '@devzen/remembug-shared';
import type { Store } from '@devzen/remembug-daemon';

interface Props {
  store: Store;
}

export function ReviewApp({ store }: Props): JSX.Element {
  const { exit } = useApp();
  const [pending, setPending] = useState<Entry[]>(() => store.listPending());
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<string>('');

  const current = pending[cursor];

  useInput((input) => {
    if (!current) {
      if (input === 'q') exit();
      return;
    }
    if (input === 'q') exit();
    if (input === 'n') {
      setCursor((c) => Math.min(c + 1, pending.length - 1));
      setStatus('skipped');
    }
    if (input === 'a') {
      store.updateEntry(current.id, { status: 'published' });
      setStatus(`published ${current.id.slice(0, 8)}`);
      advance();
    }
    if (input === 'r') {
      store.updateEntry(current.id, { status: 'rejected' });
      setStatus(`rejected ${current.id.slice(0, 8)}`);
      advance();
    }
    if (input === 'e') {
      const editor = process.env.EDITOR ?? 'vi';
      const tmp = mkdtempSync(join(tmpdir(), 'remembug-edit-'));
      const file = join(tmp, 'entry.md');
      writeFileSync(file, renderEntry(current), 'utf8');
      // spawnSync with an array — no shell, no injection surface.
      spawnSync(editor, [file], { stdio: 'inherit' });
      const edited = readFileSync(file, 'utf8');
      const parts = parseEntry(edited);
      store.updateEntry(current.id, {
        title: parts.title ?? current.title,
        problem_body: parts.problem_body ?? current.problem_body,
        solution_body: parts.solution_body ?? current.solution_body,
        origin: 'ai_drafted_human_edited',
        status: 'published',
      });
      setStatus(`edited and published ${current.id.slice(0, 8)}`);
      advance();
    }
  });

  useEffect(() => {
    if (pending.length === 0) {
      const t = setTimeout(() => exit(), 200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [pending, exit]);

  function advance(): void {
    const remaining = store.listPending();
    setPending(remaining);
    if (remaining.length === 0) return;
    setCursor((c) => (c >= remaining.length ? remaining.length - 1 : c));
  }

  if (!current) {
    return (
      <Box flexDirection="column">
        <Text color="green">no pending drafts.</Text>
        {status && <Text dimColor>last action: {status}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color="cyan">
        ({cursor + 1}/{pending.length}) {current.title}
      </Text>
      {current.tags.length > 0 && <Text dimColor>tags: {current.tags.join(', ')}</Text>}
      {current.stack.length > 0 && <Text dimColor>stack: {current.stack.join(', ')}</Text>}
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">— problem —</Text>
        <Text>{current.problem_body}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="yellow">— solution —</Text>
        <Text>{current.solution_body}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[a]ccept [r]eject [e]dit [n]ext [q]uit</Text>
      </Box>
      {status && (
        <Box marginTop={1}>
          <Text color="magenta">{status}</Text>
        </Box>
      )}
    </Box>
  );
}

function renderEntry(e: Entry): string {
  return [
    `# ${e.title}`,
    '',
    '## Problem',
    '',
    e.problem_body,
    '',
    '## Solution',
    '',
    e.solution_body,
    '',
  ].join('\n');
}

function parseEntry(md: string): {
  title?: string;
  problem_body?: string;
  solution_body?: string;
} {
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const problem = md.match(/##\s+Problem\s*\n+([\s\S]*?)(?=\n##\s|$)/);
  const solution = md.match(/##\s+Solution\s*\n+([\s\S]*?)$/);
  return {
    title: titleMatch?.[1]?.trim(),
    problem_body: problem?.[1]?.trim(),
    solution_body: solution?.[1]?.trim(),
  };
}
