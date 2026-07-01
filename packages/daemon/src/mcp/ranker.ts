/**
 * Hybrid search ranker.
 *
 * Combines BM25 (from FTS5) and cosine-similarity vector scores using
 * Reciprocal Rank Fusion (RRF), then applies a small bonus when the
 * candidate entry's stack overlaps the caller's project stack
 * fingerprint.
 *
 * RRF is robust to score-scale differences between BM25 and cosine and
 * doesn't need normalization or hand-tuned weights. The bonus is
 * additive in rank space, so it can't drown out a much stronger text
 * match.
 */
import type { Entry } from '@devzen/remembug-shared';

export interface KeywordCandidate {
  entry_id: string;
  /** BM25 score; lower is better in SQLite, so we expect raw values. */
  bm25_score: number;
}

export interface VectorCandidate {
  entry_id: string;
  /** Cosine distance; lower is better. */
  distance: number;
}

export interface RankedResult {
  entry: Entry;
  score: number;
}

export interface RankInput {
  keyword: KeywordCandidate[];
  vector: VectorCandidate[];
  entries: Map<string, Entry>;
  /**
   * Stack tokens for the caller's project (e.g. `['node@20','vite@5']`).
   * Used to boost entries whose stack overlaps.
   *
   * Accepted as either an array of tokens OR a space-joined string for
   * back-compat with the original interface — both flow through
   * {@link normalizeStack}.
   */
  projectStack?: string[] | string;
  /**
   * @deprecated use `projectStack`. Retained so callers passing the old
   * field continue to work.
   */
  projectStackFingerprint?: string;
  /** Soft cap on how many to return. Defaults to 20. */
  limit?: number;
}

const RRF_K = 60;
const STACK_BOOST = 0.05;

/**
 * Rank a set of FTS and vector hits. Pure function so it's easy to
 * regression-test.
 */
export function rank(input: RankInput): RankedResult[] {
  const scores = new Map<string, number>();

  input.keyword.forEach((c, i) => {
    add(scores, c.entry_id, 1 / (RRF_K + i + 1));
  });
  input.vector.forEach((c, i) => {
    add(scores, c.entry_id, 1 / (RRF_K + i + 1));
  });

  const stackSet = normalizeStack(input.projectStack ?? input.projectStackFingerprint);
  if (stackSet.size > 0) {
    for (const id of scores.keys()) {
      const e = input.entries.get(id);
      if (!e) continue;
      if (e.stack.some((t) => stackSet.has(stackKey(t)))) {
        add(scores, id, STACK_BOOST);
      }
    }
  }

  const results: RankedResult[] = [];
  for (const [id, score] of scores) {
    const entry = input.entries.get(id);
    if (!entry) continue;
    results.push({ entry, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, input.limit ?? 20);
}

function add(m: Map<string, number>, key: string, value: number): void {
  m.set(key, (m.get(key) ?? 0) + value);
}

function stackKey(token: string): string {
  return token.toLowerCase().trim();
}

function normalizeStack(input: string[] | string | undefined): Set<string> {
  if (!input) return new Set();
  const tokens = typeof input === 'string' ? input.split(/\s+/) : input;
  return new Set(tokens.map(stackKey).filter((t) => t.length > 0));
}
