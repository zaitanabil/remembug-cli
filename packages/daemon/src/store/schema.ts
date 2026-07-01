/**
 * Single-string SQL bundle for the v0.1 schema.
 *
 * Migrations are intentionally simple — applied via the `user_version`
 * pragma rather than a heavyweight migration tool — because the store
 * is local-only and the v0.1 schema is the foundational one.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** Vector dimension used for `entry_vectors`. Configurable later if we change embedding models. */
export const VECTOR_DIMENSION = 1536;

export const MIGRATIONS: string[] = [
  // v1: initial schema
  `
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    problem_body TEXT NOT NULL,
    solution_body TEXT NOT NULL,
    tags TEXT NOT NULL,
    stack TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    confirmation_count INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entries_fingerprint ON entries(fingerprint);
  CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);

  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title,
    problem_body,
    solution_body,
    tags,
    content='entries',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS entries_fts_insert AFTER INSERT ON entries
  BEGIN
    INSERT INTO entries_fts(rowid, title, problem_body, solution_body, tags)
    VALUES (new.rowid, new.title, new.problem_body, new.solution_body, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_fts_delete AFTER DELETE ON entries
  BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, problem_body, solution_body, tags)
    VALUES('delete', old.rowid, old.title, old.problem_body, old.solution_body, old.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_fts_update AFTER UPDATE ON entries
  BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, problem_body, solution_body, tags)
    VALUES('delete', old.rowid, old.title, old.problem_body, old.solution_body, old.tags);
    INSERT INTO entries_fts(rowid, title, problem_body, solution_body, tags)
    VALUES (new.rowid, new.title, new.problem_body, new.solution_body, new.tags);
  END;

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL UNIQUE,
    stack_fingerprint TEXT NOT NULL,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entry_projects (
    entry_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    PRIMARY KEY (entry_id, project_id),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    helpful INTEGER NOT NULL,
    notes TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS raw_transcripts (
    id TEXT PRIMARY KEY,
    entry_id TEXT,
    scrubbed_content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE SET NULL
  );
  `,
];

/** SQL to create the vector virtual table — emitted separately because it depends on sqlite-vec being loaded. */
export const VECTOR_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS entry_vectors USING vec0(
    entry_id TEXT PRIMARY KEY,
    embedding float[${VECTOR_DIMENSION}]
  );
`;
