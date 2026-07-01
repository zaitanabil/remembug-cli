/**
 * `remembug.search` MCP tool.
 *
 * Keyword-first retrieval: FTS5 (BM25) decides which entries are
 * candidates, and the sqlite-vec cosine pass only re-ranks those hits —
 * it never introduces a candidate the keyword search didn't already find.
 * When no keyword hit clears the bar the tool returns an empty list on
 * purpose, so the agent learns "not in the KB" instead of being handed
 * the closest unrelated entry. Degrades to keyword-only when sqlite-vec
 * isn't available.
 */
import { z } from 'zod';
import type { Entry } from '@devzen/remembug-shared';
import type { EmbeddingProvider } from '../../embeddings/index.js';
import type { Store } from '../../store/index.js';
import { rank, type RankedResult } from '../ranker.js';

export const SearchInputSchema = z.object({
  query: z.string().min(1),
  project_path: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;

export interface SearchDeps {
  store: Store;
  embedder: EmbeddingProvider;
}

export async function searchTool(input: SearchInput, deps: SearchDeps): Promise<RankedResult[]> {
  const limit = input.limit ?? 10;

  // Keyword (FTS) decides *which* entries are candidates. The query is
  // stopword-stripped and noise-floored in the store, so a hit means the
  // entry genuinely shares content terms with the query. No hit ⇒ nothing
  // relevant ⇒ return [] so the agent learns "not in the KB" rather than
  // being handed the closest unrelated entry dressed up with a score.
  const keyword = deps.store.ftsSearch(input.query, limit * 2);
  if (keyword.length === 0) return [];
  const candidateIds = new Set(keyword.map((k) => k.entry_id));

  // Vector only *re-ranks* keyword candidates — it never introduces one.
  // The bag-of-words LocalEmbedder ranks some irrelevant entries closer
  // than relevant ones (measured), so an ungated vector hit is not a
  // trustworthy candidate. A future semantic embedder could relax this to
  // let vector surface keyword-less paraphrases.
  let vector: Awaited<ReturnType<typeof deps.store.vectorSearch>> = [];
  if (deps.store.hasVectorSupport) {
    const embedding = await deps.embedder.embed(input.query);
    vector = deps.store
      .vectorSearch(embedding, limit * 2)
      .filter((v) => candidateIds.has(v.entry_id));
  }

  const entries = new Map<string, Entry>();
  for (const id of candidateIds) {
    const e = deps.store.getEntry(id);
    if (e && e.status === 'published') entries.set(id, e);
  }

  const projectStack = input.project_path
    ? deps.store.projectStackTokensFor(input.project_path)
    : undefined;

  return rank({
    keyword,
    vector,
    entries,
    projectStack,
    limit,
  });
}
