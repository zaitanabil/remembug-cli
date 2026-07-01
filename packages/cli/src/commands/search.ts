import type { Command } from 'commander';
import { remembugPaths, LocalEmbedder, searchTool, Store } from '@devzen/remembug-daemon';
import type { RankedResult } from '@devzen/remembug-daemon';

/**
 * `remembug search <query>` — local-only search over published entries.
 * Useful when MCP isn't wired up yet or for grep-style usage.
 */
export function registerSearch(program: Command): void {
  program
    .command('search')
    .description('Search the Remembug knowledge base.')
    .argument('<query...>', 'Words to search for.')
    .option('-l, --limit <n>', 'Max results to return.', '10')
    .option('-p, --project-path <path>', 'Bias results by project stack.')
    .action(async (words: string[], opts: { limit: string; projectPath?: string }) => {
      const paths = remembugPaths();
      const store = new Store({ path: paths.db });
      const embedder = new LocalEmbedder();
      const results = await searchTool(
        {
          query: words.join(' '),
          limit: Number(opts.limit),
          project_path: opts.projectPath,
        },
        { store, embedder },
      );
      if (results.length === 0) {
        console.log('[remembug] no matches.');
        return;
      }
      for (const r of results) printResult(r);
      store.close();
    });
}

function printResult(r: RankedResult): void {
  console.log(`\n[${r.score.toFixed(3)}] ${r.entry.title}   (id: ${r.entry.id})`);
  if (r.entry.tags.length > 0) {
    console.log(`  tags: ${r.entry.tags.join(', ')}`);
  }

  console.log(`  ${firstLine(r.entry.problem_body)}`);
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  return idx === -1 ? s : s.slice(0, idx);
}
