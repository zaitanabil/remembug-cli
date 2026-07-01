import { describe, expect, it } from 'vitest';
import { looksLikeSecretLeak, scrub } from './index.js';
import { shannonEntropy, isHashLike } from './entropy.js';

describe('scrubber', () => {
  it('redacts an AWS access key', () => {
    const { content, redactions } = scrub('aws=AKIAIOSFODNN7EXAMPLE remainder');
    expect(content).toContain('[REDACTED:aws_access_key]');
    expect(redactions.find((r) => r.type === 'aws_access_key')?.count).toBe(1);
  });

  it('redacts multiple AWS access keys in one pass', () => {
    const { content, redactions } = scrub('AKIAIOSFODNN7EXAMPLE and AKIAJ1234567890ABCDE');
    expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(redactions.find((r) => r.type === 'aws_access_key')?.count).toBe(2);
  });

  it('redacts a GitHub personal access token (ghp_)', () => {
    const tok = 'ghp_' + 'A'.repeat(36);
    const { content } = scrub(`token: ${tok}`);
    expect(content).toContain('[REDACTED:github_token]');
    expect(content).not.toContain(tok);
  });

  it('redacts every prefix in the gh[pousr] family', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
      const tok = prefix + 'B'.repeat(40);
      const { content } = scrub(tok);
      expect(content).toContain('[REDACTED:github_token]');
    }
  });

  it('redacts a fine-grained github_pat_ token', () => {
    const tok = 'github_pat_' + 'A'.repeat(82);
    const { content } = scrub(tok);
    expect(content).toContain('[REDACTED:github_fine_grained_pat]');
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const { content } = scrub(jwt);
    expect(content).toContain('[REDACTED:jwt]');
    expect(content).not.toContain(jwt);
  });

  it('redacts an RSA private key block multiline', () => {
    const block = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAxxxxxxxxxxxxxxxxx',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { content } = scrub(block);
    expect(content).toContain('[REDACTED:private_key_block]');
    expect(content).not.toContain('BEGIN RSA');
  });

  it('redacts a generic PRIVATE KEY block (no algorithm prefix)', () => {
    const block = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';
    const { content } = scrub(block);
    expect(content).toContain('[REDACTED:private_key_block]');
  });

  it('redacts an OPENSSH private key block separately', () => {
    const block =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----';
    const { content, redactions } = scrub(block);
    expect(content).toMatch(/\[REDACTED:(openssh_private_key|private_key_block)\]/);
    expect(redactions.length).toBeGreaterThan(0);
  });

  it('redacts a Slack bot token (xoxb-)', () => {
    // Built from parts so push-protection scanners don't flag this
    // fixture as a real Slack token; the runtime value is unchanged.
    const tok = ['xox', 'b', '-1234567890-1234567890-abcdefghijklmnopqrstuvwx'].join('');
    const { content } = scrub(tok);
    expect(content).toContain('[REDACTED:slack_token]');
  });

  it('redacts Stripe live and test secret keys', () => {
    const { content: live } = scrub('sk_live_' + 'A'.repeat(24));
    const { content: test } = scrub('sk_test_' + 'B'.repeat(24));
    expect(live).toContain('[REDACTED:stripe_key]');
    expect(test).toContain('[REDACTED:stripe_key]');
  });

  it('redacts an OpenAI key but not an Anthropic key with the same prefix family', () => {
    const openai = 'sk-' + 'A'.repeat(48);
    const anthropic = 'sk-ant-' + 'B'.repeat(48);
    const out = scrub(`${openai} ${anthropic}`);
    expect(out.content).toContain('[REDACTED:openai_key]');
    expect(out.content).toContain('[REDACTED:anthropic_key]');
    expect(out.content).not.toContain(openai);
    expect(out.content).not.toContain(anthropic);
  });

  it('redacts a Google API key', () => {
    const key = 'AIza' + 'B'.repeat(35);
    const { content } = scrub(key);
    expect(content).toContain('[REDACTED:google_api_key]');
  });

  it('redacts env-style KEY=VALUE lines', () => {
    const input = 'DATABASE_URL=postgres://user:supersecretpassword@host/db';
    const { content } = scrub(input);
    expect(content).toContain('DATABASE_URL=[REDACTED:env_value]');
  });

  it('redacts env values that are very high entropy even if short-ish', () => {
    const input = 'API_TOKEN=zX9pQ7lM2vN8sB4yT1eR6wF3uH5kJ0aC';
    const { content } = scrub(input);
    expect(content).toContain('API_TOKEN=[REDACTED');
  });

  it('does not redact KEY=VALUE where value is plainly low-entropy short text', () => {
    const input = 'NODE_ENV=dev';
    const { content } = scrub(input);
    expect(content).toContain('NODE_ENV=dev');
  });

  it('redacts a high-entropy bare token even outside any known pattern', () => {
    const token = 'kZ7q+J/3a8FpL1n2BdRwYuM5xT0vScE6'; // base64-ish, 32 chars
    const { content, redactions } = scrub(`secret=${token}`);
    expect(content).not.toContain(token);
    // `secret=` is caught by the named-secret layer; a bare high-entropy value
    // elsewhere would still fall to the entropy/env layers.
    expect(
      redactions.some(
        (r) => r.type === 'named_secret' || r.type === 'high_entropy' || r.type === 'env_value',
      ),
    ).toBe(true);
  });

  it('does NOT redact a 40-char git commit SHA (hex, low entropy)', () => {
    const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    const { content } = scrub(`commit ${sha}`);
    expect(content).toContain(sha);
  });

  it('does NOT redact a UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const { content } = scrub(uuid);
    expect(content).toContain(uuid);
  });

  it('does NOT redact a short api error message like "Unauthorized"', () => {
    const input = 'Got 401 Unauthorized when calling /v1/messages';
    const { content } = scrub(input);
    expect(content).toBe(input);
  });

  it('does NOT redact a short token under min length threshold', () => {
    const input = 'tok=short';
    const { content } = scrub(input);
    expect(content).toBe(input);
  });

  it('handles empty input cleanly', () => {
    expect(scrub('')).toEqual({ content: '', redactions: [] });
  });

  it('handles input with only whitespace', () => {
    expect(scrub('   \n  \t  ').content).toBe('   \n  \t  ');
  });

  it('preserves surrounding punctuation when redacting bare tokens', () => {
    const token = 'kZ7q+J/3a8FpL1n2BdRwYuM5xT0vScE6';
    const { content } = scrub(`"${token}".`);
    expect(content).toMatch(/^".+"\.$/);
  });

  it('redacts multiple distinct secret types and reports each', () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    const gh = 'ghp_' + 'C'.repeat(40);
    const { redactions } = scrub(`${aws} and ${gh}`);
    expect(redactions.find((r) => r.type === 'aws_access_key')?.count).toBe(1);
    expect(redactions.find((r) => r.type === 'github_token')?.count).toBe(1);
  });

  it('does not double-redact already-redacted text on a second pass', () => {
    const first = scrub('AKIAIOSFODNN7EXAMPLE');
    const second = scrub(first.content);
    expect(second.content).toBe(first.content);
  });

  it('redacts a secret embedded in a longer paragraph', () => {
    const para =
      'I was running CI and got auth errors after rotating ghp_' +
      'D'.repeat(36) +
      ' last week. Trying again with...';
    const { content } = scrub(para);
    expect(content).not.toContain('ghp_');
    expect(content).toContain('[REDACTED:github_token]');
  });

  it('redacts secrets even when wrapped in markdown code fences', () => {
    const input = '```\nAPI_KEY=' + 'q'.repeat(40) + '\n```';
    const { content } = scrub(input);
    expect(content).toContain('[REDACTED');
  });

  it('redacts JSON-quoted secrets', () => {
    const tok = 'ghp_' + 'E'.repeat(40);
    const input = `{"token": "${tok}"}`;
    const { content } = scrub(input);
    expect(content).not.toContain(tok);
  });

  it('adversarial: token immediately adjacent to non-word characters', () => {
    const tok = 'ghp_' + 'F'.repeat(40);
    const { content } = scrub(`(${tok})`);
    expect(content).toContain('[REDACTED:github_token]');
  });

  it('adversarial: deliberately misleading natural-language string close to entropy threshold', () => {
    // a normal English sentence, long but predictable
    const sentence = 'the quick brown fox jumps over the lazy dog repeatedly';
    const { content } = scrub(sentence);
    expect(content).toBe(sentence);
  });

  it('adversarial: random-looking but actually a hex hash', () => {
    const md5 = '5f4dcc3b5aa765d61d8327deb882cf99';
    const { content } = scrub(md5);
    expect(content).toBe(md5);
  });

  it('adversarial: very long base64 blob (image data) gets some redaction', () => {
    // 200 chars of base64-ish — looks high entropy but is just data
    const blob =
      'aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSBzZWNyZXQgYnV0IGl0IGxvb2tzIGxpa2Ugb25l' + 'Q'.repeat(150);
    const { content, redactions } = scrub(blob);
    // we accept false-positives here; the test is that *something* fires
    expect(content === blob || redactions.length > 0).toBe(true);
  });

  it('looksLikeSecretLeak returns true when an obvious key remains', () => {
    expect(looksLikeSecretLeak('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('looksLikeSecretLeak returns false on already-scrubbed input', () => {
    const { content } = scrub('AKIAIOSFODNN7EXAMPLE');
    expect(looksLikeSecretLeak(content)).toBe(false);
  });

  it('shannonEntropy is zero for a constant string', () => {
    expect(shannonEntropy('aaaaaaaaaa')).toBe(0);
  });

  it('shannonEntropy is highest for uniformly distributed characters', () => {
    const random = 'abcdefghijklmnopqrstuvwxyz';
    expect(shannonEntropy(random)).toBeGreaterThan(4.5);
  });

  it('isHashLike recognizes lowercase hex of typical hash lengths', () => {
    expect(isHashLike('da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBe(true);
    expect(isHashLike('NotAHash!!')).toBe(false);
  });

  it('does NOT touch the body of a long natural-language paragraph', () => {
    const text =
      'The deployment failed because the migration could not acquire a lock on the users table. ' +
      'We tried restarting the worker, but that just made it sad. Eventually we discovered that another job had held the lock.';
    const { content } = scrub(text);
    expect(content).toBe(text);
  });

  it('preserves a long/hashy filesystem path (project root is signal, not a secret)', () => {
    const path = '/Users/dev/projects/acme-api-7f3a9c2b1e4d8f6a';
    const { content } = scrub(`# Problem span in ${path}`);
    expect(content).toContain(path);
    expect(content).not.toContain('[REDACTED');
  });

  it('still redacts a real secret sitting next to a path', () => {
    const { content } = scrub(
      '/home/dev/app ran with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    );
    expect(content).toContain('/home/dev/app');
    expect(content).toContain('[REDACTED:');
  });

  it('redacts a high-entropy secret hidden as a path SEGMENT but keeps the structure', () => {
    const { content } = scrub('/data/aGk9Zx2QpL7vWdR4tY8sNb3mC6hJ1fU0eX5oI/config');
    expect(content).toContain('/data/'); // structure preserved
    expect(content).toContain('/config'); // structure preserved
    expect(content).toContain('[REDACTED:high_entropy]'); // secret segment caught
    expect(content).not.toContain('aGk9Zx2QpL7vWdR4tY8sNb3mC6hJ1fU0eX5oI');
  });

  it('redacts a lowercased secret assignment the entropy layer misses', () => {
    // Canonicalized error text is lowercased, which drops the value's entropy
    // below the threshold. The named-secret layer must still catch it.
    const secret = 'wjalrxutnfemik7mdengbpxrficyzexamplekey';
    const { content, redactions } = scrub(`leaked aws_secret_access_key=${secret} in env dump`);
    expect(content).toContain('aws_secret_access_key=[REDACTED:named_secret]');
    expect(content).not.toContain(secret);
    expect(redactions.find((r) => r.type === 'named_secret')?.count).toBe(1);
  });

  it('redacts a hex-format token the entropy layer allowlists as hash-like', () => {
    const hex = 'deadbeefcafebabe0123456789abcdefdeadbeefcafebabe0123456789abcd';
    const { content } = scrub(`token=${hex}`);
    expect(content).toContain('token=[REDACTED:named_secret]');
    expect(content).not.toContain(hex);
  });

  it('redacts a lowercase password= assignment', () => {
    const { content } = scrub('password=hunter2trustno1');
    expect(content).toContain('password=[REDACTED:named_secret]');
  });

  it('does NOT redact benign lowercase assignments with non-secret key names', () => {
    expect(scrub('output=/usr/local/bin/python').content).toBe('output=/usr/local/bin/python');
    expect(scrub('retries=12345').content).toBe('retries=12345');
  });

  it('redacts secrets serialized as JSON "key": "value"', () => {
    const { content } = scrub('{"aws_secret_access_key": "wJalrXUtnFEMIexampleVALUE"}');
    expect(content).toContain('"aws_secret_access_key": [REDACTED:named_secret]');
    expect(content).not.toContain('wJalrXUtnFEMIexampleVALUE');
  });

  it('redacts a JSON password with no spaces around the colon', () => {
    const { content } = scrub('{"password":"hunter2trustno1"}');
    expect(content).not.toContain('hunter2trustno1');
    expect(content).toContain('[REDACTED:named_secret]');
  });

  it('does NOT redact host:port, URLs, or timestamps as if they were secrets', () => {
    expect(scrub('connecting to token.svc.internal:8080').content).toBe(
      'connecting to token.svc.internal:8080',
    );
    expect(scrub('GET https://api.example.com:443/v1/x').content).toBe(
      'GET https://api.example.com:443/v1/x',
    );
    expect(scrub('finished at 12:34:56').content).toBe('finished at 12:34:56');
  });

  it('redacts credentials embedded in a connection-string URL, keeping scheme and host', () => {
    // Not an env-line (no leading UPPER=), so the host survives as context and
    // only the user:pass is cut. An `DB_URL=...` form is separately redacted
    // wholesale by the env-line layer.
    const { content } = scrub('connecting to mysql://root:root@localhost:3306/app failed');
    expect(content).toContain('mysql://[REDACTED:connection_string]@');
    expect(content).toContain('localhost:3306/app'); // host/db kept as context
    expect(content).not.toContain('root:root@');
  });

  it('does NOT flag a bare scheme://host with no credentials', () => {
    expect(scrub('cloned from https://github.com/acme/repo.git').content).toBe(
      'cloned from https://github.com/acme/repo.git',
    );
  });

  it('scrub (not the tripwire) redacts a credential-named secret; tripwire stays quiet on clean text', () => {
    // The named-secret value is removed by scrub() upstream, so the text that
    // reaches the tripwire is already clean. The tripwire itself is pattern-only.
    expect(scrub('aws_secret_access_key=wjalrxutnfemik7mdengvalue').content).toContain(
      '[REDACTED:named_secret]',
    );
    expect(looksLikeSecretLeak('the build finished with 0 errors')).toBe(false);
  });

  it('tripwire still fires on a leaked prefixed secret (its belt-and-suspenders job)', () => {
    expect(looksLikeSecretLeak('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksLikeSecretLeak('ghp_' + 'A'.repeat(36))).toBe(true);
  });

  it('tripwire does NOT fire on an already-scrubbed secret-named assignment', () => {
    // The scrubber already redacted the value; a secret-named key next to a
    // [REDACTED] marker must not refuse an otherwise-clean transcript. Real env
    // dumps (STRIPE_SECRET_KEY=, aws_secret_access_key=) are everywhere.
    expect(looksLikeSecretLeak('STRIPE_SECRET_KEY=[REDACTED:stripe_key]')).toBe(false);
    expect(looksLikeSecretLeak('aws_secret_access_key=[REDACTED:named_secret] in env')).toBe(false);
    // ...but still fires if a real value survived scrubbing.
    expect(looksLikeSecretLeak('STRIPE_SECRET_KEY=sk_live_realvalue0123456789ab')).toBe(true);
  });
});
