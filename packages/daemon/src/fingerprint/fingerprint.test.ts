import { describe, expect, it } from 'vitest';
import { canonicalizeError, fingerprint, stackFingerprint } from './index.js';

describe('fingerprint', () => {
  it('produces the same fingerprint for identical inputs', () => {
    const a = fingerprint({ toolName: 'Bash', errorText: 'ENOENT: file not found' });
    const b = fingerprint({ toolName: 'Bash', errorText: 'ENOENT: file not found' });
    expect(a).toBe(b);
  });

  it('produces different fingerprints for different tools', () => {
    const a = fingerprint({ toolName: 'Bash', errorText: 'x' });
    const b = fingerprint({ toolName: 'Edit', errorText: 'x' });
    expect(a).not.toBe(b);
  });

  it('ignores timestamps when fingerprinting', () => {
    const a = fingerprint({
      toolName: 'Bash',
      errorText: '2024-01-01T00:00:00Z failed to connect',
    });
    const b = fingerprint({
      toolName: 'Bash',
      errorText: '2025-06-15T13:22:01.123Z failed to connect',
    });
    expect(a).toBe(b);
  });

  it('ignores line numbers in stack traces', () => {
    const a = fingerprint({
      toolName: 'Bash',
      errorText: 'TypeError at foo.js:42:10)',
    });
    const b = fingerprint({
      toolName: 'Bash',
      errorText: 'TypeError at foo.js:99:3)',
    });
    expect(a).toBe(b);
  });

  it('ignores absolute file paths', () => {
    const a = fingerprint({
      toolName: 'Bash',
      errorText: 'cannot find /home/alice/project/src/foo',
    });
    const b = fingerprint({
      toolName: 'Bash',
      errorText: 'cannot find /Users/bob/work/remembug/src/foo',
    });
    expect(a).toBe(b);
  });

  it('ignores process and port numbers', () => {
    const a = fingerprint({ toolName: 'Bash', errorText: 'pid 12345 on port 3000' });
    const b = fingerprint({ toolName: 'Bash', errorText: 'pid 9 on port 80' });
    expect(a).toBe(b);
  });

  it('treats different errors as different fingerprints', () => {
    const a = fingerprint({ toolName: 'Bash', errorText: 'ENOENT: file not found' });
    const b = fingerprint({ toolName: 'Bash', errorText: 'EACCES: permission denied' });
    expect(a).not.toBe(b);
  });

  it('canonicalizeError lowercases output', () => {
    expect(canonicalizeError('ERROR HERE')).toBe('error here');
  });

  it('canonicalizeError collapses hex addresses', () => {
    const c = canonicalizeError('crashed at 0xdeadbeef');
    expect(c).toContain('<hex>');
    expect(c).not.toContain('deadbeef');
  });

  it('canonicalizeError preserves the error class name', () => {
    const c = canonicalizeError('TypeError: cannot read undefined');
    expect(c).toContain('typeerror');
  });

  it('fingerprint is 16 hex chars', () => {
    const fp = fingerprint({ toolName: 'Bash', errorText: 'x' });
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it('stackFingerprint is order-independent', () => {
    const a = stackFingerprint(['node@20', 'vite@5']);
    const b = stackFingerprint(['vite@5', 'node@20']);
    expect(a).toBe(b);
  });

  it('stackFingerprint is case-insensitive and trims', () => {
    const a = stackFingerprint(['Node@20', '  vite@5 ']);
    const b = stackFingerprint(['node@20', 'vite@5']);
    expect(a).toBe(b);
  });

  it('stackFingerprint deduplicates input', () => {
    const a = stackFingerprint(['node@20', 'node@20', 'vite@5']);
    const b = stackFingerprint(['node@20', 'vite@5']);
    expect(a).toBe(b);
  });

  it('different stacks produce different fingerprints', () => {
    const a = stackFingerprint(['node@20']);
    const b = stackFingerprint(['python@3.12']);
    expect(a).not.toBe(b);
  });

  it('exit code change produces a different fingerprint', () => {
    const a = fingerprint({ toolName: 'Bash', errorText: 'x', exitCode: 1 });
    const b = fingerprint({ toolName: 'Bash', errorText: 'x', exitCode: 127 });
    expect(a).not.toBe(b);
  });
});
