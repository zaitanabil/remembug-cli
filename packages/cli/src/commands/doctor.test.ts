import { describe, expect, it } from 'vitest';
import { referencesShim } from './doctor.js';

// The exact shape `remembug init` writes into ~/.claude/settings.json.
const initHookEntry = (shim: string) => [
  { matcher: '.*', hooks: [{ type: 'command', command: `node /home/u/.remembug/hooks/${shim}` }] },
];

describe('referencesShim', () => {
  it('matches the shape init writes, regardless of home dir', () => {
    expect(referencesShim(initHookEntry('post-tool-use.mjs'), 'post-tool-use.mjs')).toBe(true);
    expect(referencesShim(initHookEntry('stop.mjs'), 'stop.mjs')).toBe(true);
    // custom REMEMBUG_HOME (path has no "remembug" substring) must still match
    const custom = [{ hooks: [{ command: 'node /tmp/xyz/hooks/stop.mjs' }] }];
    expect(referencesShim(custom, 'stop.mjs')).toBe(true);
  });

  it('rejects wrong shim, missing hooks, and junk', () => {
    expect(referencesShim(initHookEntry('stop.mjs'), 'post-tool-use.mjs')).toBe(false);
    expect(referencesShim([{ matcher: '.*' }], 'stop.mjs')).toBe(false);
    expect(referencesShim(undefined, 'stop.mjs')).toBe(false);
    expect(referencesShim('nope', 'stop.mjs')).toBe(false);
  });
});
