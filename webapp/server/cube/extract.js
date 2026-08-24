import { config } from '../config.js'
import { db } from '../db/index.js'
import { executeQuery } from '../powerbi/client.js'
import * as dax from '../powerbi/dax.js'

/**
 * Filling the local copy of the forecast.
 *
 * Two passes, deliberately different sizes:
 *
 *   backfill    the whole window, one branch at a time. Ninety days of every
 *               product for one branch is a few thousand rows, which the query
 *               API returns comfortably; ninety days of every branch at once is
 *               not. Runs overnight.
 *
 *   recent      the last few days only, every branch in one query per brand.
 *               Yesterday's actuals settle, but today's are still arriving and
 *               a late voucher can move a day that has already been extracted.
 *               Runs hourly, and costs nine queries rather than a hundred.
 *
 * The split matters. Re-pulling ninety days every hour is the same burst that
 * makes the capacity answer 429 with a sixty-second Retry-After, so it would
 * have made the problem it exists to solve worse.
 */

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const WINDOW_DAYS = Number(process.env.CUBE_DAYS) || 90
export const RECENT_DAYS = Number(process.env.CUBE_RECENT_DAYS) || 4
const GAP_MS = Number(process.env.CUBE_GAP_MS) || 2_000

const upsertArticle = db.prepare(
  `INSERT INTO cube_article_daily (brand, date, article, product, actual, forecast)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(brand, date, article, product)
   DO UPDATE SET actual = excluded.actual, forecast = excluded.forecast`
)

const upsert = db.prepare(
  `INSERT INTO cube_daily (brand, date, location, product, actual, forecast)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(brand, date, location, product)
   DO UPDATE SET actual = excluded.actual, forecast = excluded.forecast`
)

/**
 * Replace everything in the slice's scope, rather than only overwriting what
 * came back.
 *
 * Upserting alone leaves orphans. When the model restates a day — a product
 * that had sales no longer does, a name changes — the old row stays and is
 * counted alongside the new one. BBT's 22 August held 1,588 rows against the
 * 1,562 the query returned, and read 42,305 units where Power BI said 39,739.
 *
 * Deleting the scope first makes each extract authoritative for the range it
 * covers, which is the only way a copy can stay equal to its source.
 */
function clearScope(brand, { from, to, location }) {
  const sql = ['brand = ?']
  const args = [brand]
  if (from) { sql.push('date >= ?'); args.push(from) }
  if (to) { sql.push('date <= ?'); args.push(to) }
  if (location !== undefined && location !== null) { sql.push('location = ?'); args.push(String(location)) }
  db.prepare(`DELETE FROM cube_daily WHERE ${sql.join(' AND ')}`).run(...args)
}

/**
 * One transaction per slice. Row by row outside a transaction is a disk sync
 * each time, which turns twenty thousand rows into minutes instead of
 * milliseconds. node:sqlite has no transaction() helper, so this is explicit.
 */
function writeRows(brand, rows, scope) {
  if (!rows.length && !scope) return
  db.exec('BEGIN')
  try {
    if (scope) clearScope(brand, scope)
    for (const r of rows) {
      upsert.run(
        brand,
        String(r.Date ?? '').slice(0, 10),
        String(r.LocationID ?? ''),
        String(r.ProductName_Fixed_Option ?? ''),
        Number(r.Actual_Qty) || 0,
        Number(r.Forecast_Qty) || 0
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * One slice of the cube.
 *
 * Built through the same dax helpers the live pages use, so the report-level
 * filters — the hidden "SM" exclusion, and the chain pin for the two models
 * that hold two brands each — are applied identically. A copy that filtered
 * differently would disagree with Power BI, which is the one thing it must
 * never do.
 */
async function fetchSlice(brand, filters) {
  const query = `EVALUATE
${dax.summarize({
    groupBy: [
      'Forecast_Product_Table[Date]',
      'Forecast_Product_Table[LocationID]',
      'Forecast_Product_Table[ProductName_Fixed_Option]',
    ],
    filters: dax.filterArgs(filters),
    measures: [dax.M.actualQty, dax.M.forecastQty],
  })}`
  return executeQuery(query, brand.datasetId, { bulk: true })
}

/**
 * The same window at article grain, for the Products page.
 *
 * One query per brand, because dropping the branch column takes it from four
 * hundred thousand rows to thirty-seven thousand.
 */
async function fetchArticles(brand, window) {
  const filters = brandFilters(brand, { dateFrom: window.from, dateTo: window.to })
  const query = `EVALUATE
${dax.summarize({
    groupBy: [
      'Forecast_Product_Table[Date]',
      'Forecast_Product_Table[Clean_ItemID]',
      'Forecast_Product_Table[ProductName_Fixed_Option]',
    ],
    filters: dax.filterArgs(filters),
    measures: [dax.M.actualQty, dax.M.forecastQty],
  })}`
  return executeQuery(query, brand.datasetId, { bulk: true })
}

function writeArticles(brand, rows, scope) {
  if (!rows.length && !scope) return
  db.exec('BEGIN')
  try {
    if (scope) {
      const sql = ['brand = ?']
      const args = [brand]
      if (scope.from) { sql.push('date >= ?'); args.push(scope.from) }
      if (scope.to) { sql.push('date <= ?'); args.push(scope.to) }
      db.prepare(`DELETE FROM cube_article_daily WHERE ${sql.join(' AND ')}`).run(...args)
    }
    for (const r of rows) {
      upsertArticle.run(
        brand,
        String(r.Date ?? '').slice(0, 10),
        String(r.Clean_ItemID ?? ''),
        String(r.ProductName_Fixed_Option ?? ''),
        Number(r.Actual_Qty) || 0,
        Number(r.Forecast_Qty) || 0
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

const brandFilters = (brand, extra = {}) => ({
  brand: brand.code,
  ...(brand.chain ? { brands: [brand.chain] } : {}),
  ...extra,
})

/** Every branch this brand has, so the backfill can go one at a time. */
async function locationsOf(brand) {
  const rows = await executeQuery(
    dax.slicerQuery.locations(brandFilters(brand)),
    brand.datasetId
  )
  return rows.map((r) => r.LocationID).filter((v) => v !== null && v !== undefined)
}

function noteCoverage(brand, from, to) {
  const rows = db
    .prepare('SELECT COUNT(*) AS n FROM cube_daily WHERE brand = ?')
    .get(brand.code).n
  db.prepare(
    `INSERT INTO cube_coverage (brand, from_date, to_date, rows, refreshed_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(brand) DO UPDATE SET
       from_date = MIN(excluded.from_date, cube_coverage.from_date),
       to_date = MAX(excluded.to_date, cube_coverage.to_date),
       rows = excluded.rows,
       refreshed_at = excluded.refreshed_at`
  ).run(brand.code, from, to, rows)
}

/**
 * The window the copy should hold.
 *
 * Anchored to today, not to the end of the calendar. DateTable runs to the end
 * of the year, so taking its maximum extracted ninety days of pure forecast
 * with no actuals in it at all — every figure on the page would have been zero
 * against a forecast, and matched Power BI perfectly while doing it.
 *
 * Forward far enough to cover the "Next 30 days" preset, because the forecast
 * for those days already exists and that preset is the one a production
 * planner actually reaches for. Three days ahead left it falling back to Power
 * BI for exactly that view.
 */
const AHEAD_DAYS = Number(process.env.CUBE_AHEAD_DAYS) || 35

async function windowFor(brand) {
  const rows = await executeQuery(dax.slicerQuery.dateRange(), brand.datasetId)
  const r = rows[0] ?? {}
  const pick = (...names) => {
    for (const n of names) {
      const v = r[n] ?? r[`[${n}]`]
      if (v) return String(v).slice(0, 10)
    }
    return ''
  }
  const today = pick('Today')
  const max = pick('MaxDate')
  const min = pick('MinDate')
  const anchor = today || max
  if (!anchor) return null

  const to = iso(Math.min(Date.parse(anchor) + AHEAD_DAYS * DAY, Date.parse(max) || Infinity))
  const from = iso(Math.max(Date.parse(anchor) - (WINDOW_DAYS - 1) * DAY, Date.parse(min) || 0))
  // `anchor` travels with the window because the hourly refresh needs to know
  // where "now" is, not just where the window ends.
  return { from, to, anchor }
}

/** The full window for one brand, one branch per query. */
export async function backfillBrand(brand, onStep) {
  const window = await windowFor(brand)
  if (!window) return { brand: brand.code, rows: 0, skipped: 'no calendar' }
  await sleep(GAP_MS)

  const locations = await locationsOf(brand)
  await sleep(GAP_MS)

  let rows = 0
  for (const location of locations) {
    const slice = await fetchSlice(
      brand,
      brandFilters(brand, { dateFrom: window.from, dateTo: window.to, locations: [location] })
    )
    writeRows(brand.code, slice, { from: window.from, to: window.to, location })
    rows += slice.length
    onStep?.(brand.code, location, slice.length)
    await sleep(GAP_MS)
  }

  try {
    writeArticles(brand.code, await fetchArticles(brand, window), { from: window.from, to: window.to })
  } catch {
    // The Products page falls back to Power BI without this; the Overview does
    // not depend on it, so one failure here should not lose the whole brand.
  }

  noteCoverage(brand, window.from, window.to)
  return { brand: brand.code, rows, from: window.from, to: window.to, branches: locations.length }
}

/** The last few days for one brand, every branch in a single query. */
export async function refreshRecent(brand) {
  const window = await windowFor(brand)
  if (!window) return { brand: brand.code, rows: 0 }

  /*
   * Anchored on today, not on the end of the window.
   *
   * This used to count back from window.to, which since the window was extended
   * to reach thirty-five days ahead meant it re-pulled late September every
   * hour — pure forecast, nothing that can change — and never went near the
   * days where actuals were actually landing. Yesterday stayed at zero all day.
   *
   * A few days back because a late voucher moves a day already extracted, and
   * one day forward because tomorrow's forecast is what the prep pages read.
   */
  const from = iso(Math.max(Date.parse(window.anchor) - (RECENT_DAYS - 1) * DAY, Date.parse(window.from)))
  const to = iso(Math.min(Date.parse(window.anchor) + DAY, Date.parse(window.to)))

  const slice = await fetchSlice(brand, brandFilters(brand, { dateFrom: from, dateTo: to }))
  writeRows(brand.code, slice, { from, to })

  try {
    writeArticles(brand.code, await fetchArticles(brand, { from, to }), { from, to })
  } catch {
    /* as above - the Products page simply stays live for this brand */
  }

  noteCoverage(brand, from, to)
  return { brand: brand.code, rows: slice.length, from, to }
}

export async function backfillAll(onStep) {
  const out = []
  for (const brand of config.brands) {
    try {
      out.push(await backfillBrand(brand, onStep))
    } catch (err) {
      out.push({ brand: brand.code, error: err.message })
    }
  }
  return out
}

export async function refreshAllRecent() {
  const out = []
  for (const brand of config.brands) {
    try {
      out.push(await refreshRecent(brand))
    } catch (err) {
      out.push({ brand: brand.code, error: err.message })
    }
    await sleep(GAP_MS)
  }
  return out
}

/**
 * Rebuild the branch-free rollup from the rows we already hold.
 *
 * Local only — no queries against Power BI — so it is cheap enough to redo in
 * full rather than track which brands changed.
 */
export function rebuildRollup() {
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM cube_product_daily')
    db.exec(`INSERT INTO cube_product_daily (brand, date, product, actual, forecast)
             SELECT brand, date, product, SUM(actual), SUM(forecast)
               FROM cube_daily
              GROUP BY brand, date, product`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function coverage() {
  return db.prepare('SELECT * FROM cube_coverage ORDER BY brand').all()
}
