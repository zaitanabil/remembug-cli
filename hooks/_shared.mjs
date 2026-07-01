import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PORT = 7842;

/** Read just the bits of Remembug config the shims need. Falls back to defaults. */
export function readConfigSync() {
  const home = process.env.REMEMBUG_HOME ?? join(homedir(), '.remembug');
  const cfgPath = join(home, 'config.json');
  if (!existsSync(cfgPath)) return { daemon: { port: DEFAULT_PORT } };
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return { daemon: { port: DEFAULT_PORT } };
  }
}
