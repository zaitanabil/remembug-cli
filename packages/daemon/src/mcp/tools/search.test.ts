import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalEmbedder } from '../../embeddings/index.js';
import { Store } from '../../store/index.js';
import { searchTool } from './search.js';

/**
 * End-to-end retrieval trust: relevant queries return the right entry,
 * unrelated queries return nothing. The "nothing" case is the load-bearing
 * one — an agent must be able to tell "not in the KB" from a real hit, so a
 * query about an unseeded topic must NOT surface the closest unrelated entry.
 */
describe('searchTool', () => {
  let dir: string;
  let store: Store;
  const embedder = new LocalEmbedder();

  const seed = [
    {
      title: 'Fix EADDRINUSE when running multiple vitest workers',
      problem_body:
        'Vitest workers fail to bind to a port when more than one suite runs in parallel. Error: listen EADDRINUSE address already in use 127.0.0.1:5173.',
      solution_body: 'Set poolOptions to single fork, or assign a unique port per worker.',
      tags: ['vitest', 'eaddrinuse', 'ports'],
      stack: ['node@20', 'vitest@2'],
    },
    {
      title: 'TypeError: Cannot read properties of undefined reading map in React list',
      problem_body:
        'Rendering a list crashes with Cannot read properties of undefined (reading map) because the API returned null before data loaded.',
      solution_body: 'Guard with data?.map(...) or initialise state to an empty array.',
      tags: ['react', 'typeerror'],
      stack: ['react@18'],
    },
    {
      title: 'Postgres connection pool exhausted under load',
      problem_body:
        'Under concurrent requests the pg pool throws remaining connection slots are reserved; queries hang then time out.',
      solution_body: 'Lower max pool size and release clients in a finally block.',
      tags: ['postgres', 'pool'],
      stack: ['pg@8'],
    },
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rb-search-'));
    store = new Store({ path: join(dir, 'x.db') });
    for (const e of seed) {
      const saved = store.insertEntry({
        ...e,
        fingerprint: e.title,
        origin: 'ai_drafted',
        status: 'published',
      });
      store.upsertVector(
        saved.id,
        await embedder.embed(`${e.title}\n${e.problem_body}\n${e.solution_body}`),
      );
    }
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const top = async (query: string) => {
    const r = await searchTool({ query }, { store, embedder });
    return { count: r.length, title: r[0]?.entry.title };
  };

  it('returns the right entry for an exact error string', async () => {
    const r = await top('listen EADDRINUSE address already in use');
    expect(r.title).toMatch(/EADDRINUSE/);
  });

  it('matches a paraphrase that shares content terms', async () => {
    const r = await top('component blows up calling map on null api data');
    expect(r.title).toMatch(/TypeError/);
  });

  it('returns NOTHING for an unrelated query (no false positive)', async () => {
    const r = await searchTool(
      { query: 'how do I center a div with flexbox' },
      { store, embedder },
    );
    expect(r).toEqual([]);
  });

  it('returns NOTHING for an all-stopword query', async () => {
    const r = await searchTool({ query: 'how do I do this with that' }, { store, embedder });
    expect(r).toEqual([]);
  });

  it('does not surface an unrelated entry alongside a real hit', async () => {
    const r = await searchTool(
      { query: 'listen EADDRINUSE address already in use' },
      { store, embedder },
    );
    expect(r.every((x) => /EADDRINUSE/.test(x.entry.title))).toBe(true);
  });
});

// Regression: BM25's IDF goes ~0/negative when a term appears in most of a
// tiny corpus, so any absolute bm25 floor wrongly drops real matches in a
// small KB. A single-entry KB must still find its own entry by a plain term.
describe('searchTool on a single-entry KB', () => {
  it('finds the only entry by a term it contains', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-1doc-'));
    const store = new Store({ path: join(dir, 'x.db') });
    const embedder = new LocalEmbedder();
    const e = store.insertEntry({
      title: 'Fix EADDRINUSE when running multiple vitest workers',
      problem_body:
        'Vitest workers fail to bind to a port; listen EADDRINUSE address already in use.',
      solution_body: 'Assign a unique port per worker.',
      tags: ['vitest', 'ports'],
      stack: ['node@20'],
      fingerprint: 'x',
      origin: 'ai_drafted',
      status: 'published',
    });
    store.upsertVector(e.id, await embedder.embed('EADDRINUSE vitest port'));

    const hit = await searchTool({ query: 'vitest' }, { store, embedder });
    expect(hit).toHaveLength(1);
    const miss = await searchTool({ query: 'center a div flexbox' }, { store, embedder });
    expect(miss).toEqual([]);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
