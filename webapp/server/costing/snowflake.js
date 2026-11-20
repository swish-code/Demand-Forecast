/**
 * The Snowflake connection for the Monthly MC Analysis page - 19 Nov 2026.
 *
 * The one place the web app writes to Snowflake. Everything else the app
 * stores lives in its own Postgres database; the Costing Department asked for
 * its classifications, audit history and alert records to live in Snowflake,
 * beside the data warehouse, instead.
 *
 * SETTINGS (server .env only - never sent to the browser):
 *
 *   SNOWFLAKE_ACCOUNT        account identifier, e.g. UMWIJEO-IF31569
 *   SNOWFLAKE_USERNAME       a user that may CREATE TABLE / INSERT / UPDATE
 *   SNOWFLAKE_PASSWORD       its password, OR
 *   SNOWFLAKE_PRIVATE_KEY_PATH (+ SNOWFLAKE_PRIVATE_KEY_PASS) for key-pair auth
 *   SNOWFLAKE_WAREHOUSE      compute warehouse to run on
 *   SNOWFLAKE_DATABASE       database holding the app's tables
 *   SNOWFLAKE_SCHEMA         schema holding the app's tables
 *   SNOWFLAKE_ROLE           optional role
 *
 * A POOL, NOT ONE SHARED CONNECTION. A classification change is an UPDATE and
 * an audit INSERT in one transaction, and Snowflake transactions belong to the
 * session. Two requests sharing a session would interleave their statements
 * inside each other's transaction; the pool hands each unit of work its own.
 */
import fs from 'node:fs'
import snowflakeSdk from 'snowflake-sdk'

const snowflake = snowflakeSdk.default ?? snowflakeSdk
snowflake.configure({ logLevel: 'ERROR' })

const env = (k) => String(process.env[k] ?? '').trim()

/**
 * The Snowflake user, under either spelling.
 *
 * 19 Nov 2026: the credentials arrived as `SNOWFLAKE_USER`, which is what
 * Snowflake's own driver documentation and most tooling call it, while this
 * file had only ever read `SNOWFLAKE_USERNAME`. The app reported itself
 * unconfigured with a complete set of credentials sitting in front of it.
 *
 * Both are accepted rather than one being renamed, because the .env is shared
 * with other tooling and a rename there would have broken whatever else reads
 * it. `SNOWFLAKE_USERNAME` still wins where both are set, so nothing that
 * already worked changes.
 */
const envUser = () => env('SNOWFLAKE_USERNAME') || env('SNOWFLAKE_USER')

/** Identifiers are embedded in SQL text, so they must be plain names. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/

/** Which settings are missing - empty means configured. */
export function snowflakeMissing() {
  const missing = []
  for (const k of ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_WAREHOUSE', 'SNOWFLAKE_DATABASE', 'SNOWFLAKE_SCHEMA']) {
    if (!env(k)) missing.push(k)
  }
  // Named for both spellings, so the message says what to set rather than
  // naming the one of the two this file happens to prefer.
  if (!envUser()) missing.push('SNOWFLAKE_USERNAME or SNOWFLAKE_USER')
  if (!env('SNOWFLAKE_PASSWORD') && !env('SNOWFLAKE_PRIVATE_KEY_PATH')) {
    missing.push('SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY_PATH')
  }
  for (const k of ['SNOWFLAKE_DATABASE', 'SNOWFLAKE_SCHEMA']) {
    if (env(k) && !IDENT.test(env(k))) missing.push(`${k} (must be a plain identifier)`)
  }
  return missing
}

export const snowflakeConfigured = () => snowflakeMissing().length === 0

/** The fully qualified name of one of the app's tables. */
export function table(name) {
  if (!IDENT.test(name)) throw new Error(`Bad table name: ${name}`)
  return `${env('SNOWFLAKE_DATABASE')}.${env('SNOWFLAKE_SCHEMA')}.${name}`
}

let pool = null

function connectionOptions() {
  const opts = {
    account: env('SNOWFLAKE_ACCOUNT'),
    username: envUser(),
    warehouse: env('SNOWFLAKE_WAREHOUSE'),
    database: env('SNOWFLAKE_DATABASE'),
    schema: env('SNOWFLAKE_SCHEMA'),
    application: 'SWiSH_DemandForecast',
    clientSessionKeepAlive: true,
  }
  if (env('SNOWFLAKE_ROLE')) opts.role = env('SNOWFLAKE_ROLE')
  if (env('SNOWFLAKE_PRIVATE_KEY_PATH')) {
    opts.authenticator = 'SNOWFLAKE_JWT'
    opts.privateKeyPath = env('SNOWFLAKE_PRIVATE_KEY_PATH')
    if (env('SNOWFLAKE_PRIVATE_KEY_PASS')) opts.privateKeyPass = env('SNOWFLAKE_PRIVATE_KEY_PASS')
    if (!fs.existsSync(opts.privateKeyPath)) {
      throw new Error(`SNOWFLAKE_PRIVATE_KEY_PATH does not exist: ${opts.privateKeyPath}`)
    }
  } else {
    opts.password = env('SNOWFLAKE_PASSWORD')
  }
  return opts
}

function getPool() {
  if (!snowflakeConfigured()) {
    const err = new Error(`Snowflake is not configured: ${snowflakeMissing().join(', ')}`)
    err.status = 503
    throw err
  }
  if (!pool) pool = snowflake.createPool(connectionOptions(), { max: 4, min: 0, evictionRunIntervalMillis: 60_000 })
  return pool
}

/**
 * How many rows a DML statement changed.
 *
 * Snowflake answers INSERT / UPDATE / DELETE / MERGE with a one-row result -
 * "number of rows inserted", "number of rows updated" and so on - and the
 * driver's own counter is not filled for every statement type. Reading the
 * result row covers MERGE, which is what the duplicate and conflict checks in
 * store.js depend on. Null for statements that change nothing (SELECT).
 */
export function changedRows(stmt, rows) {
  const first = rows?.[0]
  if (first && Object.keys(first).some((k) => /^number of rows /i.test(k))) {
    return Object.entries(first)
      .filter(([k]) => /^number of rows (inserted|updated|deleted)/i.test(k))
      .reduce((s, [, v]) => s + (Number(v) || 0), 0)
  }
  const n = stmt?.getNumUpdatedRows?.()
  return Number.isFinite(n) ? n : null
}

/** Run one statement on a given connection. Resolves to the rows. */
export function execOn(conn, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, stmt, rows) => {
        if (err) {
          err.sql = sqlText.slice(0, 200)
          reject(err)
        } else {
          resolve({ rows: rows ?? [], affected: changedRows(stmt, rows) })
        }
      },
    })
  })
}

/** One statement on a pooled connection. */
export async function query(sqlText, binds = []) {
  return getPool().use(async (conn) => (await execOn(conn, sqlText, binds)).rows)
}

/**
 * Several statements as ONE transaction on one connection.
 *
 * `work` receives `run(sql, binds)`; anything it throws rolls the whole
 * transaction back, so an UPDATE is never kept without its audit row.
 */
export async function transaction(work) {
  return getPool().use(async (conn) => {
    await execOn(conn, 'BEGIN')
    try {
      const out = await work((sql, binds) => execOn(conn, sql, binds))
      await execOn(conn, 'COMMIT')
      return out
    } catch (err) {
      await execOn(conn, 'ROLLBACK').catch(() => {})
      throw err
    }
  })
}

/** For the health line on the page: can we reach it, and as whom. */
export async function snowflakeStatus() {
  if (!snowflakeConfigured()) return { configured: false, ok: false, missing: snowflakeMissing() }
  try {
    const [row] = await query('SELECT CURRENT_USER() AS U, CURRENT_ROLE() AS R, CURRENT_DATABASE() AS D, CURRENT_SCHEMA() AS S')
    return { configured: true, ok: true, user: row?.U, role: row?.R, database: row?.D, schema: row?.S }
  } catch (err) {
    return { configured: true, ok: false, error: String(err.message).slice(0, 200) }
  }
}
