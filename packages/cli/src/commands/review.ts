import type { Command } from 'commander';
import { createElement } from 'react';
import { render } from 'ink';
import { remembugPaths, Store } from '@devzen/remembug-daemon';
import { ReviewApp } from '../ui/review-app.js';

/**
 * `remembug review` — Ink TUI to walk through pending drafts.
 */
export function registerReview(program: Command): void {
  program
    .command('review')
    .description('Approve, edit, or reject pending drafts.')
    .action(async () => {
      const paths = remembugPaths();
      const store = new Store({ path: paths.db });
      const { waitUntilExit } = render(createElement(ReviewApp, { store }));
      await waitUntilExit();
      store.close();
    });
}
