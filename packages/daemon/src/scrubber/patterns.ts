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
