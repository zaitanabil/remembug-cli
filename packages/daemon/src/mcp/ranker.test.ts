import { describe, expect, it } from 'vitest';
import type { Entry } from '@devzen/remembug-shared';
import { rank } from './ranker.js';

function fixtureEntry(id: string, stack: string[] = []): Entry {
  return {
    id,
    title: `Entry ${id}`,
    problem_body: '',
    solution_body: '',
    tags: [],
    stack,
    fingerprint: id,
    origin: 'ai_drafted',
    status: 'published',
    confirmation_count: 1,
    created_at: 0,
    updated_at: 0,
  };
}

describe('ranker', () => {
  it('ranks keyword-only hits in input order', () => {
    const entries = new Map([
      ['a', fixtureEntry('a')],
      ['b', fixtureEntry('b')],
      ['c', fixtureEntry('c')],
    ]);
    const out = rank({
      keyword: [
        { entry_id: 'a', bm25_score: -2 },
        { entry_id: 'b', bm25_score: -1 },
        { entry_id: 'c', bm25_score: -0.5 },
      ],
      vector: [],
      entries,
    });
    expect(out.map((r) => r.entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('ranks vector-only hits in input order', () => {
    const entries = new Map([
      ['a', fixtureEntry('a')],
      ['b', fixtureEntry('b')],
    ]);
    const out = rank({
      keyword: [],
      vector: [
        { entry_id: 'b', distance: 0.1 },
        { entry_id: 'a', distance: 0.2 },
      ],
      entries,
    });
    expect(out[0]!.entry.id).toBe('b');
  });

  it('blends keyword and vector hits via RRF', () => {
    const entries = new Map([
      ['a', fixtureEntry('a')],
      ['b', fixtureEntry('b')],
    ]);
    const out = rank({
      // a ranks #1 in keyword, b ranks #1 in vector
      keyword: [
        { entry_id: 'a', bm25_score: -2 },
        { entry_id: 'b', bm25_score: -1 },
      ],
      vector: [
        { entry_id: 'b', distance: 0 },
        { entry_id: 'a', distance: 1 },
      ],
      entries,
    });
    // Both top-1 in one list, both #2 in the other → ~equal scores.
    expect(out[0]!.score).toBeCloseTo(out[1]!.score, 5);
  });

  it('an entry that appears in BOTH lists outranks single-list entries', () => {
    const entries = new Map([
      ['a', fixtureEntry('a')],
      ['b', fixtureEntry('b')],
      ['c', fixtureEntry('c')],
    ]);
    const out = rank({
      keyword: [
        { entry_id: 'b', bm25_score: -2 },
        { entry_id: 'a', bm25_score: -1 },
      ],
      vector: [
        { entry_id: 'b', distance: 0 },
        { entry_id: 'c', distance: 1 },
      ],
      entries,
    });
    expect(out[0]!.entry.id).toBe('b');
  });

  it('applies stack boost when project fingerprint matches an entry stack token', () => {
    const entries = new Map([
      ['a', fixtureEntry('a', ['node@20'])],
      ['b', fixtureEntry('b', ['python@3'])],
    ]);
    const fp = 'node@20 vite@5';
    const out = rank({
      keyword: [
        { entry_id: 'a', bm25_score: 0 },
        { entry_id: 'b', bm25_score: 0 },
      ],
      vector: [],
      entries,
      projectStackFingerprint: fp,
    });
    expect(out[0]!.entry.id).toBe('a');
  });

  it('returns no more than `limit` results', () => {
    const entries = new Map(
      Array.from({ length: 50 }, (_, i) => [String(i), fixtureEntry(String(i))]),
    );
    const out = rank({
      keyword: Array.from({ length: 50 }, (_, i) => ({
        entry_id: String(i),
        bm25_score: -i,
      })),
      vector: [],
      entries,
      limit: 5,
    });
    expect(out).toHaveLength(5);
  });

  it('drops entries that are not in the entries map (defensive)', () => {
    const entries = new Map([['a', fixtureEntry('a')]]);
    const out = rank({
      keyword: [
        { entry_id: 'a', bm25_score: 0 },
        { entry_id: 'missing', bm25_score: 0 },
      ],
      vector: [],
      entries,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.entry.id).toBe('a');
  });

  it('empty inputs produce empty output', () => {
    expect(rank({ keyword: [], vector: [], entries: new Map() })).toEqual([]);
  });
});
