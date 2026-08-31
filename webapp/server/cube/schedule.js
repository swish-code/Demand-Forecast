import { config } from '../config.js'
import { pg } from '../db/accounts.js'
import { backfillAll, backfillBrand, refreshAllRecent, coverage, rebuildRollup } from './extract.js'
import { refreshAllOutbound } from './outbound.js'
import { clearCache } from '../cache.js'

/**
 * Keeping the local copy current.
 *
 * Hourly, the last few days for every brand — nine queries, because that is all
 * that can still move. Overnight, the whole ninety-day window, one branch at a
 * time, to pick up anything restated further back and to extend the window as
 * the calendar rolls forward.
 *
 * The asymmetry is the whole point. An hourly re-pull of ninety days is a
 * hundred and seventeen queries an hour, which is the burst that makes the
 * capacity answer 429 with a sixty-second Retry-After — it would have caused
 * the problem this exists to solve.
 */

const HOUR = 3_600_000
const REFRESH_MINUTES = Number(process.env.CUBE_REFRESH_MINUTES) || 60
const BACKFILL_HOUR = Number(process.env.CUBE_BACKFILL_HOUR) ?? 2
const FIRST_RUN_MS = Number(process.env.CUBE_FIRST_RUN_MS) || 20_000

let running = false
let last = null
let lastError = null

/**
 * Whether the copy is being kept at all — a plain answer, not a promise.
 *
 * state() has to await the database to count what it holds, but the schedule
 * starts before anything is awaited and only wants this one flag. Reading it off
 * the promise returned `undefined`, which read as "disabled" and silently left
 * the copy never refreshing itself.
 */
const enabled = () => !config.demoMode && process.env.CUBE_ENABLED !== '0'

const state = async () => ({
  enabled: enabled(),
  running,
  last,
  lastError,
  brands: await coverage(),
  rows: (await pg.get('SELECT COUNT(*)::int AS n FROM cube_daily'))?.n ?? 0,
})

export { state as cubeState }

/** Never two extracts at once — they would fight over the same rows. */
async function guarded(label, run) {
  if (running) return null
  running = true
  const started = Date.now()
  try {
    const result = await run()
    await rebuildRollup()

    // Refresh the planner's statistics after the rows change.
    //
    // This is not housekeeping. Measured across nine brands, filtering to one
    // branch took 5ms with current statistics and 42ms without, and an index
    // created without them made the unfiltered view four times slower — SQLite
    // chose an index that skipped a sort by walking three times as many rows.
    try {
      await pg.exec('ANALYZE')
    } catch {
      // Statistics are an optimisation; a locked database is not worth failing
      // an extract over.
    }

    // Anything already answered from the old rows is now out of date.
    clearCache()
    lastError = null
    last = { label, at: Date.now(), seconds: Math.round((Date.now() - started) / 1000) }
    return result
  } catch (err) {
    lastError = err.message
    return null
  } finally {
    running = false
  }
}

export const refreshRecentAll = () => guarded('recent', refreshAllRecent)
export const runBackfill = () => guarded('backfill', () => backfillAll())

/**
 * Outbound, the article master and the constants.
 *
 * Runs after the forecast side rather than beside it: the constants are worked
 * out from rows the other tables hold, so they need those in place first.
 */
async function refreshOutboundAll() {
  const today = new Date()
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth()
  const day = (yy, mm, d) => new Date(Date.UTC(yy, mm, d)).toISOString().slice(0, 10)

  // A year back covers every window the pages offer; last whole month is what
  // the constants are measured over.
  const window = { from: day(y - 1, m, 1), to: day(y, m + 2, 0) }
  const last = { from: day(y, m - 1, 1), to: day(y, m, 0) }

  return refreshAllOutbound({
    ...window,
    month: last.from.slice(0, 7),
    lastFrom: last.from,
    lastTo: last.to,
  })
}

export const runOutbound = () => guarded('outbound', refreshOutboundAll)

/**
 * Brands with nothing stored yet, filled one at a time on startup.
 *
 * Without this a fresh install answers everything live until the first
 * overnight run, which is the slow behaviour the copy exists to replace.
 */
async function backfillMissing() {
  const have = new Set((await coverage()).map((c) => c.brand))
  const missing = config.brands.filter((b) => !have.has(b.code))
  if (!missing.length) return
  await guarded('initial backfill', async () => {
    for (const brand of missing) {
      try {
        await backfillBrand(brand)
        console.log(`  [cube] ${brand.code} backfilled`)
      } catch (err) {
        console.log(`  [cube] ${brand.code} failed: ${err.message.slice(0, 80)}`)
      }
    }
  })
}

/** Milliseconds until the next time the local clock passes `hour`. */
function untilHour(hour) {
  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

export function startCubeSchedule() {
  if (!enabled()) return false

  /*
   * A background job must never be able to take the site down.
   *
   * These run detached from any request, so a rejection here is nobody's to
   * catch and Node ends the process for it — which is how a fault in filling the
   * copy came to stop the server answering at all. Keeping stale figures is a
   * far better failure than serving none, so the error is recorded and the site
   * carries on reading live.
   */
  const detached = (label, run) => {
    Promise.resolve()
      .then(run)
      .catch((err) => {
        lastError = `${label}: ${err.message}`
        console.log(`  [cube] ${label} failed: ${err.message.slice(0, 120)}`)
      })
  }

  setTimeout(() => {
    detached('initial backfill', () =>
      backfillMissing()
        .then(() => refreshRecentAll())
        // Outbound last: the constants are derived from what the others hold.
        .then(() => runOutbound())
    )
    setInterval(() => detached('recent refresh', refreshRecentAll), REFRESH_MINUTES * 60_000).unref?.()
  }, FIRST_RUN_MS).unref?.()

  setTimeout(() => {
    detached('nightly backfill', () => runBackfill().then(() => runOutbound()))
    setInterval(
      () => detached('nightly backfill', () => runBackfill().then(() => runOutbound())),
      24 * HOUR
    ).unref?.()
  }, untilHour(BACKFILL_HOUR)).unref?.()

  return true
}
