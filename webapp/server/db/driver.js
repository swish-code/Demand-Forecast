import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as nodeChildProcess from 'node:child_process'
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
 * How long to wait for a living holder of the database directory to let go.
 *
 * Long enough to cover a `--watch` handover, whose outgoing process writes a
 * backup before it closes, and short enough that a genuinely stuck second copy
 * is reported rather than waited on forever.
 */
const CLAIM_WAIT_MS = Number(process.env.DB_CLAIM_WAIT_MS) || 15000
const CLAIM_POLL_MS = 250

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

/**
 * Roughly when this machine last booted, as a millisecond timestamp.
 *
 * Derived rather than read, because no cross-platform API reports it. It drifts
 * by a second or two between readings, and on a machine that has slept it can
 * move further — Windows does not always count suspended time as uptime. So it
 * is only ever compared with a generous tolerance, and never on its own.
 */
export function bootedAt() {
  return Date.now() - os.uptime() * 1000
}

/** Two boot stamps this far apart are taken to be different boots. */
const BOOT_TOLERANCE_MS = 5 * 60 * 1000

/** Is a pid still running? */
function alive(pid) {
  try {
    process.kill(pid, 0) // does not signal; throws when the pid is gone
    return true
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return err.code !== 'ESRCH'
  }
}

/**
 * Could this pid be a copy of this application, or is it plainly something else?
 *
 * Only ever asked about a pid that is ALIVE but whose lock was written before
 * the current boot — which is to say, a pid Windows has handed to somebody new.
 * `true` and `null` are treated the same way by the caller; the useful answer is
 * a definite `false`, which says the holder is not a Node process at all and the
 * lock is a leftover.
 *
 * Best-effort on purpose. A machine where the lookup fails falls back to
 * refusing to start, which is the safe direction.
 */
function holderMightBeNode(pid) {
  try {
    const { spawnSync } = nodeChildProcess
    const probe =
      process.platform === 'win32'
        ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
            encoding: 'utf8',
            timeout: 4000,
            windowsHide: true,
          })
        : spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 4000,
          })
    if (probe.error || probe.status === null) return null
    const text = String(probe.stdout || '')
    // No row at all: the pid went away between the two checks. Not ours.
    if (!text.trim() || /no tasks are running/i.test(text)) return false
    return /node(\.exe)?/i.test(text)
  } catch {
    return null
  }
}

/**
 * One process at a time, enforced.
 *
 * The engine does not stop a second process opening the same directory; it just
 * quietly gives the two of them different views of it. That is worse than an
 * error — a stray `npm run dev` left one server reporting 138 recipients where
 * the database held 85, and nothing anywhere said why.
 *
 * So the owner writes its pid and refuses to start if a living process already
 * holds the directory. A pid belonging to nothing is a crash, not a conflict,
 * and is taken over.
 *
 * TWO WAYS THAT WENT WRONG, both fixed here on 8 Oct 2026.
 *
 * A pid is only meaningful within one boot. The lock file survives a restart of
 * the laptop and the operating system then hands that same number to something
 * unrelated, so `process.kill(pid, 0)` succeeds against a stranger and the
 * server refuses to start — not once, but on every attempt, until somebody
 * deletes the file by hand. Reported after exactly that: laptop restarted, VS
 * Code opened, server dead on the lock. So the lock now records the boot it was
 * taken in, and one taken before this boot cannot be held by anybody.
 *
 * The other is a handover, not a conflict. `node --watch` starts the incoming
 * process while the outgoing one is still closing — and closing now includes a
 * backup, so it takes a moment. A single look was a coin toss; losing it threw,
 * and because the start failed `--watch` sat waiting for a file change rather
 * than trying again, leaving the app down until someone noticed. So a live
 * holder is now waited for rather than refused outright.
 */
export async function claimDirectory(dir, { waitMs = CLAIM_WAIT_MS } = {}) {
  const lockFile = path.join(dir, 'owner.pid')

  /*
   * Both shapes of lock file.
   *
   * It used to hold a bare pid, and an upgrade must not be a reason to refuse to
   * start. A bare pid simply arrives with no boot stamp, which the checks below
   * treat as "cannot tell" - the old behaviour, for one restart, after which the
   * file is rewritten in the new shape.
   */
  const read = () => {
    let text
    try {
      text = fs.readFileSync(lockFile, 'utf8').trim()
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
    if (!text) return null
    try {
      const held = JSON.parse(text)
      return { pid: Number(held.pid), bootedAt: Number(held.bootedAt) || null }
    } catch {
      const pid = Number(text)
      return Number.isFinite(pid) && pid > 0 ? { pid, bootedAt: null } : null
    }
  }

  const deadline = Date.now() + waitMs
  let waited = false

  for (;;) {
    const held = read()

    if (!held?.pid || held.pid === process.pid) break
    if (!alive(held.pid)) break // a crash, or a reboot. The directory is ours.

    /*
     * A live pid whose lock predates this boot is a recycled number, not a
     * holder — nothing running now can have taken a lock before the machine
     * started. The image name is checked anyway, because the boot stamp is
     * derived and a machine that has slept can report a misleading one; a
     * holder that really is Node is left alone and waited for instead.
     */
    const sameBoot =
      held.bootedAt === null || Math.abs(held.bootedAt - bootedAt()) <= BOOT_TOLERANCE_MS
    if (!sameBoot && holderMightBeNode(held.pid) === false) {
      console.warn(
        `  [db] ignoring a lock left by process ${held.pid} from before this boot — ` +
          'the pid now belongs to something else.'
      )
      break
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `the local database at ${dir} is already open in process ${held.pid}. ` +
          'It allows one process at a time — stop the other copy of the app, ' +
          'or set DATABASE_URL to use a real PostgreSQL server.'
      )
    }

    // The handover case: the outgoing process of a --watch restart is still
    // closing. Said once, so a slow restart does not look like a hang.
    if (!waited) {
      waited = true
      console.log(`  [db] waiting for process ${held.pid} to release the database…`)
    }
    await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS))
  }

  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, bootedAt: bootedAt() }))
  releaseLock = () => {
    try {
      if (read()?.pid === process.pid) fs.unlinkSync(lockFile)
    } catch {
      // Going away anyway.
    }
  }
}

let releaseLock = () => {}

/**
 * PostgreSQL in this process, so local development needs nothing installed.
 *
 * One process at a time, and only ever a local convenience: a real deployment
 * sets DATABASE_URL and goes through openPg instead.
 */
async function openPglite() {
  const { PGlite } = await import('@electric-sql/pglite')
  const dir = path.join(DATA_DIR, 'pg')
  fs.mkdirSync(dir, { recursive: true })
  await claimDirectory(dir)

  /*
   * One retry, then a plain explanation.
   *
   * This engine allows a single process at a time. Nearly every failure to open
   * is another copy of the app already holding the directory — a stray `npm run
   * dev`, or the outgoing process of a --watch restart that has not let go yet.
   * A brief wait clears the second case.
   *
   * What it deliberately does not do is move the directory aside and start
   * fresh. That looks like recovery and is worse than the fault: if another
   * process really is running, renaming its database out from under it turns a
   * clear error into two half-written copies.
   */
  let lite
  try {
    lite = await PGlite.create(dir)
  } catch (first) {
    await new Promise((r) => setTimeout(r, 1500))
    try {
      lite = await PGlite.create(dir)
    } catch (err) {
      throw new Error(
        `the local database at ${dir} could not be opened (${err.message}). ` +
          'It allows one process at a time — check whether another copy of the app is running ' +
          'against the same DATA_DIR. Set DATABASE_URL to use a real PostgreSQL server instead.'
      )
    }
  }

  /*
   * One query at a time, in the order they were asked for.
   *
   * PGlite is a single connection to an in-process engine, and its wire
   * protocol has no more room for two overlapping statements than a real
   * connection would. Every caller in this app fans out with `Promise.all` —
   * nine brands, several reads each — and nothing was stopping those landing on
   * the engine together. When they did, the protocol state came apart:
   *
   *   unhandledRejection: cannot drop active portal ""
   *
   * repeating on every cycle from the moment two paths overlapped, and taking
   * whatever request was in flight with it.
   *
   * A promise chain is the whole fix. Each call waits for the previous one to
   * settle, so the fan-out still expresses "these are independent" and the
   * engine still sees them one after another. It costs nothing that matters:
   * the queries were never running in parallel inside a single-threaded WASM
   * engine anyway — they were only being handed to it in parallel.
   *
   * Note this serialises statements, not transactions. `tx` issues BEGIN, then
   * its caller's queries, then COMMIT, and another caller's statement can still
   * land between them — as it could before. That is a separate concern and
   * unrelated to the corruption this prevents.
   */
  let chain = Promise.resolve()
  const serial = (work) => {
    const run = chain.then(work, work)
    // The chain must survive a rejection, or one failed query stops every
    // query after it for the life of the process.
    chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  return {
    kind: 'pglite',
    async query(sql, params = []) {
      const res = await serial(() => lite.query(toPositional(sql), params))
      return { rows: res.rows ?? [], rowCount: res.affectedRows ?? (res.rows?.length ?? 0) }
    },
    async script(sql) {
      await serial(() => lite.exec(sql))
    },
    async close() {
      await lite.close()
      releaseLock()
    },
  }
}

let driver = null
let opening = null

/*
 * Close the database when the process is asked to stop.
 *
 * The in-process engine writes to a directory, and being killed between two
 * writes is what leaves it unopenable next time. `node --watch` sends SIGTERM
 * on every restart, so without this a developer corrupts their own database
 * simply by saving a file often enough.
 */
let closing = false
const shutdown = async (signal) => {
  if (closing) return
  closing = true
  /*
   * One last backup on the way out, from 7 Oct 2026.
   *
   * A clean shutdown is the other moment the data is known-good, and it is the
   * one that matters most: a restart for a code change is by far the commonest
   * reason this process stops, and it is when the entered tables are newest.
   *
   * Before the close below, because it has to read the database. Wrapped and
   * time-boxed: the signal handler has to finish promptly or the engine is
   * killed mid-write, which is the failure this whole file exists to prevent.
   */
  try {
    if (driver) {
      const { exportEntered } = await import('./backup.js')
      await Promise.race([
        exportEntered(),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ])
    }
  } catch {
    // Never delay or block an exit over a backup.
  }
  try {
    if (driver) await driver.close()
  } catch {
    // Nothing useful to do about it while exiting.
  }
  if (signal) process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => shutdown(signal))
}
process.once('beforeExit', () => shutdown(null))

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
