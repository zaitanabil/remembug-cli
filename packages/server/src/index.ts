/**
 * Remembug team-sync server — v0.2 scaffold only.
 *
 * The package is shipped so workspace consumers (CI, docs) compile
 * against the v0.2 types ahead of the real implementation. Importing
 * this module is intentionally a no-op.
 *
 * Tracking design notes: docs/self-hosting-team.md.
 */
import type { Entry } from '@devzen/remembug-shared';

export interface SyncEnvelope {
  /** Logical schema version of the envelope. */
  version: 1;
  /** Caller's last-seen server cursor. */
  since?: string;
  /** Entries the client has authored or edited since `since`. */
  entries: Entry[];
}

export interface SyncResponse {
  /** Opaque cursor the client should send back on the next sync. */
  cursor: string;
  /** Server-side entries the client did not already have. */
  entries: Entry[];
}

/** Tracking stub — calling this in v0.1 always throws. */
export function notImplemented(): never {
  throw new Error('Remembug team sync server is not yet implemented (planned for v0.2).');
}
