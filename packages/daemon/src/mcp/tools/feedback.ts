import { z } from 'zod';
import type { Feedback } from '@devzen/remembug-shared';
import type { Store } from '../../store/index.js';

export const FeedbackInputSchema = z.object({
  entry_id: z.string().min(1),
  helpful: z.boolean(),
  notes: z.string().optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;

export function feedbackTool(input: FeedbackInput, deps: { store: Store }): Feedback {
  // Reject feedback on a missing or unpublished entry: otherwise a bad/guessed
  // id silently succeeds, and helpful=true would inflate confirmation_count on
  // an entry that was never reviewed.
  const entry = deps.store.getEntry(input.entry_id);
  if (!entry || entry.status !== 'published') {
    throw new Error('entry not found');
  }
  return deps.store.recordFeedback(input);
}
