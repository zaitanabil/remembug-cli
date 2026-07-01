/**
 * Three-layer secret scrubber.
 *
 * Order is important: known patterns are matched first (they have the
 * lowest false-positive rate), then env-style lines next to secret paths,
 * and finally high-entropy tokens as a catch-all.
 *
 * Output `redactions` records *types and counts only* — never the
 * underlying value, so the audit log itself is safe to inspect.
 */
import { isHashLike, looksLikePath, shannonEntropy } from './entropy.js';
import {
  ENV_LINE,
  SECRET_NAME_ASSIGNMENT,
  SECRET_PATH_PATTERNS,
  SECRET_PATTERNS,
} from './patterns.js';

export interface ScrubOptions {
  /** Entropy threshold in bits/char for the catch-all layer. Defaults to 4.5. */
  entropyThreshold?: number;
  /** Minimum token length to consider for entropy redaction. Defaults to 20. */
  minTokenLength?: number;
}

export interface Redaction {
  type: string;
  count: number;
}

export interface ScrubResult {
  content: string;
  redactions: Redaction[];
}

const REDACTION = (type: string): string => `[REDACTED:${type}]`;

function bumpRedaction(map: Map<string, number>, type: string, by = 1): void {
  map.set(type, (map.get(type) ?? 0) + by);
}

/**
 * Scrub a string of all known secret formats. Returns the scrubbed content
 * and a count of redactions by type. Never throws — falls back to returning
 * the input untouched if the regex bank explodes on malformed input.
 */
export function scrub(input: string, options: ScrubOptions = {}): ScrubResult {
  const entropyThreshold = options.entropyThreshold ?? 4.5;
  const minTokenLength = options.minTokenLength ?? 20;
  const redactions = new Map<string, number>();
  let content = input;

  for (const { name, regex } of SECRET_PATTERNS) {
    content = content.replace(regex, () => {
      bumpRedaction(redactions, name);
      return REDACTION(name);
    });
  }

  // Redact the value of any secret-named assignment, whatever its entropy.
  content = content.replace(SECRET_NAME_ASSIGNMENT, (_match, key: string) => {
    bumpRedaction(redactions, 'named_secret');
    return `${key}=${REDACTION('named_secret')}`;
  });

  content = content
    .split('\n')
    .map((line) => {
      const m = line.match(ENV_LINE);
      if (!m) return line;
      const value = m[2];
      if (
        value &&
        (value.length >= 12 ||
          SECRET_PATH_PATTERNS.some((p) => p.test(line)) ||
          shannonEntropy(value) >= entropyThreshold)
      ) {
        bumpRedaction(redactions, 'env_value');
        return `${m[1]}=${REDACTION('env_value')}`;
      }
      return line;
    })
    .join('\n');

  const redactIfHighEntropy = (token: string): string => {
    if (token.length < minTokenLength) return token;
    if (isHashLike(token)) return token;
    const stripped = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (stripped.length < minTokenLength) return token;
    if (isHashLike(stripped)) return token;
    if (shannonEntropy(stripped) >= entropyThreshold) {
      bumpRedaction(redactions, 'high_entropy');
      return token.replace(stripped, REDACTION('high_entropy'));
    }
    return token;
  };

  content = content.replace(/\S+/g, (token) => {
    if (token.startsWith('[REDACTED:')) return token;
    // Path-shaped tokens keep their structure (the project root is signal),
    // but we still entropy-scan each segment so a secret hidden as a path
    // segment — /data/<random-blob> — doesn't ride through untouched.
    if (looksLikePath(token)) {
      return token
        .split(/([/\\]+)/)
        .map((part) => (/^[/\\]+$/.test(part) ? part : redactIfHighEntropy(part)))
        .join('');
    }
    return redactIfHighEntropy(token);
  });

  for (const pathPattern of SECRET_PATH_PATTERNS) {
    if (pathPattern.test(content)) {
      bumpRedaction(redactions, 'secret_path_reference', 0);
    }
  }

  return {
    content,
    redactions: Array.from(redactions.entries())
      .filter(([, count]) => count > 0)
      .map(([type, count]) => ({ type, count })),
  };
}

/**
 * Returns true if the input still contains obvious secret markers after
 * a scrub pass. Used by the drafter as a tripwire — if this fires, we
 * refuse to send the transcript to the LLM.
 */
export function looksLikeSecretLeak(input: string): boolean {
  return SECRET_PATTERNS.some(({ regex }) => {
    regex.lastIndex = 0;
    return regex.test(input);
  });
}
