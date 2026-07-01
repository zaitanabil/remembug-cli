/**
 * Locations and config loader used by every daemon entry point.
 *
 * The HOME-relative path is computed at runtime so tests can override
 * via env var (`REMEMBUG_HOME`) without monkey-patching `os.homedir`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RemembugConfigSchema, defaultConfig, type RemembugConfig } from '@devzen/remembug-shared';

export interface RemembugPaths {
  home: string;
  db: string;
  configFile: string;
  transcriptsDir: string;
  logsDir: string;
  pidFile: string;
  hooksDir: string;
}

export function remembugPaths(overrideHome?: string): RemembugPaths {
  const home = overrideHome ?? process.env.REMEMBUG_HOME ?? join(homedir(), '.remembug');
  return {
    home,
    db: join(home, 'remembug.db'),
    configFile: join(home, 'config.json'),
    transcriptsDir: join(home, 'transcripts'),
    logsDir: join(home, 'logs'),
    pidFile: join(home, 'daemon.pid'),
    hooksDir: join(home, 'hooks'),
  };
}

export function ensurePaths(paths: RemembugPaths = remembugPaths()): RemembugPaths {
  for (const dir of [paths.home, paths.transcriptsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(paths.configFile)) {
    writeConfig(defaultConfig(), paths);
  }
  return paths;
}

export function readConfig(paths: RemembugPaths = remembugPaths()): RemembugConfig {
  if (!existsSync(paths.configFile)) {
    return defaultConfig();
  }
  const raw = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  return RemembugConfigSchema.parse(raw);
}

export function writeConfig(config: RemembugConfig, paths: RemembugPaths = remembugPaths()): void {
  mkdirSync(paths.home, { recursive: true });
  writeFileAtomic(paths.configFile, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Write a file atomically: write a temp sibling, then rename over the target.
 * A crash or full disk mid-write can't leave a truncated file. Matters most
 * for the user's global ~/.claude config, which remembug edits — a half-written
 * settings.json would break their whole Claude Code setup.
 */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, mode !== undefined ? { mode } : 'utf8');
  renameSync(tmp, path);
}

/**
 * Source `~/.remembug/.env` into `process.env`. Lines are `KEY=value`,
 * `#` comments and blank lines are skipped. Existing env vars win
 * (so a shell `export` overrides the file).
 */
export function loadDotenv(paths: RemembugPaths = remembugPaths()): void {
  const envFile = join(paths.home, '.env');
  if (!existsSync(envFile)) return;
  const raw = readFileSync(envFile, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Resolve the LLM API key from `process.env`. Call {@link loadDotenv}
 * first if the user may have stored the key via `remembug config set
 * anthropic-key`. Returns undefined if nothing is set — callers should
 * refuse to start the drafter loop in that case.
 */
export function resolveApiKey(config: RemembugConfig): string | undefined {
  return process.env[config.llm.api_key_env];
}
