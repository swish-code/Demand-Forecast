import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './db/driver.js'

/**
 * Where a request's time actually went.
 *
 * "The dashboard is slow with nine brands selected" is not a diagnosis, and
 * neither is a guess about which layer is responsible — the app has three
 * places a figure can come from, and they differ by three orders of magnitude:
 * the memory cache, the local copy, and Power BI. Which one answered is the
 * whole question, and until now nothing recorded it.
 *
 * So every API request carries a small ledger. Each call to the copy, to Power
 * BI, or to the cache adds a line to whichever request it happened inside, and
 * the request logs the totals when it finishes:
 *
 *   [perf] POST /api/component-level 4820ms · 9 brands · pbi 9x4310ms ·
 *          copy 27x180ms · cache 6 hits · 539 rows
 *
 * The ledger is per request rather than global because four of them run at
 * once on a page load, and global counters would attribute all the work to
 * whichever finished last.
 */

const store = new AsyncLocalStorage()

/** Off with PERF=0 for anyone who wants the log quiet. */
export const PERF = process.env.PERF !== '0'

/** The log file is opt-in; the console line is not. */
const FILE = process.env.PERF_LOG === '1' ? path.join(DATA_DIR, 'perf.log') : null
const MAX_BYTES = 2 * 1024 * 1024

function append(line) {
  if (!FILE) return
  try {
    // Rotate rather than grow without limit — this runs on a container with a
    // small disk, and a log nobody trims is a log that fills it.
    if (fs.existsSync(FILE) && fs.statSync(FILE).size > MAX_BYTES) {
      fs.renameSync(FILE, `${FILE}.1`)
    }
    fs.appendFileSync(FILE, line + '\n')
  } catch {
    /* a log that cannot be written must not fail the request */
  }
}

/**
 * Express middleware: one ledger per request, reported when the response ends.
 *
 * `next()` is called inside `store.run`, so everything downstream of it — the
 * route handler and every promise it awaits — sees this ledger. That is the
 * whole reason for AsyncLocalStorage rather than a module-level counter: four
 * requests are in flight during a page load and each has to keep its own tally.
 */
export function perfMiddleware(req, res, next) {
  if (!PERF) return next()
  const ledger = {
    label: `${req.method} ${req.originalUrl.split('?')[0]}`,
    meta: {},
    started: Date.now(),
    kinds: new Map(),
  }
  store.run(ledger, () => {
    res.on('finish', () => report(ledger))
    next()
  })
}

/** Record one unit of work against whichever request it happened inside. */
export function note(kind, ms) {
  const ledger = store.getStore()
  if (!ledger) return
  const held = ledger.kinds.get(kind) ?? { n: 0, ms: 0 }
  held.n += 1
  held.ms += ms
  ledger.kinds.set(kind, held)
}

/** Time `fn` and record it. The value passes through untouched. */
export async function timed(kind, fn) {
  if (!store.getStore()) return fn()
  const started = Date.now()
  try {
    return await fn()
  } finally {
    note(kind, Date.now() - started)
  }
}

/** Add a fact about the answer — row counts, brand counts — to the line. */
export function tag(key, value) {
  const ledger = store.getStore()
  if (ledger) ledger.meta = { ...ledger.meta, [key]: value }
}

function report(ledger) {
  const total = Date.now() - ledger.started
  const parts = [...ledger.kinds.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([kind, v]) => (v.ms ? `${kind} ${v.n}x${v.ms}ms` : `${kind} ${v.n}`))

  const meta = Object.entries(ledger.meta ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${v} ${k}`)

  const line = `[perf] ${ledger.label} ${total}ms${[...meta, ...parts].length ? ' · ' : ''}${[
    ...meta,
    ...parts,
  ].join(' · ')}`

  // Only the slow ones on the console; the file keeps everything, because the
  // fast requests are what a slow one has to be compared against.
  if (total >= Number(process.env.PERF_MIN_MS || 400)) console.log(line)
  append(JSON.stringify({ at: new Date().toISOString(), ms: total, ...ledger.meta, label: ledger.label, work: Object.fromEntries(ledger.kinds) }))
}
