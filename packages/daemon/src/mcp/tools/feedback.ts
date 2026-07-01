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
  return deps.store.recordFeedback(input);
}
