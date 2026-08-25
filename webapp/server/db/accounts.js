import { db as pg, connect, databaseUrl, describeConnection } from './driver.js'
import { db as sqlite } from './index.js'

/**
 * Accounts live in PostgreSQL; the forecast copy stays in SQLite.
 *
 * The split is about what must survive a deployment. Every platform this runs
 * on gives the container a fresh filesystem, so a SQLite file beside the code
 * is discarded on the next push — and an application that forgets its users and
 * their brand grants every time it is deployed is not deployed at all.
 *
 * The forecast copy has the opposite character: it is derived, it is large, and
 * it is rebuilt from Power BI on a schedule. Losing it costs a backfill, not
 * somebody's access. So it stays where it is, and only the tables a person
 * would have to re-enter by hand move.
 *
 * What moves:  users, user_scopes, sessions, login_events, audit_log
 * What stays:  cube_*, digests, alerts, email_*, mail_identity
 *
 * With no DATABASE_URL the driver runs PostgreSQL in-process against a local
 * directory, so this is the same engine and the same SQL on a laptop as on the
 * server — `npm run dev` still needs nothing installed.
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
`

/* ---------------------------------------------------------------- moving --- */

const TABLES = ['users', 'user_scopes', 'sessions', 'login_events', 'audit_log']

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

  let rows
  try {
    rows = Object.fromEntries(TABLES.map((t) => [t, sqlite.prepare(`SELECT * FROM ${t}`).all()]))
  } catch (err) {
    return { imported: false, reason: `nothing to import (${err.message})` }
  }
  if (!rows.users.length) return { imported: false, reason: 'nothing to import' }

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
    for (const table of ['users', 'user_scopes', 'login_events', 'audit_log']) {
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
export async function initAccounts() {
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
