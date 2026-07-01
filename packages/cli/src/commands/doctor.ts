import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { remembugPaths, readConfig, loadDotenv, pingLlm, Store } from '@devzen/remembug-daemon';

/**
 * `remembug doctor` — one command that answers "why isn't anything being
 * captured?". Every step in the install chain fails silently (daemon
 * detaches without a word, hook shims swallow errors, MCP needs a Claude
 * Code restart nobody mentions), so a brand-new user has no way to tell
 * which link is broken. Doctor probes each link and prints a fix hint.
 *
 * Read-only: never creates dirs, never writes config. Exits non-zero if
 * any hard check fails, so it's CI/script friendly too.
 */
type Status = 'ok' | 'warn' | 'fail';

interface Check {
  status: Status;
  label: string;
  detail: string;
  /** Shown only when not ok. */
  fix?: string;
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose the install: config, API key, daemon, hooks, MCP, store.')
    .option(
      '--claude-dir <path>',
      'Override Claude Code config directory.',
      join(homedir(), '.claude'),
    )
    .action(async (opts: { claudeDir: string }) => {
      const checks = await runChecks(opts.claudeDir);
      print(checks);
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    });
}

async function runChecks(claudeDir: string): Promise<Check[]> {
  const paths = remembugPaths();
  const checks: Check[] = [];

  // 1. ~/.remembug + config
  const homeExists = existsSync(paths.home);
  checks.push({
    status: homeExists ? 'ok' : 'fail',
    label: 'Remembug home',
    detail: homeExists ? paths.home : `missing: ${paths.home}`,
    fix: 'run: remembug init',
  });

  const config = readConfig(paths); // returns defaults if file absent

  // 2. LLM reachable — a live ping, not just "is the key set". Catches a
  // bad key, a rejected model id, no network, or an unpulled Ollama model.
  loadDotenv(paths);
  const ping = await pingLlm(config, { timeoutMs: 6000 });
  checks.push({
    status: ping.status,
    label: `LLM (${config.llm.provider})`,
    detail: ping.detail,
    fix: ping.fix,
  });

  // 3. Daemon reachable
  checks.push(await probeDaemon(config.daemon.port));

  // 4. Claude Code hooks wired
  checks.push(checkHooks(join(claudeDir, 'settings.json'), paths.hooksDir));

  // 5. MCP server wired
  checks.push(checkMcp(join(claudeDir, 'mcp.json')));

  // 6. Store + entry counts
  checks.push(checkStore(paths.db));

  return checks;
}

async function probeDaemon(port: number): Promise<Check> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (res.ok) {
      return { status: 'ok', label: 'Daemon', detail: `up on port ${port}` };
    }
  } catch {
    // not reachable
  }
  return {
    status: 'fail',
    label: 'Daemon',
    detail: `not reachable on port ${port}`,
    fix: 'remembug daemon start  (then check ~/.remembug/logs/daemon.log if it stays down)',
  };
}

function checkHooks(settingsPath: string, hooksDir: string): Check {
  const json = readJson(settingsPath);
  if (!json) {
    return {
      status: 'fail',
      label: 'Claude Code hooks',
      detail: existsSync(settingsPath)
        ? `${settingsPath} is not valid JSON`
        : `${settingsPath} missing`,
      fix: 'run: remembug init',
    };
  }
  const hooks = (json.hooks ?? {}) as Record<string, unknown>;
  const wired =
    referencesShim(hooks.PostToolUse, 'post-tool-use.mjs') &&
    referencesShim(hooks.Stop, 'stop.mjs');
  if (!wired) {
    return {
      status: 'fail',
      label: 'Claude Code hooks',
      detail: 'PostToolUse/Stop hooks not pointing at Remembug shims',
      fix: 'run: remembug init',
    };
  }
  // Shims referenced in settings must actually exist on disk.
  const shimsPresent =
    existsSync(join(hooksDir, 'post-tool-use.mjs')) && existsSync(join(hooksDir, 'stop.mjs'));
  if (!shimsPresent) {
    return {
      status: 'fail',
      label: 'Claude Code hooks',
      detail: `shim files missing in ${hooksDir}`,
      fix: 'run: remembug init',
    };
  }
  return { status: 'ok', label: 'Claude Code hooks', detail: 'PostToolUse + Stop wired' };
}

function checkMcp(mcpPath: string): Check {
  const json = readJson(mcpPath);
  const server = json && (json.mcpServers as Record<string, unknown> | undefined)?.remembug;
  if (!server) {
    return {
      status: 'fail',
      label: 'MCP server',
      detail: existsSync(mcpPath) ? 'remembug entry absent from mcp.json' : `${mcpPath} missing`,
      fix: 'run: remembug init',
    };
  }
  return {
    status: 'ok',
    label: 'MCP server',
    detail: 'registered (restart Claude Code if you just ran init)',
  };
}

function checkStore(dbPath: string): Check {
  if (!existsSync(dbPath)) {
    return {
      status: 'warn',
      label: 'Knowledge base',
      detail: 'no database yet (created on first daemon start)',
      fix: 'remembug daemon start',
    };
  }
  let store: Store | undefined;
  try {
    store = new Store({ path: dbPath });
    const published = store.listPublished(100000).length;
    const pending = store.listPending().length;
    const vec = store.hasVectorSupport ? 'vector search on' : 'vector search off (FTS only)';
    return {
      status: 'ok',
      label: 'Knowledge base',
      detail: `${published} published, ${pending} pending review — ${vec}`,
    };
  } catch (e) {
    return {
      status: 'fail',
      label: 'Knowledge base',
      detail: `cannot open ${dbPath}: ${e instanceof Error ? e.message : e}`,
    };
  }
}

export function referencesShim(entry: unknown, shimFile: string): boolean {
  // settings.json shape: [{ matcher, hooks: [{ type:'command', command:'node /…/x.mjs' }] }]
  if (!Array.isArray(entry)) return false;
  return entry.some((group) =>
    Array.isArray((group as { hooks?: unknown }).hooks)
      ? (group as { hooks: Array<{ command?: string }> }).hooks.some(
          (h) => typeof h.command === 'string' && h.command.includes(shimFile),
        )
      : false,
  );
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const ICON: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' };

function print(checks: Check[]): void {
  console.log('[remembug] doctor\n');
  for (const c of checks) {
    console.log(`  ${ICON[c.status]} ${c.label.padEnd(20)} ${c.detail}`);
    if (c.status !== 'ok' && c.fix) console.log(`      ↳ ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  console.log(
    `\n[remembug] ${fails ? `${fails} problem(s)` : 'all systems go'}${
      warns ? `, ${warns} warning(s)` : ''
    }.`,
  );
}
