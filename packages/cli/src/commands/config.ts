import { chmodSync, existsSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';
import {
  remembugPaths,
  ensurePaths,
  readConfig,
  writeConfig,
  writeFileAtomic,
} from '@devzen/remembug-daemon';

/** Obvious secret shapes we must never let land in the plaintext config.json. */
const SECRET_VALUE =
  /^(sk-ant-|sk-|rk_|pk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abprs]-|AKIA|AIza)/;

/**
 * `remembug config <get|set> <key> [value]` — minimal config CRUD.
 *
 * Special-case shorthand: `remembug config set anthropic-key VALUE` stores
 * the key into the env-var slot the user named in their config, written
 * to a `~/.remembug/.env` file the daemon sources at start. This avoids
 * shelling out to keytar in v0.1 while still keeping the key out of
 * the config JSON.
 */
export function registerConfig(program: Command): void {
  const cfg = program.command('config').description('Get or set Remembug configuration.');

  cfg
    .command('get')
    .argument('[key]', 'Dotted key path, e.g. llm.model.')
    .action((key?: string) => {
      const config = readConfig(remembugPaths());
      if (!key) {
        console.log(JSON.stringify(redactSecretValues(config), null, 2));
        return;
      }
      const value = resolveDotted(config as unknown as Record<string, unknown>, key);

      console.log(value === undefined ? '<unset>' : JSON.stringify(value));
    });

  cfg
    .command('set')
    .argument('<key>', 'Dotted key path or a shorthand like "anthropic-key".')
    .argument('<value>', 'New value.')
    .action((key: string, value: string) => {
      const paths = ensurePaths(remembugPaths());
      const config = readConfig(paths);
      if (key === 'anthropic-key') {
        const envName = config.llm.api_key_env;
        writeEnvFile(paths.home, envName, value);

        console.log(`[remembug] stored ${envName} in ${paths.home}/.env`);
        return;
      }
      // Never let a secret land in the plaintext, world-readable config.json.
      if (SECRET_VALUE.test(value)) {
        console.error(
          `[remembug] that value looks like a secret; refusing to write it to config.json.\n` +
            `           store keys with: remembug config set anthropic-key <value>`,
        );
        process.exitCode = 1;
        return;
      }
      setDotted(config as unknown as Record<string, unknown>, key, parseValue(value));
      writeConfig(config, paths);

      console.log(`[remembug] set ${key}`);
    });
}

function resolveDotted(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object' && k in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

function setDotted(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (!cursor[k] || typeof cursor[k] !== 'object') cursor[k] = {};
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

function writeEnvFile(home: string, key: string, value: string): void {
  const path = `${home}/.env`;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing.split('\n').filter((l) => l.trim() && !l.startsWith(`${key}=`));
  lines.push(`${key}=${value}`);
  writeFileAtomic(path, lines.join('\n') + '\n', 0o600);
  // The mode arg only applies when creating the file; enforce 600 even if a
  // prior .env already existed with looser permissions.
  chmodSync(path, 0o600);
}

/** Redact any string value that looks like a secret before printing config. */
function redactSecretValues(value: unknown): unknown {
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? '[REDACTED]' : value;
  if (Array.isArray(value)) return value.map(redactSecretValues);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactSecretValues(v)]),
    );
  }
  return value;
}
