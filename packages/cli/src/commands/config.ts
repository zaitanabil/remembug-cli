import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { remembugPaths, ensurePaths, readConfig, writeConfig } from '@devzen/remembug-daemon';

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
        console.log(JSON.stringify(config, null, 2));
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
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
}
