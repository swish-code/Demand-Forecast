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
-- A consent in flight: the PKCE verifier, waiting for Microsoft to send the
-- browser back. Rows live for ten minutes and are deleted as they are redeemed.
CREATE TABLE IF NOT EXISTS mail_consents (
  state      TEXT PRIMARY KEY,
  verifier   TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

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
CREATE INDEX IF NOT EXISTS idx_cube_articledaily_cover
  ON cube_article_daily(brand, date) INCLUDE (article, product, actual, forecast);

/*
 * Branch totals by day, without the product.
 *
 * The expensive dimension is product crossed with branch: a year of that for
 * one brand is two thirds of a million rows. Split apart, the two questions
 * that actually get asked are cheap — a year of branch totals is about six
 * thousand rows a brand, and a year of product totals about a hundred and
 * thirty thousand. So these carry the whole calendar while cube_daily, which
 * holds the cross product, carries only the recent window.
 */
CREATE TABLE IF NOT EXISTS cube_location_daily (
  brand    TEXT NOT NULL,
  date     TEXT NOT NULL,
  location TEXT NOT NULL,
  actual   DOUBLE PRECISION NOT NULL DEFAULT 0,
  forecast DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, date, location)
);
CREATE INDEX IF NOT EXISTS idx_cube_locdaily
  ON cube_location_daily(brand, date) INCLUDE (location, actual, forecast);

/*
 * The Ingredients page, which until now went to Power BI on every single
 * request because recipes were never copied at all.
 *
 * Component grain is far smaller than it looks: a year for one brand is about
 * fifty-six thousand rows, because a recipe has a few hundred components rather
 * than a few thousand products.
 */
CREATE TABLE IF NOT EXISTS cube_component_daily (
  brand     TEXT NOT NULL,
  date      TEXT NOT NULL,
  recipe    TEXT NOT NULL,
  item      TEXT NOT NULL,
  bu        TEXT NOT NULL,
  node_type TEXT NOT NULL,
  actual    DOUBLE PRECISION NOT NULL DEFAULT 0,
  forecast  DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, date, recipe, item, bu, node_type)
);
CREATE INDEX IF NOT EXISTS idx_cube_compdaily ON cube_component_daily(brand, date);
/*
 * Covering indexes, for the widest window rather than the common one.
 *
 * A month reads a few thousand rows and any plan is fast enough. The whole
 * calendar reads every row this brand has, and then the measures have to be
 * fetched from the heap one row at a time. Carrying the two numbers in the
 * index itself makes that an index-only scan, which is the difference between
 * "All dates" feeling instant and feeling broken.
 */
CREATE INDEX IF NOT EXISTS idx_cube_compdaily_cover
  ON cube_component_daily(brand, date) INCLUDE (recipe, item, bu, node_type, actual, forecast);

/*
 * Two windows, not one.
 *
 * from_date/to_date is the wide window — the whole model calendar — covered by
 * the tables that do not carry a branch. detail_from/detail_to is the narrower
 * window covered by cube_daily, which does. A question that filters by branch
 * has to be checked against the second; everything else against the first.
 *
 * The detail columns are nullable so a database written by the previous version
 * reads as "no detail coverage" rather than as coverage it does not have.
 */
/*
 * The same two tables again, by month.
 *
 * A year of articles is a hundred and ninety thousand rows a brand and a year
 * of components fifty-six thousand, and summing either of those took seconds —
 * enough that "All dates" felt broken while every other preset felt instant.
 * By month they are a thirtieth of the size, and a window is answered as
 * whichever whole months it contains plus the odd days at each end.
 *
 * Derived from the daily tables in the same transaction that writes them, by a
 * single GROUP BY, so they cannot drift: there is no second fetch to go wrong
 * and nothing to reconcile.
 */
CREATE TABLE IF NOT EXISTS cube_article_monthly (
  brand    TEXT NOT NULL,
  month    TEXT NOT NULL,
  article  TEXT NOT NULL,
  product  TEXT NOT NULL,
  actual   DOUBLE PRECISION NOT NULL DEFAULT 0,
  forecast DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, month, article, product)
);

CREATE TABLE IF NOT EXISTS cube_component_monthly (
  brand     TEXT NOT NULL,
  month     TEXT NOT NULL,
  recipe    TEXT NOT NULL,
  item      TEXT NOT NULL,
  bu        TEXT NOT NULL,
  node_type TEXT NOT NULL,
  actual    DOUBLE PRECISION NOT NULL DEFAULT 0,
  forecast  DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, month, recipe, item, bu, node_type)
);

/*
 * What actually left the warehouse, copied.
 *
 * The Ingredients page asked Warehouse Analytics directly, one query per brand.
 * With nine selected that is nine at once, which is exactly the burst the
 * capacity answers with 429 and a sixty-second Retry-After: measured at 62
 * seconds for a page that should take half of one.
 *
 * By article and day, without a destination, so it is small — a year is roughly
 * a hundred and twenty thousand rows a brand. The branch is dropped because
 * nothing can use it yet: outbound names its destinations and the forecast uses
 * codes, and that mapping is still unsettled.
 */
CREATE TABLE IF NOT EXISTS cube_outbound_daily (
  brand    TEXT NOT NULL,
  date     TEXT NOT NULL,
  article  TEXT NOT NULL,
  qty      DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, date, article)
);
CREATE INDEX IF NOT EXISTS idx_cube_outbound
  ON cube_outbound_daily(brand, date) INCLUDE (article, qty);

CREATE TABLE IF NOT EXISTS cube_outbound_monthly (
  brand   TEXT NOT NULL,
  month   TEXT NOT NULL,
  article TEXT NOT NULL,
  qty     DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, month, article)
);

/*
 * The article master, and the constants that go with it.
 *
 * Both are per month and cost a round trip each to work out, which the first
 * request after a restart was paying — nearly seven seconds. Held here instead,
 * refreshed by the extract.
 */
CREATE TABLE IF NOT EXISTS cube_article (
  article TEXT PRIMARY KEY,
  name    TEXT NOT NULL DEFAULT '',
  unit    TEXT NOT NULL DEFAULT ''
);

/*
 * Where an article goes when it does not go to a shop.
 *
 * Outbound is attributed to a brand by its destination, so an article that only
 * ever moves into the central kitchen or the central warehouse is correctly
 * excluded from every brand's figure — and correctly reads as a blank, which
 * looks exactly like a fault to anybody holding the Warehouse Dashboard beside
 * it. Clear Sauce Container is the case: 6,504,632 units of real movement, all
 * of it to CKU/CPU and Central Warehouse, none of it to a brand.
 *
 * So the destinations that are not brands are recorded too. Nothing is added to
 * any brand's total from here; it exists so the blank can say what it means.
 */
CREATE TABLE IF NOT EXISTS cube_article_elsewhere (
  article     TEXT NOT NULL,
  destination TEXT NOT NULL,
  qty         DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (article, destination)
);
CREATE INDEX IF NOT EXISTS idx_cube_elsewhere ON cube_article_elsewhere(article);

CREATE TABLE IF NOT EXISTS cube_constant (
  brand    TEXT NOT NULL,
  article  TEXT NOT NULL,
  month    TEXT NOT NULL,
  constant DOUBLE PRECISION NOT NULL,
  outbound DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (brand, article)
);

CREATE TABLE IF NOT EXISTS cube_coverage (
  brand        TEXT PRIMARY KEY,
  from_date    TEXT NOT NULL,
  to_date      TEXT NOT NULL,
  rows         INTEGER NOT NULL DEFAULT 0,
  refreshed_at TEXT NOT NULL DEFAULT ${NOW}
);
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS detail_from TEXT;
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS detail_to TEXT;
-- Whether the recipe copy actually has anything for this brand. One of the
-- three wide fetches can fail on its own, and the page that reads it has to
-- know that rather than answering with an empty table.
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS components INTEGER NOT NULL DEFAULT 0;
-- What the model's own calendar spans. A request reaching outside it is asking
-- for days that do not exist anywhere, so the copy can still answer it.
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS model_from TEXT;
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS model_to TEXT;
-- The recipe copy keeps its own dates: one of the three wide fetches can fail
-- on its own, and the Ingredients page must not inherit a range from a table it
-- does not read.
/*
 * The ERP article number on the component rows.
 *
 * Added rather than built into the table so an existing copy gains it without
 * being thrown away; it fills on the next extract. It is not part of the key —
 * an article is a property of the item, not a separate line — so a copy written
 * before this existed keeps working with the column empty, and the Ingredients
 * page simply shows no consumption until the copy is rebuilt.
 */
ALTER TABLE cube_component_daily ADD COLUMN IF NOT EXISTS article TEXT NOT NULL DEFAULT '';
ALTER TABLE cube_component_monthly ADD COLUMN IF NOT EXISTS article TEXT NOT NULL DEFAULT '';

-- What the outbound copy spans, so a window it does not hold goes live.
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS out_from TEXT;
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS out_to TEXT;

-- The model's own calendar, so a cold page load does not have to ask nine
-- semantic models what day it is. Every page needs this to resolve its window,
-- so it was fetched live on every cold load: measured at six seconds for nine
-- brands, for four dates that change once a day.
/*
 * Tomorrow's plan, as Power BI computed it.
 *
 * The measures behind this page — Prep Status, Last 2 Weekdays Avg Actual,
 * Demand Change % — live in the model, and reimplementing them here would be
 * two definitions of the same figure waiting to disagree. So the answers are
 * copied rather than the logic: whatever Power BI returned, stored as it came.
 *
 * It is one query per brand per refresh and the plan changes once a day, but it
 * was being fetched live on every cold load — measured at 3.4 seconds for nine
 * brands, for the page branch staff open first thing every morning.
 */
CREATE TABLE IF NOT EXISTS cube_plan (
  brand          TEXT NOT NULL,
  plan_date      TEXT,
  article        TEXT NOT NULL,
  location       TEXT NOT NULL,
  product        TEXT NOT NULL DEFAULT '',
  tomorrow_qty   REAL NOT NULL DEFAULT 0,
  last_avg       REAL,
  demand_change  REAL,
  prep_status    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (brand, article, location, product)
);
CREATE INDEX IF NOT EXISTS idx_cube_plan ON cube_plan(brand, tomorrow_qty DESC);

/* The five cards above it, one row a brand. */
CREATE TABLE IF NOT EXISTS cube_plan_kpis (
  brand        TEXT PRIMARY KEY,
  plan_date    TEXT,
  today_date   TEXT,
  tomorrow_qty REAL NOT NULL DEFAULT 0,
  to_prepare   REAL NOT NULL DEFAULT 0,
  high_demand  REAL NOT NULL DEFAULT 0,
  low_demand   REAL NOT NULL DEFAULT 0,
  today_qty    REAL NOT NULL DEFAULT 0,
  refreshed_at TEXT
);

ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS cal_today TEXT;
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS cal_last_actual TEXT;
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS comp_from TEXT;
ALTER TABLE cube_coverage ADD COLUMN IF NOT EXISTS comp_to TEXT;
/*
 * Nullable, because "nothing" is an answer.
 *
 * These were NOT NULL when they held the window an extract had asked for.
 * They now hold the range the rows actually span, and a table with no rows in
 * it spans nothing — which has to be recordable, or a brand with an empty copy
 * goes on claiming the dates it once had.
 */
ALTER TABLE cube_coverage ALTER COLUMN from_date DROP NOT NULL;
ALTER TABLE cube_coverage ALTER COLUMN to_date DROP NOT NULL;
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
