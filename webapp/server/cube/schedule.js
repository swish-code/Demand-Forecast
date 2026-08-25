import { config } from '../config.js'
import { pg } from '../db/accounts.js'
import { backfillAll, backfillBrand, refreshAllRecent, coverage, rebuildRollup } from './extract.js'
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

const state = async () => ({
  enabled: !config.demoMode && process.env.CUBE_ENABLED !== '0',
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
 * Brands with nothing stored yet, filled one at a time on startup.
 *
 * Without this a fresh install answers everything live until the first
 * overnight run, which is the slow behaviour the copy exists to replace.
 */
async function backfillMissing() {
  const have = new Set(coverage().map((c) => c.brand))
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
  if (!state().enabled) return false

  setTimeout(() => {
    backfillMissing().then(() => refreshRecentAll())
    setInterval(refreshRecentAll, REFRESH_MINUTES * 60_000).unref?.()
  }, FIRST_RUN_MS).unref?.()

  setTimeout(() => {
    runBackfill()
    setInterval(runBackfill, 24 * HOUR).unref?.()
  }, untilHour(BACKFILL_HOUR)).unref?.()

  return true
}
