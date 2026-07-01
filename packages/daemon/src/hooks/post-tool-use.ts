import type { PostToolUsePayload } from '@devzen/remembug-shared';
import { PostToolUsePayloadSchema } from '@devzen/remembug-shared';
import type { SpanDetector } from '../capture/span-detector.js';

export interface PostToolUseHandlerDeps {
  detector: SpanDetector;
}

export function handlePostToolUse(
  rawBody: unknown,
  deps: PostToolUseHandlerDeps,
): { ok: true; received: PostToolUsePayload } | { ok: false; error: string } {
  const parsed = PostToolUsePayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  deps.detector.observeToolUse(parsed.data);
  return { ok: true, received: parsed.data };
}
