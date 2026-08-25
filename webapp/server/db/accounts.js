import path from 'node:path'
import { db as pg, connect, databaseUrl, describeConnection, DATA_DIR } from './driver.js'

/**
 * The application's database. PostgreSQL, and only PostgreSQL.
 *
 * It began on SQLite, which was right while this was one person's laptop and
 * wrong the moment it was deployed: every platform hands the container a fresh
 * filesystem, so a file beside the code is discarded on the next push — and an
 * application that forgets its users, their brand grants and its recipient list
 * every time it deploys is not deployed at all.
 *
 * DATABASE_URL names the server. Unset, the driver runs PostgreSQL in-process
 * against a local directory, so `npm run dev` still needs nothing installed and
 * it is the same engine and the same SQL either way. No credentials appear
 * anywhere in this repository.
 *
 * The schema is created on boot if it is not there — every statement is
 * IF NOT EXISTS, so it is safe to run on every start — and anything still in an
 * old SQLite file is carried across once, into an empty database only.
 */

/* ---------------------------------------------------------------- schema --- */

const NOW = "to_char(now(), 'YYYY-MM-DD HH24:MI:SS')"

/*
 * Two translations from the SQLite original worth knowing about.
 *
 * Timestamps stay TEXT in 'YYYY-MM-DD HH:MM:SS'. They could be timestamptz, but
 * the application compares and slices them as strings in a dozen places, and
 * changing the storage type would mean changing all of it for no behavioural
 * gain.
 *
 * Email uniqueness was COLLATE NOCASE, which PostgreSQL has no equivalent for.
 * A unique index on lower(email) does the same job, and every lookup already
 * goes through the same helper.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  email           TEXT    NOT NULL,
  name            TEXT    NOT NULL DEFAULT '',
  password_hash   TEXT    NOT NULL,
  role            TEXT    NOT NULL CHECK (role IN ('admin','stakeholder','store','viewer')),
  status          TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('pending','active','suspended','disabled')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT    NOT NULL DEFAULT ${NOW},
  last_login_at   TEXT,
  department      TEXT,
  auth_provider   TEXT    NOT NULL DEFAULT 'local'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS user_scopes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_code  TEXT,
  location_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_scopes_user ON user_scopes(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT ${NOW},
  expires_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL DEFAULT ${NOW},
  revoked_at   TEXT,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_events (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email_attempted TEXT    NOT NULL,
  success         INTEGER NOT NULL,
  reason          TEXT,
  ip              TEXT,
  user_agent      TEXT,
  created_at      TEXT    NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id);
CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id            SERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT    NOT NULL,
  target        TEXT,
  detail_json   TEXT,
  created_at    TEXT    NOT NULL DEFAULT ${NOW}
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
  id            SERIAL PRIMARY KEY,
  source        TEXT    NOT NULL,
  key           TEXT    NOT NULL,
  severity      TEXT    NOT NULL DEFAULT 'warning',
  title         TEXT    NOT NULL,
  detail        TEXT,
  count         INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT    NOT NULL DEFAULT ${NOW},
  last_seen_at  TEXT    NOT NULL DEFAULT ${NOW},
  resolved_at   TEXT,
  resolved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- One open alert per key; resolved ones may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_open_key ON alerts(key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_last_seen ON alerts(last_seen_at);

CREATE TABLE IF NOT EXISTS email_log (
  id         SERIAL PRIMARY KEY,
  day        TEXT    NOT NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email      TEXT    NOT NULL,
  role       TEXT    NOT NULL,
  subject    TEXT,
  status     TEXT    NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error      TEXT,
  meta_json  TEXT,
  created_at TEXT    NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_email_log_day ON email_log(day);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);

CREATE TABLE IF NOT EXISTS email_recipients (
  id         SERIAL PRIMARY KEY,
  email      TEXT    NOT NULL,
  name       TEXT,
  report     TEXT    NOT NULL
             CHECK (report IN ('store_plan','branch_forecast','brand_summary','daily_digest')),
  brands     TEXT,
  locations  TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT ${NOW},
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipient_email_report ON email_recipients(email, report);

-- The one mailbox the app may send as. One row, ever. The refresh token is
-- stored encrypted; see mail/delegated.js.
CREATE TABLE IF NOT EXISTS mail_identity (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  email         TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  connected_at  TEXT NOT NULL DEFAULT ${NOW},
  connected_by  INTEGER
);

-- The local copy of the forecast, at the grain the Overview reads it. Article
-- grain lives in its own table without the branch column; with it that is four
-- hundred thousand rows per brand per sixty days, past what the Power BI query
-- API returns in one go.
CREATE TABLE IF NOT EXISTS cube_daily (
  brand    TEXT NOT NULL,
  date     TEXT NOT NULL,
  location TEXT NOT NULL,
  product  TEXT NOT NULL,
  actual   DOUBLE PRECISION NOT NULL DEFAULT 0,
  forecast DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, date, location, product)
);
CREATE INDEX IF NOT EXISTS idx_cube_brand_date ON cube_daily(brand, date);
CREATE INDEX IF NOT EXISTS idx_cube_loc_cover ON cube_daily(brand, location, date, actual, forecast);

CREATE TABLE IF NOT EXISTS cube_product_daily (
  brand    TEXT NOT NULL,
  date     TEXT NOT NULL,
  product  TEXT NOT NULL,
  actual   DOUBLE PRECISION NOT NULL DEFAULT 0,
  forecast DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, date, product)
);

CREATE TABLE IF NOT EXISTS cube_article_daily (
  brand    TEXT NOT NULL,
  date     TEXT NOT NULL,
  article  TEXT NOT NULL,
  product  TEXT NOT NULL,
  actual   DOUBLE PRECISION NOT NULL DEFAULT 0,
  forecast DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, date, article, product)
);

CREATE TABLE IF NOT EXISTS cube_coverage (
  brand        TEXT PRIMARY KEY,
  from_date    TEXT NOT NULL,
  to_date      TEXT NOT NULL,
  rows         INTEGER NOT NULL DEFAULT 0,
  refreshed_at TEXT NOT NULL DEFAULT ${NOW}
);
`

/* ---------------------------------------------------------------- moving --- */

/*
 * Carried over from SQLite. The cube tables are deliberately not on this list:
 * they are a million and a half derived rows the extract rebuilds from Power BI
 * on its own schedule, and copying them a row at a time would take far longer
 * than letting it.
 */
const TABLES = [
  'users',
  'user_scopes',
  'sessions',
  'login_events',
  'audit_log',
  'digests',
  'alerts',
  'email_log',
  'email_recipients',
  'mail_identity',
]

/**
 * Bring across whatever the SQLite file still holds, once.
 *
 * Only when the accounts table is empty, so this can never run twice and can
 * never overwrite something that has since changed. On a fresh deployment there
 * is nothing to bring and it does nothing; on a machine that has been running
 * the app for weeks it carries the accounts, their brand grants and their
 * history over without anybody re-typing them.
 *
 * Identity columns are reset afterwards. Copying rows with explicit ids leaves
 * the sequence at 1, and the next insert would collide with the first row.
 */
async function importFromSqlite() {
  const { n } = (await pg.get('SELECT COUNT(*)::int AS n FROM users')) ?? { n: 0 }
  if (n > 0) return { imported: false, reason: 'accounts already present' }

  /*
   * The old SQLite file, if this machine still has one.
   *
   * Opened here rather than imported at the top, so a deployment that has never
   * seen SQLite does not carry the driver at all. A missing file, a missing
   * table or a missing module all mean the same thing — there is nothing to
   * bring across — and none of them is an error.
   */
  let rows
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true })
    rows = Object.fromEntries(TABLES.map((t) => [t, legacy.prepare(`SELECT * FROM ${t}`).all()]))
    legacy.close()
  } catch (err) {
    return { imported: false, reason: `nothing to import (${err.message})` }
  }
  if (!rows.users?.length) return { imported: false, reason: 'nothing to import' }

  const counts = {}
  await pg.tx(async () => {
    for (const table of TABLES) {
      const list = rows[table]
      counts[table] = list.length
      for (const row of list) {
        const cols = Object.keys(row)
        const marks = cols.map(() => '?').join(', ')
        await pg.run(
          `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${marks})
           ON CONFLICT DO NOTHING`,
          cols.map((c) => row[c])
        )
      }
    }
    // Sequences must catch up with the ids that were just inserted.
    for (const table of ['users', 'user_scopes', 'login_events', 'audit_log',
                         'alerts', 'email_log', 'email_recipients']) {
      await pg.run(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`
      )
    }
  })
  return { imported: true, counts }
}

/**
 * Create the schema if it is not there, then carry over any existing accounts.
 *
 * Safe to run on every boot: the DDL is all IF NOT EXISTS and the import only
 * fires against an empty accounts table.
 */
export async function initDatabase() {
  await connect()
  await pg.exec(SCHEMA)

  const result = await importFromSqlite()
  const { n } = (await pg.get('SELECT COUNT(*)::int AS n FROM users')) ?? { n: 0 }

  console.log(`  Accounts: ${describeConnection()}`)
  if (result.imported) {
    console.log(
      `  Carried over from SQLite: ${Object.entries(result.counts)
        .map(([t, c]) => `${c} ${t}`)
        .join(', ')}`
    )
  }
  console.log(`  ${n} account${n === 1 ? '' : 's'}`)
  return { users: n, ...result }
}

export { pg, databaseUrl }
