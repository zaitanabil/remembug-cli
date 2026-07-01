/**
 * SQLite-backed knowledge base store.
 *
 * Loads the `sqlite-vec` extension when available (vector search is then
 * enabled); falls back to BM25-only search if the extension can't load —
 * this is critical for keeping the project hackable on platforms where
 * the prebuild is missing.
 *
 * NOTE: this file uses better-sqlite3's `db.exec(...)` method for raw SQL.
 * That is unrelated to `child_process.exec`; no shell is invoked.
 */
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as SqliteDB } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type {
  Entry,
  EntryOrigin,
  EntryStatus,
  Feedback,
  Project,
  RawTranscript,
} from '@devzen/remembug-shared';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, VECTOR_TABLE_SQL } from './schema.js';

export interface StoreOptions {
  /** Absolute path to the SQLite db file. Parent dirs are created if missing. */
  path: string;
  /** Try to load sqlite-vec. Defaults to true. */
  enableVector?: boolean;
}

export interface NewEntryInput {
  title: string;
  problem_body: string;
  solution_body: string;
  tags: string[];
  stack: string[];
  fingerprint: string;
  origin: EntryOrigin;
  status: EntryStatus;
  project_ids?: string[];
  /** Precomputed embedding, written atomically with the entry (see insertEntry). */
  embedding?: Float32Array;
}

interface EntryRow {
  id: string;
  title: string;
  problem_body: string;
  solution_body: string;
  tags: string;
  stack: string;
  fingerprint: string;
  origin: EntryOrigin;
  status: EntryStatus;
  confirmation_count: number;
  created_at: number;
  updated_at: number;
}

interface FeedbackRow {
  id: string;
  entry_id: string;
  helpful: number;
  notes: string | null;
  created_at: number;
}

interface RawTranscriptRow {
  id: string;
  entry_id: string | null;
  scrubbed_content: string;
  created_at: number;
}

interface FTSMatchRow {
  entry_id: string;
  bm25_score: number;
}

interface VectorMatchRow {
  entry_id: string;
  distance: number;
}

/** Absolute ceiling on any LIMIT the store will run, regardless of caller. */
const MAX_QUERY_LIMIT = 100;
function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_QUERY_LIMIT);
}

/** Parse a JSON string column into an array, tolerating a corrupt/hand-edited row. */
function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function rowToEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    title: row.title,
    problem_body: row.problem_body,
    solution_body: row.solution_body,
    tags: safeJsonArray(row.tags),
    stack: safeJsonArray(row.stack),
    fingerprint: row.fingerprint,
    origin: row.origin,
    status: row.status,
    confirmation_count: row.confirmation_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class Store {
  private readonly db: SqliteDB;
  public readonly hasVectorSupport: boolean;

  constructor(options: StoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    let vectorOk = false;
    if (options.enableVector !== false) {
      try {
        sqliteVec.load(this.db);
        vectorOk = true;
      } catch (e) {
        vectorOk = false;
        process.stderr.write(
          `[remembug] sqlite-vec unavailable; search falls back to keyword-only: ${(e as Error).message}\n`,
        );
      }
    }
    this.hasVectorSupport = vectorOk;

    this.migrate();
    if (this.hasVectorSupport) {
      try {
        this.runRawSql(VECTOR_TABLE_SQL);
      } catch (e) {
        (this as { hasVectorSupport: boolean }).hasVectorSupport = false;
        process.stderr.write(
          `[remembug] entry_vectors table unavailable (dimension change?); vector search disabled: ${(e as Error).message}\n`,
        );
      }
    }
  }

  private runRawSql(sql: string): void {
    this.db.exec(sql);
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.runRawSql(MIGRATIONS[i]!);
      this.db.pragma(`user_version = ${i + 1}`);
    }
    if (current > MIGRATIONS.length) {
      throw new Error(
        `Database schema is newer than this Remembug build (db=${current}, code=${CURRENT_SCHEMA_VERSION}).`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  insertEntry(input: NewEntryInput): Entry {
    const id = randomUUID();
    const now = Date.now();
    const entry: Entry = {
      id,
      title: input.title,
      problem_body: input.problem_body,
      solution_body: input.solution_body,
      tags: input.tags,
      stack: input.stack,
      fingerprint: input.fingerprint,
      origin: input.origin,
      status: input.status,
      confirmation_count: 1,
      created_at: now,
      updated_at: now,
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entries (id, title, problem_body, solution_body, tags, stack, fingerprint, origin, status, confirmation_count, created_at, updated_at)
           VALUES (@id, @title, @problem_body, @solution_body, @tags, @stack, @fingerprint, @origin, @status, @confirmation_count, @created_at, @updated_at)`,
        )
        .run({
          ...entry,
          tags: JSON.stringify(entry.tags),
          stack: JSON.stringify(entry.stack),
        });
      if (input.project_ids?.length) {
        const link = this.db.prepare(
          'INSERT OR IGNORE INTO entry_projects (entry_id, project_id) VALUES (?, ?)',
        );
        for (const pid of input.project_ids) link.run(id, pid);
      }
      // Write the vector in the SAME transaction as the entry: a crash between
      // the two would otherwise leave an entry that is keyword-searchable but
      // never vector-rerankable, with no reconciliation path.
      if (input.embedding && this.hasVectorSupport) {
        this.db
          .prepare('INSERT OR REPLACE INTO entry_vectors (entry_id, embedding) VALUES (?, ?)')
          .run(id, Buffer.from(input.embedding.buffer));
      }
    });
    tx();
    return entry;
  }

  updateEntry(id: string, patch: Partial<NewEntryInput> & { status?: EntryStatus }): Entry {
    const existing = this.getEntry(id);
    if (!existing) throw new Error(`No entry with id ${id}`);
    const merged: Entry = {
      ...existing,
      ...patch,
      tags: patch.tags ?? existing.tags,
      stack: patch.stack ?? existing.stack,
      updated_at: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE entries SET title=@title, problem_body=@problem_body, solution_body=@solution_body,
           tags=@tags, stack=@stack, fingerprint=@fingerprint, origin=@origin, status=@status,
           confirmation_count=@confirmation_count, updated_at=@updated_at
         WHERE id=@id`,
      )
      .run({
        ...merged,
        tags: JSON.stringify(merged.tags),
        stack: JSON.stringify(merged.stack),
      });
    return merged;
  }

  incrementConfirmation(id: string): void {
    this.db
      .prepare(
        'UPDATE entries SET confirmation_count = confirmation_count + 1, updated_at = ? WHERE id = ?',
      )
      .run(Date.now(), id);
  }

  getEntry(id: string): Entry | undefined {
    const row = this.db.prepare<[string], EntryRow>('SELECT * FROM entries WHERE id = ?').get(id);
    return row ? rowToEntry(row) : undefined;
  }

  findByFingerprint(fp: string): Entry[] {
    const rows = this.db
      .prepare<[string], EntryRow>('SELECT * FROM entries WHERE fingerprint = ?')
      .all(fp);
    return rows.map(rowToEntry);
  }

  listPending(): Entry[] {
    const rows = this.db
      .prepare<
        [],
        EntryRow
      >("SELECT * FROM entries WHERE status = 'pending_review' ORDER BY created_at ASC")
      .all();
    return rows.map(rowToEntry);
  }

  listPublished(limit = 50): Entry[] {
    const rows = this.db
      .prepare<
        [number],
        EntryRow
      >("SELECT * FROM entries WHERE status = 'published' ORDER BY updated_at DESC LIMIT ?")
      .all(clampLimit(limit));
    return rows.map(rowToEntry);
  }

  upsertProject(input: Omit<Project, 'id'> & { id?: string }): Project {
    const existing = this.db
      .prepare<[string], Project>('SELECT * FROM projects WHERE repo_path = ?')
      .get(input.repo_path);
    if (existing) {
      this.db
        .prepare('UPDATE projects SET stack_fingerprint = ?, name = ? WHERE id = ?')
        .run(input.stack_fingerprint, input.name, existing.id);
      return { ...existing, stack_fingerprint: input.stack_fingerprint, name: input.name };
    }
    const id = input.id ?? randomUUID();
    this.db
      .prepare('INSERT INTO projects (id, repo_path, stack_fingerprint, name) VALUES (?, ?, ?, ?)')
      .run(id, input.repo_path, input.stack_fingerprint, input.name);
    return { id, ...input };
  }

  getProjectByPath(repoPath: string): Project | undefined {
    return this.db
      .prepare<[string], Project>('SELECT * FROM projects WHERE repo_path = ?')
      .get(repoPath);
  }

  recordFeedback(input: Omit<Feedback, 'id' | 'created_at'>): Feedback {
    const fb: Feedback = {
      id: randomUUID(),
      created_at: Date.now(),
      ...input,
    };
    // One transaction so the feedback row and the confirmation bump can't
    // half-apply if the process dies between them.
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO feedback (id, entry_id, helpful, notes, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(fb.id, fb.entry_id, fb.helpful ? 1 : 0, fb.notes ?? null, fb.created_at);
      if (fb.helpful) this.incrementConfirmation(fb.entry_id);
    })();
    return fb;
  }

  listFeedbackFor(entry_id: string): Feedback[] {
    const rows = this.db
      .prepare<
        [string],
        FeedbackRow
      >('SELECT * FROM feedback WHERE entry_id = ? ORDER BY created_at DESC')
      .all(entry_id);
    return rows.map((r) => ({
      id: r.id,
      entry_id: r.entry_id,
      helpful: r.helpful === 1,
      notes: r.notes ?? undefined,
      created_at: r.created_at,
    }));
  }

  saveRawTranscript(scrubbed_content: string, entry_id?: string): RawTranscript {
    const rt: RawTranscript = {
      id: randomUUID(),
      entry_id,
      scrubbed_content,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO raw_transcripts (id, entry_id, scrubbed_content, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(rt.id, rt.entry_id ?? null, rt.scrubbed_content, rt.created_at);
    return rt;
  }

  getRawTranscript(id: string): RawTranscript | undefined {
    const row = this.db
      .prepare<[string], RawTranscriptRow>('SELECT * FROM raw_transcripts WHERE id = ?')
      .get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      entry_id: row.entry_id ?? undefined,
      scrubbed_content: row.scrubbed_content,
      created_at: row.created_at,
    };
  }

  /**
   * Raw FTS5 keyword search. Lower BM25 score = better match (SQLite quirk),
   * so we invert it for the ranker.
   */
  ftsSearch(query: string, limit: number): FTSMatchRow[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare<[string, string, number], FTSMatchRow>(
        `SELECT e.id AS entry_id, bm25(entries_fts) AS bm25_score
         FROM entries_fts
         JOIN entries e ON e.rowid = entries_fts.rowid
         WHERE entries_fts MATCH ? AND e.status = ?
         ORDER BY bm25_score
         LIMIT ?`,
      )
      .all(ftsQuery, 'published', clampLimit(limit));
    return rows;
  }

  /**
   * Nearest neighbours by vector distance. `maxDistance` drops results
   * beyond a relevance horizon — without it, this returns the closest N
   * entries for ANY query (even unrelated ones), which is the difference
   * between "no match" and "confidently wrong". L2 on the unit-normalised
   * embeddings means orthogonal (unrelated) ≈ 1.41; related is well below.
   */
  vectorSearch(embedding: Float32Array, limit: number, maxDistance = Infinity): VectorMatchRow[] {
    if (!this.hasVectorSupport) return [];
    const buf = Buffer.from(embedding.buffer);
    const rows = this.db
      .prepare<
        [Buffer, number],
        VectorMatchRow
      >(`SELECT entry_id, distance FROM entry_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
      .all(buf, clampLimit(limit));
    return rows.filter((r) => r.distance <= maxDistance);
  }

  upsertVector(entry_id: string, embedding: Float32Array): void {
    if (!this.hasVectorSupport) return;
    const buf = Buffer.from(embedding.buffer);
    this.db
      .prepare('INSERT OR REPLACE INTO entry_vectors (entry_id, embedding) VALUES (?, ?)')
      .run(entry_id, buf);
  }

  projectStackFingerprintFor(repo_path: string): string | undefined {
    return this.getProjectByPath(repo_path)?.stack_fingerprint;
  }

  /**
   * Returns the union of stack tokens across every entry linked to the
   * given project path. Used by the search ranker to apply a stack
   * overlap bias.
   */
  projectStackTokensFor(repo_path: string): string[] {
    const project = this.getProjectByPath(repo_path);
    if (!project) return [];
    const rows = this.db
      .prepare<[string], { stack: string }>(
        `SELECT e.stack AS stack
         FROM entries e
         JOIN entry_projects ep ON ep.entry_id = e.id
         WHERE ep.project_id = ?`,
      )
      .all(project.id);
    const tokens = new Set<string>();
    for (const r of rows) {
      try {
        for (const t of JSON.parse(r.stack) as string[]) tokens.add(t);
      } catch {
        // Ignore malformed JSON rows; should never happen.
      }
    }
    return [...tokens];
  }
}

/**
 * Quote an FTS5 query safely. We strip operators that SQLite's FTS5
 * interprets specially (`"`, `*`, `:`, etc.), drop stopwords and 1-char
 * tokens, and re-wrap each remaining token in quotes — plain "phrase OR
 * phrase" semantics without ever letting a query become an FTS5 syntax
 * error. Returns `''` when nothing meaningful survives, so the caller
 * skips the query (no match) instead of matching on filler words.
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/["*:()]+/g, ''))
    .filter((t) => t.length > 1 && !FTS_STOPWORDS.has(t));
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * English stopwords + filler that otherwise create false-positive FTS
 * matches: a query like "how do I center a div" must not match an entry
 * merely because both contain "a"/"with"/"do". The relevance lives in
 * the content words. ponytail: hardcoded list, swap for a stemmed
 * stopword lib only if recall on rare words ever suffers.
 */
const FTS_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'doing',
  'have',
  'has',
  'had',
  'i',
  'you',
  'it',
  'we',
  'they',
  'this',
  'that',
  'these',
  'those',
  'my',
  'your',
  'our',
  'how',
  'what',
  'when',
  'where',
  'why',
  'who',
  'which',
  'can',
  'could',
  'should',
  'would',
  'will',
  'me',
  'am',
  'so',
  'then',
  'than',
  'as',
  'about',
  'into',
  'out',
  'up',
  'down',
  'same',
  'time',
]);

/** Cheap deterministic id for tests. Not used as a primary key. */
export function shortId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}
