import { StopPayloadSchema, type StopPayload } from '@devzen/remembug-shared';
import type { SpanDetector } from '../capture/span-detector.js';

export interface StopHandlerDeps {
  detector: SpanDetector;
}

export function handleStop(
  rawBody: unknown,
  deps: StopHandlerDeps,
): { ok: true; received: StopPayload } | { ok: false; error: string } {
  const parsed = StopPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  deps.detector.observeStop(parsed.data);
  return { ok: true, received: parsed.data };
}
