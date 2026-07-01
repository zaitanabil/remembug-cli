import { z } from 'zod';
import type { Entry } from '@devzen/remembug-shared';
import type { Store } from '../../store/index.js';

export const GetInputSchema = z.object({
  entry_id: z.string().min(1),
});
export type GetInput = z.infer<typeof GetInputSchema>;

export function getTool(input: GetInput, deps: { store: Store }): Entry | undefined {
  // Only published entries are servable. pending_review drafts (which may be
  // AI-drafted and unreviewed, including a prompt-injected one) must not be
  // readable by id, matching the search/FTS gate.
  const entry = deps.store.getEntry(input.entry_id);
  return entry && entry.status === 'published' ? entry : undefined;
}
