import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function tmpDir(): string {
  return join(tmpdir(), `remembug-test-${randomUUID()}`);
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('uninstall — JSON removal logic', () => {
  let root: string;
  let claudeDir: string;

  beforeEach(() => {
    root = tmpDir();
    claudeDir = join(root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should remove remembug hooks from settings.json', async () => {
    const settingsPath = join(claudeDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: 'node /home/user/.remembug/hooks/post-tool-use.mjs' },
            ],
          },
        ],
        Stop: [
          {
            matcher: '.*',
            hooks: [{ type: 'command', command: 'node /home/user/.remembug/hooks/stop.mjs' }],
          },
        ],
      },
    });

    const { removeHooksFromSettings } = await import('../uninstall.js');
    removeHooksFromSettings(settingsPath, '/home/user/.remembug/hooks', false);

    const result = readJson<{ hooks: { PostToolUse: unknown[]; Stop: unknown[] } }>(settingsPath);
    expect(result.hooks.PostToolUse).toEqual([]);
    expect(result.hooks.Stop).toEqual([]);
  });

  // Regression: a custom REMEMBUG_HOME (e.g. /tmp/rb) produces hook command
  // paths with no "remembug" substring. Removal must key off the shim
  // filenames init writes, or uninstall silently leaves the hooks behind.
  it('removes hooks even when the home path has no "remembug" substring', async () => {
    const settingsPath = join(claudeDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [{ type: 'command', command: 'node /tmp/rb/hooks/post-tool-use.mjs' }],
          },
        ],
        Stop: [
          { matcher: '.*', hooks: [{ type: 'command', command: 'node /tmp/rb/hooks/stop.mjs' }] },
        ],
      },
    });

    const { removeHooksFromSettings } = await import('../uninstall.js');
    removeHooksFromSettings(settingsPath, '/tmp/rb/hooks', false);

    const result = readJson<{ hooks: { PostToolUse: unknown[]; Stop: unknown[] } }>(settingsPath);
    expect(result.hooks.PostToolUse).toEqual([]);
    expect(result.hooks.Stop).toEqual([]);
  });

  it('should preserve non-remembug hooks', async () => {
    const settingsPath = join(claudeDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: 'node /home/user/.remembug/hooks/post-tool-use.mjs' },
            ],
          },
          {
            matcher: '.*',
            hooks: [{ type: 'command', command: 'echo "my custom hook"' }],
          },
        ],
      },
    });

    const { removeHooksFromSettings } = await import('../uninstall.js');
    removeHooksFromSettings(settingsPath, '/home/user/.remembug/hooks', false);

    const result = readJson<{
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    }>(settingsPath);
    expect(result.hooks.PostToolUse).toHaveLength(1);
    expect(result.hooks.PostToolUse[0].hooks?.[0].command).toBe('echo "my custom hook"');
  });

  it('should keep empty arrays after removal (not delete the key)', async () => {
    const settingsPath = join(claudeDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: 'node /home/user/.remembug/hooks/post-tool-use.mjs' },
            ],
          },
        ],
      },
      otherKey: 'preserved',
    });

    const { removeHooksFromSettings } = await import('../uninstall.js');
    removeHooksFromSettings(settingsPath, '/home/user/.remembug/hooks', false);

    const result = readJson<Record<string, unknown>>(settingsPath);
    expect(Array.isArray((result.hooks as Record<string, unknown>).PostToolUse)).toBe(true);
    expect((result.hooks as Record<string, unknown>).PostToolUse).toEqual([]);
    expect(result.otherKey).toBe('preserved');
  });

  it('should be idempotent — second run is a no-op', async () => {
    const settingsPath = join(claudeDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: 'node /home/user/.remembug/hooks/post-tool-use.mjs' },
            ],
          },
        ],
      },
    });

    const { removeHooksFromSettings } = await import('../uninstall.js');
    removeHooksFromSettings(settingsPath, '/home/user/.remembug/hooks', false);
    const content1 = readFileSync(settingsPath, 'utf8');

    removeHooksFromSettings(settingsPath, '/home/user/.remembug/hooks', false);
    const content2 = readFileSync(settingsPath, 'utf8');

    expect(content1).toBe(content2);
  });

  it('should do nothing when settings.json has no remembug entries', async () => {
    const settingsPath = join(claudeDir, 'settings.json');
    const original = {
      hooks: { PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    };
    writeJson(settingsPath, original);

    const { removeHooksFromSettings } = await import('../uninstall.js');
    removeHooksFromSettings(settingsPath, '/home/user/.remembug/hooks', false);

    expect(readJson(settingsPath)).toEqual(original);
  });
});

describe('uninstall — MCP removal logic', () => {
  let root: string;
  let claudeDir: string;

  beforeEach(() => {
    root = tmpDir();
    claudeDir = join(root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should remove mcpServers.remembug from mcp.json', async () => {
    const mcpPath = join(claudeDir, 'mcp.json');
    writeJson(mcpPath, {
      mcpServers: {
        remembug: { command: 'remembug-mcp', args: [] },
        otherServer: { command: 'other', args: [] },
      },
    });

    const { removeMcpEntry } = await import('../uninstall.js');
    removeMcpEntry(mcpPath, false);

    const result = readJson<{ mcpServers: Record<string, unknown> }>(mcpPath);
    expect(result.mcpServers.remembug).toBeUndefined();
    expect(result.mcpServers.otherServer).toBeDefined();
  });

  it('should be idempotent for MCP removal', async () => {
    const mcpPath = join(claudeDir, 'mcp.json');
    writeJson(mcpPath, {
      mcpServers: {
        remembug: { command: 'remembug-mcp', args: [] },
      },
    });

    const { removeMcpEntry } = await import('../uninstall.js');
    removeMcpEntry(mcpPath, false);
    const content1 = readFileSync(mcpPath, 'utf8');

    removeMcpEntry(mcpPath, false);
    const content2 = readFileSync(mcpPath, 'utf8');

    expect(content1).toBe(content2);
  });

  it('should do nothing when no remembug entry exists', async () => {
    const mcpPath = join(claudeDir, 'mcp.json');
    const original = { mcpServers: { foo: { command: 'foo' } } };
    writeJson(mcpPath, original);

    const { removeMcpEntry } = await import('../uninstall.js');
    removeMcpEntry(mcpPath, false);

    expect(readJson(mcpPath)).toEqual(original);
  });
});

describe('uninstall — dry-run mode', () => {
  let root: string;
  let claudeDir: string;

  beforeEach(() => {
    root = tmpDir();
    claudeDir = join(root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should not modify files in dry-run mode', async () => {
    const settingsPath = join(claudeDir, 'settings.json');
    const mcpPath = join(claudeDir, 'mcp.json');
    const settingsOriginal = {
      hooks: {
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: 'node /home/user/.remembug/hooks/post-tool-use.mjs' },
            ],
          },
        ],
      },
    };
    const mcpOriginal = {
      mcpServers: {
        remembug: { command: 'remembug-mcp', args: [] },
      },
    };
    writeJson(settingsPath, settingsOriginal);
    writeJson(mcpPath, mcpOriginal);

    const { removeHooksFromSettings, removeMcpEntry } = await import('../uninstall.js');
    removeHooksFromSettings(settingsPath, '/home/user/.remembug/hooks', true);
    removeMcpEntry(mcpPath, true);

    expect(readJson(settingsPath)).toEqual(settingsOriginal);
    expect(readJson(mcpPath)).toEqual(mcpOriginal);
  });
});
