/**
 * Provider-agnostic embedding contract.
 *
 * Anthropic does not ship an embeddings endpoint, so the default
 * provider is a deterministic local fallback (`LocalEmbedder`) good
 * enough for development and tests. For production we recommend
 * filling in `voyage.ts` — a stubbed adapter ready to wire up.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
}
