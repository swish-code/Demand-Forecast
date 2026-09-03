import { config } from '../config.js'
import { pg } from '../db/accounts.js'
import { backfillAll, backfillBrand, backfillWide, refreshAllPlans, refreshAllRecent, coverage, rebuildRollup, vacuum } from './extract.js'
import { refreshAllOutbound } from './outbound.js'
import { clearCache } from '../cache.js'
import { loadCoverage } from './query.js'
import { raise, clear } from '../insights/alerts.js'

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
    // ANALYZE here, VACUUM overnight.
    //
    // The copy is PostgreSQL compiled to WebAssembly running inside this
    // process, so anything it does blocks the event loop and the server answers
    // nothing while it runs. Vacuuming twelve tables of a two-gigabyte database
    // after every extract was minutes of that, on a schedule that fires hourly
    // and on every restart. Statistics are what the planner actually needs and
    // they cost a fraction of it; reclaiming space is real but it is not urgent,
    // and the nightly run already does it properly.
    try {
      await pg.exec('ANALYZE')
    } catch {
      // Statistics are an optimisation, not something to fail an extract over.
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

/*
 * The recent days and tomorrow's plan, in one pass.
 *
 * Folded together rather than chained because every guarded run rebuilds the
 * product rollup and vacuums afterwards, and the plan refresh touches neither
 * of the tables that work exists for — two passes an hour would rebuild 1.5
 * million rows for nothing.
 */
export const refreshRecentAll = () =>
  guarded('recent', async () => {
    const out = await refreshAllRecent()
    await refreshAllPlans()
    return out
  })
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
 * How long an outbound copy stays good enough to skip re-pulling at startup.
 *
 * A restart used to re-fetch a year of warehouse movement whatever had happened
 * five minutes earlier — twelve heavy queries and a rewrite of the whole table,
 * during which the copy is locked and the server answers nothing. It changes
 * once a day at most. Anything fresher than this is left alone; the hourly
 * schedule brings it forward soon enough either way.
 */
const OUTBOUND_FRESH_HOURS = Number(process.env.CUBE_OUTBOUND_FRESH_HOURS) || 6

async function outboundIsFresh() {
  const rows = await coverage()
  if (!rows.length) return false
  const stamps = rows.map((r) => r.refreshed_at).filter(Boolean)
  if (stamps.length !== rows.length) return false
  const newest = Date.parse(`${stamps.sort().pop().replace(' ', 'T')}Z`)
  if (!Number.isFinite(newest)) return false
  return Date.now() - newest < OUTBOUND_FRESH_HOURS * HOUR
}

/** The startup pull, skipped when the copy is already current. */
async function outboundIfStale() {
  if (await outboundIsFresh().catch(() => false)) {
    console.log('  [cube] outbound is recent — not re-pulling it on startup')
    return null
  }
  return runOutbound()
}

/** Tomorrow's plan, alongside the hourly refresh that keeps the rest current. */
export const runPlans = () => guarded('plans', refreshAllPlans)

/**
 * The shortest window a brand's copy has to cover to be worth having.
 *
 * The pages open on the last thirty days and the date picker offers ninety, so
 * a copy holding less than ninety is a copy the dashboard will refuse for most
 * of what people ask it — and refusing means Power BI, per brand, per request.
 */
const MIN_WIDE_DAYS = Number(process.env.CUBE_MIN_WIDE_DAYS) || 90

const DAY_MS = 86_400_000
const spanDays = (from, to) =>
  from && to ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1 : 0

/**
 * Why this brand's copy cannot be trusted with a normal question, or null.
 *
 * Having a coverage row is not the same as being backfilled, and treating the
 * two as equivalent is what let this sit unnoticed. The hourly refresh writes a
 * coverage row for every brand whether or not the wide tables were ever filled,
 * so a copy holding eight days looked, to the startup check, exactly like one
 * holding a year — and the only thing that would have repaired it was the 02:00
 * backfill, which a process that restarts more often than daily never reaches.
 *
 * Measured on 1 Sep 2026: all nine brands held eight days of the branch rollup
 * and eight of the recipe copy against a thirty-day window, so every page for
 * every brand was served from Power BI. The copy could answer the same nine
 * brands in about two hundred milliseconds.
 */
function thinness(cover) {
  if (!cover) return 'nothing stored'
  const wide = spanDays(cover.from_date, cover.to_date)
  if (wide < MIN_WIDE_DAYS) return `branch and article tables hold ${wide} days`
  const comp = spanDays(cover.comp_from, cover.comp_to)
  if (comp < MIN_WIDE_DAYS) return `recipe copy holds ${comp} days`
  return null
}

/**
 * Brands whose copy cannot answer, filled one at a time on startup.
 *
 * A brand with nothing stored gets the full backfill, one branch at a time. A
 * brand that has rows but thin wide tables gets only those three tables — about
 * seventeen queries rather than one per branch on top — because the expensive
 * per-branch table is not the one that goes short.
 */
async function backfillThin() {
  const have = new Map((await coverage()).map((c) => [c.brand, c]))
  const work = []
  for (const brand of config.brands) {
    const cover = have.get(brand.code)
    const why = thinness(cover)
    if (why) work.push({ brand, cover, why })
  }
  if (!work.length) return

  for (const { brand, why } of work) console.log(`  [cube] ${brand.code} needs filling: ${why}`)

  await guarded('initial backfill', async () => {
    for (const { brand, cover } of work) {
      try {
        // No coverage row at all means no rows anywhere, so the per-branch table
        // has to be built too. Otherwise only the wide tables are short.
        if (cover) await backfillWide(brand)
        else await backfillBrand(brand)
        console.log(`  [cube] ${brand.code} filled`)
      } catch (err) {
        console.log(`  [cube] ${brand.code} failed: ${err.message.slice(0, 80)}`)
      }
    }
  })

  // The gate reads this cache, and it was loaded before any of that ran.
  await loadCoverage()

  // Say plainly whether it worked, because "the dashboard is slow" is what this
  // looks like from the outside and nothing else in the log names the cause.
  const after = new Map((await coverage()).map((c) => [c.brand, c]))
  const stillThin = config.brands.filter((b) => thinness(after.get(b.code)))
  if (stillThin.length) {
    raise({
      source: 'cube',
      key: 'cube:thin',
      severity: 'warning',
      title: `${stillThin.length} brand${stillThin.length === 1 ? '' : 's'} answering from Power BI rather than the copy`,
      detail: [
        ...stillThin.map((b) => `${b.code}: ${thinness(after.get(b.code))}`),
        '',
        'Every page for these brands is fetched live on every request, which is',
        'the slowness people notice with several brands selected.',
      ].join('\n'),
    })
  } else {
    clear('cube:thin')
  }
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
      backfillThin()
        .then(() => refreshRecentAll())
        // Outbound last: the constants are derived from what the others hold.
        .then(() => outboundIfStale())
    )
    setInterval(
      () => detached('recent refresh', refreshRecentAll),
      REFRESH_MINUTES * 60_000
    ).unref?.()
  }, FIRST_RUN_MS).unref?.()

  setTimeout(() => {
    // VACUUM FULL only overnight: it rewrites each table under an exclusive
    // lock — half a minute for cube_daily — which is fine at two in the morning
    // and not fine while somebody is reading a page.
    const nightly = () =>
      runBackfill()
        .then(() => runOutbound())
        .then(() => vacuum({ full: true }))
    detached('nightly backfill', nightly)
    setInterval(() => detached('nightly backfill', nightly), 24 * HOUR).unref?.()
  }, untilHour(BACKFILL_HOUR)).unref?.()

  return true
}
