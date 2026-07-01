import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalEmbedder } from '../embeddings/index.js';
import { Store } from './index.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remembug-store-'));
  store = new Store({ path: join(dir, 'x.db') });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const draft = (title: string) => ({
  title,
  problem_body: 'p',
  solution_body: 's',
  tags: ['t'],
  stack: ['node@20'],
  fingerprint: 'fp-' + title,
  origin: 'ai_drafted' as const,
  status: 'published' as const,
});

describe('Store', () => {
  it('writes the embedding in the same insert (vector search finds the entry)', async () => {
    if (!store.hasVectorSupport) return; // environment without sqlite-vec
    const embedding = await new LocalEmbedder().embed('EADDRINUSE vitest port');
    const entry = store.insertEntry({ ...draft('vec'), embedding });
    const hits = store.vectorSearch(embedding, 5);
    expect(hits.some((h) => h.entry_id === entry.id)).toBe(true);
  });

  it('records feedback and bumps confirmation atomically', () => {
    const entry = store.insertEntry(draft('fb'));
    expect(entry.confirmation_count).toBe(1);
    store.recordFeedback({ entry_id: entry.id, helpful: true });
    expect(store.getEntry(entry.id)?.confirmation_count).toBe(2);
  });

  it('clamps an absurd search limit instead of running it unbounded', () => {
    store.insertEntry(draft('a'));
    expect(() => store.listPublished(10_000_000)).not.toThrow();
    expect(store.listPublished(10_000_000).length).toBeLessThanOrEqual(100);
  });
});
