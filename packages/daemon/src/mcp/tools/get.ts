import { z } from 'zod';
import type { Entry } from '@devzen/remembug-shared';
import type { Store } from '../../store/index.js';

export const GetInputSchema = z.object({
  entry_id: z.string().min(1),
});
export type GetInput = z.infer<typeof GetInputSchema>;

export function getTool(input: GetInput, deps: { store: Store }): Entry | undefined {
  return deps.store.getEntry(input.entry_id);
}
