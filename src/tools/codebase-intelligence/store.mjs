import { DatabaseSync } from "node:sqlite";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { ProjectRegistryError } from "./registry.mjs";

export const INDEX_SCHEMA_VERSION = 4;
const CREATE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS files (file_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, relative_path TEXT NOT NULL, language TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, indexed_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS files_by_repo_path ON files(repo_id,relative_path)",
  "CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(file_id) ON DELETE CASCADE, repo_id TEXT NOT NULL, relative_path TEXT NOT NULL, path_search TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, body TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS chunks_by_file ON chunks(file_id)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(path_search, body, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2')",
  "CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunk_fts(rowid,path_search,body) VALUES(new.id,new.path_search,new.body); END",
  "CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunk_fts(chunk_fts,rowid,path_search,body) VALUES('delete',old.id,old.path_search,old.body); END",
  "CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN INSERT INTO chunk_fts(chunk_fts,rowid,path_search,body) VALUES('delete',old.id,old.path_search,old.body); INSERT INTO chunk_fts(rowid,path_search,body) VALUES(new.id,new.path_search,new.body); END",
  "CREATE TABLE IF NOT EXISTS revisions (revision INTEGER PRIMARY KEY AUTOINCREMENT, indexed_at TEXT NOT NULL, mode TEXT NOT NULL, changed INTEGER NOT NULL, removed INTEGER NOT NULL, unchanged INTEGER NOT NULL, file_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL, source_bytes INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS repo_snapshots (repo_id TEXT PRIMARY KEY, branch TEXT, head_sha TEXT, recorded_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS php_facts (id INTEGER PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(file_id) ON DELETE CASCADE, repo_id TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, parent TEXT, target TEXT, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS php_facts_by_kind_name ON php_facts(kind,name)",
  "CREATE INDEX IF NOT EXISTS php_facts_by_parent ON php_facts(repo_id,parent)",
  "CREATE INDEX IF NOT EXISTS php_facts_by_file ON php_facts(file_id)",
  "CREATE TABLE IF NOT EXISTS php_edges (id INTEGER PRIMARY KEY, from_fact INTEGER NOT NULL REFERENCES php_facts(id) ON DELETE CASCADE, to_fact INTEGER REFERENCES php_facts(id) ON DELETE CASCADE, relation TEXT NOT NULL, status TEXT NOT NULL, target_label TEXT)",
  "CREATE INDEX IF NOT EXISTS php_edges_by_from ON php_edges(from_fact)",
  "CREATE TABLE IF NOT EXISTS php_parse_errors (file_id TEXT PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE, code TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS php_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS csharp_facts (id INTEGER PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(file_id) ON DELETE CASCADE, repo_id TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, parent TEXT, target TEXT, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS csharp_facts_by_kind ON csharp_facts(kind,name)",
  "CREATE INDEX IF NOT EXISTS csharp_facts_by_parent ON csharp_facts(repo_id,parent)",
  "CREATE INDEX IF NOT EXISTS csharp_facts_by_file ON csharp_facts(file_id)",
  "CREATE TABLE IF NOT EXISTS csharp_edges (id INTEGER PRIMARY KEY, from_fact INTEGER NOT NULL REFERENCES csharp_facts(id) ON DELETE CASCADE, to_fact INTEGER REFERENCES csharp_facts(id) ON DELETE CASCADE, relation TEXT NOT NULL, status TEXT NOT NULL, target_label TEXT)",
  "CREATE INDEX IF NOT EXISTS csharp_edges_by_from ON csharp_edges(from_fact)",
  "CREATE TABLE IF NOT EXISTS csharp_parse_errors (file_id TEXT PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE, code TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS csharp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ts_facts (id INTEGER PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(file_id) ON DELETE CASCADE, repo_id TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, parent TEXT, target TEXT, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, status TEXT NOT NULL, details TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ts_facts_by_kind ON ts_facts(kind,name)",
  "CREATE INDEX IF NOT EXISTS ts_facts_by_file ON ts_facts(file_id)",
  "CREATE INDEX IF NOT EXISTS ts_facts_by_parent ON ts_facts(repo_id,parent)",
  "CREATE TABLE IF NOT EXISTS ts_edges (id INTEGER PRIMARY KEY, from_fact INTEGER NOT NULL REFERENCES ts_facts(id) ON DELETE CASCADE, to_fact INTEGER REFERENCES ts_facts(id) ON DELETE CASCADE, relation TEXT NOT NULL, status TEXT NOT NULL, target_label TEXT)",
  "CREATE INDEX IF NOT EXISTS ts_edges_by_from ON ts_edges(from_fact)",
  "CREATE TABLE IF NOT EXISTS ts_parse_errors (file_id TEXT PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE, code TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

function fail(code, message) {
  throw new ProjectRegistryError(code, message);
}

export function dbPath(indexRoot, projectId) {
  return path.join(indexRoot, projectId + ".sqlite");
}

function openDatabase(filename, { readonly = false } = {}) {
  let db;
  try {
    db = new DatabaseSync(filename, {
      readOnly: readonly,
      timeout: 5000,
    });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (!readonly) db.exec("PRAGMA journal_mode = WAL");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > INDEX_SCHEMA_VERSION) {
      db.close();
      fail("INDEX_SCHEMA_UNSUPPORTED", "The index was created by a newer version of Codebase Intelligence.");
    }
    if (readonly && (version < 1 || version > INDEX_SCHEMA_VERSION)) {
      db.close();
      fail("INDEX_SCHEMA_UNSUPPORTED", "The index schema is not initialized.");
    }
    if (!readonly) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of CREATE_SCHEMA) db.exec(statement);
        db.exec("PRAGMA user_version = " + INDEX_SCHEMA_VERSION);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return db;
  } catch (error) {
    try { db?.close(); } catch {}
    if (error instanceof ProjectRegistryError) throw error;
    fail("INDEX_STORAGE_ERROR", "SQLite index is unavailable or corrupt: " + (error.code || "open_failed"));
  }
}

export async function openWritableIndex(indexRoot, projectId) {
  await mkdir(indexRoot, { recursive: true });
  return openDatabase(dbPath(indexRoot, projectId));
}

export async function openExistingIndex(indexRoot, projectId) {
  const filename = dbPath(indexRoot, projectId);
  try {
    const info = await stat(filename);
    if (!info.isFile()) return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return openDatabase(filename, { readonly: true });
}

export function currentRevision(db) {
  return db.prepare("SELECT revision,indexed_at,mode,changed,removed,unchanged,file_count,chunk_count,source_bytes FROM revisions ORDER BY revision DESC LIMIT 1").get() || null;
}

export function readExistingHashes(db) {
  return new Map(db.prepare("SELECT file_id,sha256 FROM files").all().map((f) => [f.file_id, f.sha256]));
}

export function removeFile(db, fileId) {
  // PHP facts and their graph edges cascade with the source file.
  db.prepare("DELETE FROM chunks WHERE file_id=?").run(fileId);
  db.prepare("DELETE FROM files WHERE file_id=?").run(fileId);
}

export function insertFile(db, file, sha256, chunks) {
  const id = file.repoId + ":" + file.relativePath;
  db.prepare("INSERT INTO files(file_id,repo_id,relative_path,language,sha256,bytes,indexed_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, file.repoId, file.relativePath, file.language, sha256, file.size, new Date().toISOString());
  // Expand path tokens without inventing new symbol or graph relationships.
  const pathSearch = file.relativePath
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_\\/.-]+/gu, " ")
    .slice(0, 1024);
  const add = db.prepare("INSERT INTO chunks(file_id,repo_id,relative_path,path_search,start_line,end_line,body) VALUES(?,?,?,?,?,?,?)");
  for (const chunk of chunks) {
    // Lexical camelCase/PascalCase expansion only; do not claim AST symbol resolution.
    const identifiers = [...new Set(chunk.body.match(/\b[A-Za-z][A-Za-z0-9_]{2,80}\b/gu) ?? [])]
      .filter((term) => /[a-z][A-Z]|_[a-z]/u.test(term)).slice(0, 64);
    const identifierTerms = identifiers.join(" ")
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replace(/[_-]+/gu, " ");
    add.run(id, file.repoId, file.relativePath, (pathSearch + " " + identifierTerms).slice(0, 2048),
      chunk.startLine, chunk.endLine, chunk.body);
  }
}

export function writeRepoSnapshots(db, snapshots) {
  db.prepare("DELETE FROM repo_snapshots").run();
  const add = db.prepare("INSERT INTO repo_snapshots(repo_id,branch,head_sha,recorded_at) VALUES(?,?,?,?)");
  for (const row of snapshots) add.run(row.repoId, row.branch, row.head, new Date().toISOString());
}

export function readRepoSnapshots(db) {
  try {
    return db.prepare("SELECT repo_id AS repoId,branch,head_sha AS head,recorded_at AS recordedAt FROM repo_snapshots ORDER BY repo_id").all();
  } catch (error) {
    if (error?.code === "ERR_SQLITE_ERROR" && /no such table/u.test(error.message)) return [];
    throw error;
  }
}

export function recordRevision(db, stats, mode) {
  const result = db.prepare("INSERT INTO revisions(indexed_at,mode,changed,removed,unchanged,file_count,chunk_count,source_bytes) VALUES(?,?,?,?,?,?,?,?)").run(
    new Date().toISOString(), mode, stats.changed, stats.removed, stats.unchanged,
    stats.fileCount, stats.chunkCount, stats.sourceBytes,
  );
  return Number(result.lastInsertRowid);
}

export function databaseCounts(db) {
  return {
    fileCount: db.prepare("SELECT COUNT(*) AS value FROM files").get().value,
    chunkCount: db.prepare("SELECT COUNT(*) AS value FROM chunks").get().value,
    sourceBytes: db.prepare("SELECT COALESCE(SUM(bytes),0) AS value FROM files").get().value,
  };
}

export function searchIndex(db, expression, repoIds, languages, limit = 30) {
  const where = ["chunk_fts MATCH ?"];
  const params = [expression];
  if (repoIds.length) {
    where.push("c.repo_id IN (" + repoIds.map(() => "?").join(",") + ")");
    params.push(...repoIds);
  }
  if (languages.length) {
    where.push("f.language IN (" + languages.map(() => "?").join(",") + ")");
    params.push(...languages);
  }
  const sql = `SELECT c.repo_id AS repoId,c.relative_path AS relativePath,c.start_line AS startLine,
    c.end_line AS endLine,c.body AS body,f.sha256 AS sha256,f.language AS language,
    bm25(chunk_fts,5.0,1.0) AS score
    FROM chunk_fts JOIN chunks c ON c.id=chunk_fts.rowid JOIN files f ON f.file_id=c.file_id
    WHERE ${where.join(" AND ")}
    ORDER BY score LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}
