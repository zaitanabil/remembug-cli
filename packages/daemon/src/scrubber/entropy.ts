/**
 * Shannon entropy in bits per character for a single string.
 *
 * Random base64 approaches log2(64) = 6 bits/char. Random hex hashes
 * sit closer to log2(16) = 4 bits/char, which is why the default
 * threshold of 4.5 catches base64 secrets but not commit SHAs.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = s.length;
  for (const c of counts.values()) {
    const p = c / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Common low-entropy-but-long identifiers we don't want to redact.
 *
 * Hex hashes (40 chars), short SHAs, UUIDs, MD5s — all sit well below
 * 4.5 bits/char on their own, but we keep an explicit allowlist as
 * defense against a future tuning of the threshold that would otherwise
 * start flagging them.
 */
const HEX_HASH = /^[a-f0-9]{7,64}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function isHashLike(token: string): boolean {
  return HEX_HASH.test(token) || UUID.test(token);
}

/**
 * A filesystem path (absolute, home, relative, or Windows). Paths are a
 * useful signal — the project root is real context — not a secret. A long
 * or hashy path (temp dirs, content-addressed caches) can clear the entropy
 * threshold and get nuked, so the catch-all skips path-shaped tokens. Any
 * known secret embedded in a path is still caught by the earlier
 * pattern/env layers, which run first.
 */
export function looksLikePath(token: string): boolean {
  return (
    token.startsWith('/') ||
    token.startsWith('~/') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(token)
  );
}
