import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The database.
 *
 * SQLite today. A PostgreSQL layer sits beside this in driver.js and schema.js,
 * ready for Railway and for the company's own server later — the remaining work
 * is converting the sixty-odd call sites from this synchronous interface to
 * that asynchronous one, which is a change every caller sees and so is being
 * done deliberately rather than in one sweep.
 *
 * Until then this stays, and the application runs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.DATA_DIR || path.join(HERE, '..', '..', 'data')
export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db')

mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(DB_PATH)

// Waiting comes first. Every statement after this one, including the journal
// mode below, will wait for a busy database rather than throw immediately —
// which matters during a --watch restart, when the outgoing process may still
// hold the file for a moment and the incoming one would otherwise die on the
// very first pragma.
db.exec('PRAGMA busy_timeout = 5000')

// WAL keeps reads from blocking the scheduled jobs that write, which now
// includes the hourly extract. The setting is stored in the file, so once it
// has been applied it survives; failing to reapply it is not worth refusing to
// start over.
try {
  db.exec('PRAGMA journal_mode = WAL')
} catch (err) {
  console.warn(`  [db] could not set WAL (${err.message}) — continuing`)
}

db.exec('PRAGMA foreign_keys = ON')

/**
 * The schema as it now stands, for a database that does not have it yet.
 *
 * The sixteen incremental steps this grew through are not replayed. They exist
 * only in the history of a file, and several were table rebuilds whose whole
 * purpose was to widen a CHECK constraint SQLite cannot alter — replaying them
 * produces exactly what is written here, with more ways to go wrong.
 *
 * An existing database is left alone: every one of those steps is already
 * recorded in its schema_migrations table.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    name            TEXT    NOT NULL DEFAULT '',
    password_hash   TEXT    NOT NULL,
    role            TEXT    NOT NULL CHECK (role IN ('admin','stakeholder','store','viewer')),
    status          TEXT    NOT NULL DEFAULT 'active'
                            CHECK (status IN ('pending','active','suspended','disabled')),
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login_at   TEXT,
    department      TEXT,
    auth_provider   TEXT    NOT NULL DEFAULT 'local'
  );

  CREATE TABLE IF NOT EXISTS user_scopes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    brand_code  TEXT,
    location_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_user_scopes_user ON user_scopes(user_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT    NOT NULL,
    last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
    revoked_at   TEXT,
    ip           TEXT,
    user_agent   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS login_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email_attempted TEXT    NOT NULL,
    success         INTEGER NOT NULL,
    reason          TEXT,
    ip              TEXT,
    user_agent      TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id);
  CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action        TEXT    NOT NULL,
    target        TEXT,
    detail_json   TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

  CREATE TABLE IF NOT EXISTS digests (
    day          TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL,
    reason       TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    acked_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    acked_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT    NOT NULL,
    key           TEXT    NOT NULL,
    severity      TEXT    NOT NULL DEFAULT 'warning',
    title         TEXT    NOT NULL,
    detail        TEXT,
    count         INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    resolved_at   TEXT,
    resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open_key ON alerts(key) WHERE resolved_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_alerts_last_seen ON alerts(last_seen_at);

  CREATE TABLE IF NOT EXISTS email_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    day        TEXT    NOT NULL,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email      TEXT    NOT NULL,
    role       TEXT    NOT NULL,
    subject    TEXT,
    status     TEXT    NOT NULL CHECK (status IN ('sent','failed','skipped')),
    error      TEXT,
    meta_json  TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_log_day ON email_log(day);
  CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);

  CREATE TABLE IF NOT EXISTS email_recipients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    name       TEXT,
    report     TEXT    NOT NULL
               CHECK (report IN ('store_plan','branch_forecast','brand_summary','daily_digest')),
    brands     TEXT,
    locations  TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    department TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recipient_email_report ON email_recipients(email, report);

  CREATE TABLE IF NOT EXISTS mail_identity (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    email         TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    connected_at  TEXT NOT NULL DEFAULT (datetime('now')),
    connected_by  INTEGER
  );

  CREATE TABLE IF NOT EXISTS cube_daily (
    brand    TEXT NOT NULL,
    date     TEXT NOT NULL,
    location TEXT NOT NULL,
    product  TEXT NOT NULL,
    actual   REAL NOT NULL DEFAULT 0,
    forecast REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (brand, date, location, product)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_cube_brand_date ON cube_daily(brand, date);
  CREATE INDEX IF NOT EXISTS idx_cube_loc_cover ON cube_daily(brand, location, date, actual, forecast);

  CREATE TABLE IF NOT EXISTS cube_product_daily (
    brand    TEXT NOT NULL,
    date     TEXT NOT NULL,
    product  TEXT NOT NULL,
    actual   REAL NOT NULL DEFAULT 0,
    forecast REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (brand, date, product)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS cube_article_daily (
    brand    TEXT NOT NULL,
    date     TEXT NOT NULL,
    article  TEXT NOT NULL,
    product  TEXT NOT NULL,
    actual   REAL NOT NULL DEFAULT 0,
    forecast REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (brand, date, article, product)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS cube_coverage (
    brand        TEXT PRIMARY KEY,
    from_date    TEXT NOT NULL,
    to_date      TEXT NOT NULL,
    rows         INTEGER NOT NULL DEFAULT 0,
    refreshed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec('BEGIN')
  try {
    db.exec(SCHEMA)
    db.prepare(
      `INSERT INTO schema_migrations (name) VALUES ('001_consolidated')
       ON CONFLICT(name) DO NOTHING`
    ).run()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  const broken = db.prepare('PRAGMA foreign_key_check').all()
  if (broken.length) console.warn(`  [db] ${broken.length} foreign key rows dangling`)
}
