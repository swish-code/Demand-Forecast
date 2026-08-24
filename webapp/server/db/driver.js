import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * One small database interface, over PostgreSQL.
 *
 * Two drivers sit behind it and the application cannot tell them apart:
 *
 *   pg       a real PostgreSQL server, named by DATABASE_URL. This is what runs
 *            on Railway now and on the company's own server later — moving
 *            between them is a change of that one variable, nothing more.
 *
 *   pglite   PostgreSQL compiled to WebAssembly, running in this process
 *            against a local directory. Used only when DATABASE_URL is unset,
 *            so `npm run dev` still needs nothing installed. It is the same
 *            engine, so SQL that works here works there.
 *
 * The interface is deliberately four verbs. An ORM would have been more to
 * learn and more to go wrong for an application whose queries are all a few
 * lines of plain SQL.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.DATA_DIR || path.join(HERE, '..', '..', 'data')

/**
 * Rewrite `?` placeholders to PostgreSQL's `$1, $2`.
 *
 * Kept so the sixty-odd queries in this codebase did not all have to be
 * renumbered by hand, which is exactly the kind of edit that introduces a
 * silent off-by-one. Quoted strings are skipped, so a literal question mark
 * inside a value is left alone.
 */
export function toPositional(sql) {
  let out = ''
  let n = 0
  let quote = null

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]

    if (quote) {
      out += c
      // '' and "" are escaped quotes, not the end of the literal.
      if (c === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i]
        } else {
          quote = null
        }
      }
      continue
    }

    if (c === "'" || c === '"') {
      quote = c
      out += c
      continue
    }

    if (c === '?') {
      out += `$${++n}`
      continue
    }

    out += c
  }

  return out
}

/** A pg-backed connection, for Railway and for the company's own server. */
async function openPg(url) {
  const { default: pg } = await import('pg')

  // Managed Postgres almost always fronts a certificate the default trust store
  // does not recognise. Verification is off for those hosts rather than for
  // everything, and never for a connection the operator has marked strict.
  const managed = /railway|render|neon|supabase|amazonaws|azure/i.test(url)
  const ssl =
    process.env.PGSSLMODE === 'disable'
      ? false
      : process.env.PGSSLMODE === 'verify-full'
        ? { rejectUnauthorized: true }
        : managed
          ? { rejectUnauthorized: false }
          : false

  const pool = new pg.Pool({
    connectionString: url,
    ssl,
    max: Number(process.env.PGPOOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS) || 10_000,
  })

  // Surface a dead pool rather than letting an unhandled error take the process
  // down; a query will report it properly on the next attempt.
  pool.on('error', (err) => console.error('  [db] idle client error:', err.message))

  return {
    kind: 'postgres',
    async query(sql, params = []) {
      const res = await pool.query(toPositional(sql), params)
      return { rows: res.rows, rowCount: res.rowCount }
    },
    /**
     * Several statements at once.
     *
     * Passing values puts the driver on the extended protocol, which allows
     * exactly one statement — schema work has to go the simple way instead.
     */
    async script(sql) {
      await pool.query(sql)
    },
    async close() {
      await pool.end()
    },
  }
}

/** PostgreSQL in this process, so local development needs nothing installed. */
async function openPglite() {
  const { PGlite } = await import('@electric-sql/pglite')
  const dir = path.join(DATA_DIR, 'pg')
  fs.mkdirSync(dir, { recursive: true })
  const lite = await PGlite.create(dir)

  return {
    kind: 'pglite',
    async query(sql, params = []) {
      const res = await lite.query(toPositional(sql), params)
      return { rows: res.rows ?? [], rowCount: res.affectedRows ?? (res.rows?.length ?? 0) }
    },
    async script(sql) {
      await lite.exec(sql)
    },
    async close() {
      await lite.close()
    },
  }
}

let driver = null
let opening = null

export function databaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || ''
}

/** Opened once, shared. Concurrent callers wait on the same connection. */
export async function connect() {
  if (driver) return driver
  if (opening) return opening

  const url = databaseUrl()
  opening = (url ? openPg(url) : openPglite()).then((d) => {
    driver = d
    opening = null
    return d
  })
  return opening
}

export const describeConnection = () => {
  const url = databaseUrl()
  if (!url) return 'in-process PostgreSQL (no DATABASE_URL set)'
  try {
    const u = new URL(url)
    // Never the password.
    return `postgres://${u.username ? u.username + '@' : ''}${u.host}${u.pathname}`
  } catch {
    return 'postgres (DATABASE_URL set)'
  }
}

/* ------------------------------------------------------------ the API --- */

export const db = {
  /** One row, or undefined. */
  async get(sql, ...params) {
    const { rows } = await (await connect()).query(sql, params.flat())
    return rows[0]
  },

  /** Every row. */
  async all(sql, ...params) {
    const { rows } = await (await connect()).query(sql, params.flat())
    return rows
  },

  /**
   * A write. `changes` is how many rows it touched; `id` is the identity of an
   * inserted row when the statement asked for it with RETURNING.
   */
  async run(sql, ...params) {
    const { rows, rowCount } = await (await connect()).query(sql, params.flat())
    return { changes: rowCount ?? 0, id: rows[0]?.id ?? null, rows }
  },

  /** Several statements at once — schema work, mostly. */
  async exec(sql) {
    await (await connect()).script(sql)
  },

  /**
   * A transaction.
   *
   * PGlite has one connection, and pg hands them out per query, so rather than
   * pin a client this brackets the work. It is enough for this application:
   * nothing here writes from two places at once except the extract, which is
   * already guarded against running twice.
   */
  async tx(work) {
    const d = await connect()
    await d.query('BEGIN')
    try {
      const result = await work()
      await d.query('COMMIT')
      return result
    } catch (err) {
      await d.query('ROLLBACK').catch(() => {})
      throw err
    }
  },

  async close() {
    if (driver) await driver.close()
    driver = null
  },

  get kind() {
    return driver?.kind ?? null
  },
}
