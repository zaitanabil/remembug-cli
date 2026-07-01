/**
 * Deterministic local embedder.
 *
 * Hashes tokens into a fixed-dimensional bag-of-words vector. Quality is
 * mediocre — comparable to a 2010-era keyword model — but it is
 * dependency-free, deterministic (great for tests), and lets the rest
 * of the system be exercised end-to-end without a network round trip or
 * API key. Because of this, retrieval is keyword-first (see
 * {@link ../mcp/tools/search.ts}): this vector only re-ranks keyword
 * hits, it never introduces a candidate on its own. A future
 * {@link EmbeddingProvider} backed by a real semantic model could relax
 * that — the interface is the only contract callers depend on.
 */
import { createHash } from 'node:crypto';
import { VECTOR_DIMENSION } from '../store/schema.js';
import type { EmbeddingProvider } from './types.js';

export class LocalEmbedder implements EmbeddingProvider {
  public readonly name = 'local-hash';
  public readonly dimensions = VECTOR_DIMENSION;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dimensions);
    const tokens = tokenize(text);
    for (const tok of tokens) {
      const idx = hashIndex(tok, this.dimensions);
      vec[idx]! += 1;
    }
    return l2Normalize(vec);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_+@.-]+/)
    .filter((t) => t.length > 1 && t.length < 64);
}

function hashIndex(token: string, dim: number): number {
  const h = createHash('sha1').update(token).digest();
  // Use first 4 bytes as uint32, then mod dim.
  const n = h.readUInt32BE(0);
  return n % dim;
}

function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return v;
}
