/**
 * Cheap stack-token detection for the cwd of a problem span.
 *
 * The aim is *not* a full SBOM. We just want a few tokens like
 * `node@20`, `vite@5`, `python@3.12` so:
 *   - drafts get a useful "stack hints" line in the user prompt
 *   - the search ranker has something to bias by
 *
 * Anything we can't determine cheaply is dropped. Missing tokens are
 * far better than wrong tokens — the ranker's stack bonus would
 * silently surface irrelevant entries if we guessed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DetectedStack {
  tokens: string[];
  projectName: string;
}

export function detectStack(cwd: string): DetectedStack {
  const tokens = new Set<string>();
  let projectName = baseName(cwd);

  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string;
        engines?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (typeof pkg.name === 'string' && pkg.name.length > 0) {
        projectName = pkg.name;
      }
      const node = pkg.engines?.node;
      if (typeof node === 'string') {
        const major = node.match(/\d+/)?.[0];
        if (major) tokens.add(`node@${major}`);
      }
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [name, range] of Object.entries(deps)) {
        const major = String(range).match(/\d+/)?.[0];
        if (!major) continue;
        if (!INTERESTING_NODE_DEPS.has(name)) continue;
        tokens.add(`${name}@${major}`);
      }
    } catch {
      // unreadable / malformed package.json — ignore
    }
  }

  if (existsSync(join(cwd, 'pyproject.toml'))) tokens.add('python');
  if (existsSync(join(cwd, 'requirements.txt'))) tokens.add('python');
  if (existsSync(join(cwd, 'go.mod'))) {
    const goVer = readGoVersion(join(cwd, 'go.mod'));
    tokens.add(goVer ? `go@${goVer}` : 'go');
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) tokens.add('rust');
  if (existsSync(join(cwd, 'Gemfile'))) tokens.add('ruby');

  return { tokens: [...tokens], projectName };
}

const INTERESTING_NODE_DEPS = new Set([
  'react',
  'next',
  'vite',
  'vitest',
  'jest',
  'typescript',
  'eslint',
  'prettier',
  'express',
  'fastify',
  'hono',
  'nestjs',
  '@nestjs/core',
  'astro',
  'svelte',
  'sveltekit',
  '@sveltejs/kit',
  'tailwindcss',
  'drizzle-orm',
  'prisma',
  '@prisma/client',
  'turbo',
  'nx',
  'pnpm',
]);

function readGoVersion(modPath: string): string | undefined {
  try {
    const first = readFileSync(modPath, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('go '));
    return first?.split(' ')[1]?.trim();
  } catch {
    return undefined;
  }
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}
