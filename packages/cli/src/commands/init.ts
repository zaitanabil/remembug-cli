import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { remembugPaths, ensurePaths } from '@devzen/remembug-daemon';
import { hookShims } from './_hook-shims.js';

/**
 * `remembug init` — sets up ~/.remembug/, registers PostToolUse + Stop hooks
 * and the MCP server into Claude Code's config, and prints next steps.
 *
 * Existing Claude Code config is merged (never overwritten). New users
 * with no `~/.claude/settings.json` get one created.
 */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Create ~/.remembug and register hooks + MCP with Claude Code.')
    .option(
      '--claude-dir <path>',
      'Override Claude Code config directory.',
      join(homedir(), '.claude'),
    )
    .option('--dry-run', 'Show what would happen but make no changes.', false)
    .action(async (opts: { claudeDir: string; dryRun: boolean }) => {
      const paths = ensurePaths(remembugPaths());
      const settingsPath = join(opts.claudeDir, 'settings.json');
      const mcpPath = join(opts.claudeDir, 'mcp.json');

      const hookPostToolUse = join(paths.hooksDir, 'post-tool-use.mjs');
      const hookStop = join(paths.hooksDir, 'stop.mjs');

      const settingsPatch = {
        hooks: {
          PostToolUse: [
            {
              matcher: '.*',
              hooks: [{ type: 'command', command: `node ${hookPostToolUse}` }],
            },
          ],
          Stop: [
            {
              matcher: '.*',
              hooks: [{ type: 'command', command: `node ${hookStop}` }],
            },
          ],
        },
      };

      const mcpPatch = {
        mcpServers: {
          remembug: {
            command: 'remembug-mcp',
            args: [],
          },
        },
      };

      console.log('[remembug] paths:');

      console.log(`  home:     ${paths.home}`);

      console.log(`  db:       ${paths.db}`);

      console.log(`  config:   ${paths.configFile}`);

      if (opts.dryRun) {
        console.log('\n[remembug] would write hook shims into', paths.hooksDir);
        for (const shim of hookShims()) {
          console.log(`  ${shim.filename}  (${shim.contents.length} bytes)`);
        }
        console.log('\n[remembug] would merge into', settingsPath);
        console.log(JSON.stringify(settingsPatch, null, 2));
        console.log('\n[remembug] would merge into', mcpPath);
        console.log(JSON.stringify(mcpPatch, null, 2));
        return;
      }

      writeHookShims(paths.hooksDir);
      mergeJsonInto(settingsPath, settingsPatch);
      mergeJsonInto(mcpPath, mcpPatch);

      console.log(`
[remembug] init complete.

Next steps:
  1. Set your LLM API key:
       export REMEMBUG_ANTHROPIC_KEY=sk-ant-...
     or: remembug config set anthropic-key sk-ant-...

  2. Start the daemon:
       remembug daemon start

  3. Use Claude Code normally. Solved problems will be captured for review.
  4. Approve drafts:
       remembug review

  5. Search the KB:
       remembug search "EADDRINUSE vitest"
`);
    });
}

function mergeJsonInto(path: string, patch: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      console.warn(`[remembug] warning: ${path} exists but is not valid JSON; leaving untouched.`);
      return;
    }
  }
  const merged = deepMerge(current, patch);
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

function writeHookShims(hooksDir: string): void {
  mkdirSync(hooksDir, { recursive: true });
  for (const shim of hookShims()) {
    const target = join(hooksDir, shim.filename);
    writeFileSync(target, shim.contents, 'utf8');
    if (shim.contents.startsWith('#!')) {
      try {
        chmodSync(target, 0o755);
      } catch {
        // best-effort; on Windows chmod is a no-op
      }
    }
  }
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    if (Array.isArray(existing) && Array.isArray(v)) {
      // Dedupe by structural equality so re-running `init` is idempotent.
      // Without this, the hook arrays grow on every run and Claude Code
      // POSTs to the daemon twice (then thrice…) per tool call.
      const seen = new Set(existing.map((x) => JSON.stringify(x)));
      out[k] = [...existing, ...v.filter((x) => !seen.has(JSON.stringify(x)))];
    } else if (
      existing &&
      typeof existing === 'object' &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
