/**
 * Pattern bank for known-secret formats.
 *
 * Order matters within `index.ts` only for the *reporting* — we apply all
 * patterns in a single regex pass. Each entry's `name` is what gets surfaced
 * in the redaction log so users can audit *that* something was scrubbed
 * without ever learning *what*.
 */
export interface SecretPattern {
  name: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'aws_access_key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  // NOTE: AWS *secret* access keys have no reliable prefix — they're 40 random
  // base64 chars indistinguishable from arbitrary data without context. We
  // intentionally don't pattern-match them here; the entropy detector below
  // catches the real ones without flagging hex commit SHAs.
  {
    name: 'github_token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    name: 'github_fine_grained_pat',
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: 'private_key_block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'openssh_private_key',
    regex: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
  },
  {
    name: 'slack_token',
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'stripe_key',
    regex: /\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'openai_key',
    regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'anthropic_key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'google_api_key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
];

/**
 * Path patterns whose *contents* we treat as secrets by default. Any line that
 * matches one of these paths — or a fenced block of text immediately following
 * such a line — gets redacted wholesale.
 */
export const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|[\s/])\.env(\.[A-Za-z0-9_-]+)?\b/,
  /(^|[\s/])secrets\//,
  /(^|[\s/])credentials?\//,
  /\.pem\b/,
  /\.key\b/,
  /id_rsa(?:\.pub)?/,
  /id_ed25519(?:\.pub)?/,
];

/** A key=value line that looks like dotenv contents. */
export const ENV_LINE = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$/;

/**
 * `key=value` where the key NAME looks like a credential — redact the value
 * regardless of case, position, or entropy. This is the layer that catches
 * secrets the entropy detector misses: an all-lowercase value (lowercasing
 * drops Shannon entropy below the threshold) or a hex token (allowlisted as
 * hash-like), e.g. `token=<hex>` or `aws_secret_access_key=<val>` sitting
 * mid-sentence in an error dump. Group 1 is the key (kept); the value is cut.
 */
export const SECRET_NAME_ASSIGNMENT =
  /([A-Za-z0-9_.-]*(?:secret|token|password|passwd|passphrase|credentials?|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|client[_-]?secret)[A-Za-z0-9_.-]*)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi;

/**
 * The same credential-named key, but serialized as JSON/YAML `"key": value`.
 * The key must be quoted so we don't nuke `host:port` or `12:34:56`; the value
 * (quoted, or an unquoted run up to a delimiter) is redacted. Group 1 is the
 * key. This is the dominant real-world shape (any JSON logger emits it) and the
 * `=`-only pass above misses it.
 */
export const SECRET_NAME_JSON =
  /"([A-Za-z0-9_.-]*(?:secret|token|password|passwd|passphrase|credentials?|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|client[_-]?secret)[A-Za-z0-9_.-]*)"\s*:\s*("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;

/**
 * Credentials embedded in a `scheme://user:pass@host` URL. The whole token can
 * dip below the entropy threshold (short/repetitive password + long host tail),
 * so it survives the catch-all. Redact only the `user:pass`, keeping scheme and
 * host as debugging context. Group 1 is the scheme prefix.
 */
export const CONNECTION_STRING_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi;
