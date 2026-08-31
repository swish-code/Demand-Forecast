import { config } from '../config.js'
import { pg } from '../db/accounts.js'
import { loadCoverage } from './query.js'
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

/**
 * Rows go in a few hundred at a time, not one at a time.
 *
 * A round trip per row is the difference between a backfill that takes three
 * minutes and one that takes a quarter of an hour: measured here at about two
 * thousand rows a second row-by-row against nine and a half thousand batched.
 * Each batch is one INSERT with many VALUES tuples, which the driver sends as a
 * single statement.
 *
 * The batch size is bounded by PostgreSQL's limit of 65,535 bind parameters per
 * statement — six columns a row puts the ceiling near ten thousand rows, and
 * five hundred leaves plenty of room while still amortising the round trip.
 */
const BATCH = Number(process.env.CUBE_BATCH) || 500

async function insertBatched(table, columns, conflict, rows, toValues) {
  const marks = `(${columns.map(() => '?').join(', ')})`
  const updates = columns
    .filter((c) => !conflict.includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const args = []
    for (const row of slice) args.push(...toValues(row))
    await pg.run(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES ${slice.map(() => marks).join(', ')}
       ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${updates}`,
      args
    )
  }
}

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
async function clearScope(brand, { from, to, location }) {
  const sql = ['brand = ?']
  const args = [brand]
  if (from) { sql.push('date >= ?'); args.push(from) }
  if (to) { sql.push('date <= ?'); args.push(to) }
  if (location !== undefined && location !== null) { sql.push('location = ?'); args.push(String(location)) }
  await pg.run(`DELETE FROM cube_daily WHERE ${sql.join(' AND ')}`, args)
}

/**
 * One transaction per slice, so a half-written window is never visible and a
 * failure leaves the previous copy intact.
 */
async function writeRows(brand, rows, scope) {
  if (!rows.length && !scope) return
  await pg.tx(async () => {
    if (scope) await clearScope(brand, scope)
    await insertBatched(
      'cube_daily',
      ['brand', 'date', 'location', 'product', 'actual', 'forecast'],
      ['brand', 'date', 'location', 'product'],
      rows,
      (r) => [
        brand,
        String(r.Date ?? '').slice(0, 10),
        String(r.LocationID ?? ''),
        String(r.ProductName_Fixed_Option ?? ''),
        Number(r.Actual_Qty) || 0,
        Number(r.Forecast_Qty) || 0,
      ]
    )
  })
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

/*
 * The whole calendar, asked for a stretch at a time.
 *
 * Power BI does not refuse a query that returns too much — it answers 200 with
 * roughly half the rows and says nothing. A month of articles split by branch
 * and day came back reading 1,133,418 units against a true 1,228,977, and that
 * is the failure this guards against: a copy that is quietly missing half its
 * rows is worse than no copy at all, because every page reads it confidently.
 *
 * A year of articles for one brand is around a hundred and ninety thousand
 * rows, well past where truncation was seen, so these windows are cut up and
 * the pieces concatenated. The spans cover disjoint dates, so nothing can be
 * counted twice.
 */
const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function inSpans(window, days, run) {
  const out = []
  for (let start = window.from; start <= window.to; start = addDays(start, days)) {
    const end = addDays(start, days - 1)
    out.push(...(await run({ from: start, to: end > window.to ? window.to : end })))
    await sleep(GAP_MS)
  }
  return out
}

/**
 * Branch totals for the whole calendar, in one query per brand.
 *
 * No product column, so a year is a few thousand rows rather than two thirds of
 * a million. This is what the Overview's branch panel and its daily trend read.
 */
async function fetchLocationDaily(brand, window) {
  const filters = brandFilters(brand, { dateFrom: window.from, dateTo: window.to })
  return executeQuery(
    `EVALUATE
${dax.summarize({
      groupBy: ['Forecast_Product_Table[Date]', 'Forecast_Product_Table[LocationID]'],
      filters: dax.filterArgs(filters),
      measures: [dax.M.actualQty, dax.M.forecastQty],
    })}`,
    brand.datasetId,
    { bulk: true }
  )
}

/** Component requirement by day, for the Ingredients page. */
async function fetchComponents(brand, window) {
  const filters = brandFilters(brand, { dateFrom: window.from, dateTo: window.to })
  return executeQuery(
    `EVALUATE
FILTER(
  ${dax.summarize({
    groupBy: [
      'Forecast_Product_Table[Date]',
      "'RECIPE TABLE'[Recipe Group]",
      "'RECIPE TABLE'[Item]",
      "'RECIPE TABLE'[Item No.]",
      "'RECIPE TABLE'[BU]",
      "'RECIPE TABLE'[Node Type]",
    ],
    filters: dax.filterArgs(filters, { skip: ['products'] }),
    measures: [dax.M.componentForecast, dax.M.componentActual],
  })},
  NOT ISBLANK([Component_Forecast_Qty]) && [Component_Forecast_Qty] <> 0
)`,
    brand.datasetId,
    { bulk: true }
  )
}

async function writeLocationDaily(brand, rows, scope) {
  if (!rows.length && !scope) return
  await pg.tx(async () => {
    if (scope) {
      await pg.run('DELETE FROM cube_location_daily WHERE brand = ? AND date >= ? AND date <= ?', [
        brand,
        scope.from,
        scope.to,
      ])
    }
    await insertBatched(
      'cube_location_daily',
      ['brand', 'date', 'location', 'actual', 'forecast'],
      ['brand', 'date', 'location'],
      rows,
      (r) => [
        brand,
        String(r.Date ?? '').slice(0, 10),
        String(r.LocationID ?? ''),
        Number(r.Actual_Qty) || 0,
        Number(r.Forecast_Qty) || 0,
      ]
    )
  })
}

async function writeComponents(brand, rows, scope) {
  if (!rows.length && !scope) return
  await pg.tx(async () => {
    if (scope) {
      await pg.run('DELETE FROM cube_component_daily WHERE brand = ? AND date >= ? AND date <= ?', [
        brand,
        scope.from,
        scope.to,
      ])
    }
    await insertBatched(
      'cube_component_daily',
      ['brand', 'date', 'recipe', 'item', 'bu', 'node_type', 'article', 'actual', 'forecast'],
      ['brand', 'date', 'recipe', 'item', 'bu', 'node_type'],
      rows,
      (r) => [
        brand,
        String(r.Date ?? '').slice(0, 10),
        String(r['Recipe Group'] ?? ''),
        String(r.Item ?? ''),
        String(r.BU ?? ''),
        String(r['Node Type'] ?? ''),
        String(r['Item No.'] ?? '').trim(),
        Number(r.Component_Actual_Qty) || 0,
        Number(r.Component_Forecast_Qty) || 0,
      ]
    )
  })
}

/**
 * Rebuild a brand's monthly rollups from its daily rows.
 *
 * One statement each, computed from the table it summarises, so the two can
 * never disagree about a total. Whole brand rather than the touched window: a
 * month straddling the edge of a refresh would otherwise keep half its days.
 */
async function rebuildMonthly(brand) {
  await pg.run('DELETE FROM cube_article_monthly WHERE brand = ?', [brand])
  await pg.run(
    `INSERT INTO cube_article_monthly (brand, month, article, product, actual, forecast)
     SELECT brand, substr(date, 1, 7), article, product, SUM(actual), SUM(forecast)
       FROM cube_article_daily WHERE brand = ?
      GROUP BY brand, substr(date, 1, 7), article, product`,
    [brand]
  )

  await pg.run('DELETE FROM cube_component_monthly WHERE brand = ?', [brand])
  await pg.run(
    `INSERT INTO cube_component_monthly (brand, month, recipe, item, bu, node_type, article, actual, forecast)
     SELECT brand, substr(date, 1, 7), recipe, item, bu, node_type, MAX(article), SUM(actual), SUM(forecast)
       FROM cube_component_daily WHERE brand = ?
      GROUP BY brand, substr(date, 1, 7), recipe, item, bu, node_type`,
    [brand]
  )
}

async function writeArticles(brand, rows, scope) {
  if (!rows.length && !scope) return
  await pg.tx(async () => {
    if (scope) {
      const sql = ['brand = ?']
      const args = [brand]
      if (scope.from) { sql.push('date >= ?'); args.push(scope.from) }
      if (scope.to) { sql.push('date <= ?'); args.push(scope.to) }
      await pg.run(`DELETE FROM cube_article_daily WHERE ${sql.join(' AND ')}`, args)
    }
    await insertBatched(
      'cube_article_daily',
      ['brand', 'date', 'article', 'product', 'actual', 'forecast'],
      ['brand', 'date', 'article', 'product'],
      rows,
      (r) => [
        brand,
        String(r.Date ?? '').slice(0, 10),
        String(r.Clean_ItemID ?? ''),
        String(r.ProductName_Fixed_Option ?? ''),
        Number(r.Actual_Qty) || 0,
        Number(r.Forecast_Qty) || 0,
      ]
    )
  })
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

/**
 * Record what the copy holds, measured from the copy.
 *
 * This used to record the window an extract had asked for, and widened it with
 * LEAST and GREATEST so it could only ever grow. Both were wrong in the same
 * direction: a brand whose full backfill never finished, or whose rows were
 * replaced by a four-day refresh, went on claiming months it did not have. The
 * pages believed the claim, asked for thirty days, and drew the four that
 * existed — a chart that is not wrong about any point on it and is wrong about
 * the period it says it covers, which is worse.
 *
 * So every range here is a MIN and MAX over the table that serves it. If a
 * table is empty its range is null, canAnswer refuses, and the request goes to
 * Power BI — slower, and right.
 *
 * The wide range is the overlap of the two tables the wide pages read, not
 * their union: a date the branch rollup has and the article table does not is
 * not a date this copy can answer questions about.
 */
async function noteCoverage(brand, _from, _to, detail = null, model = null) {
  const spanOf = async (table) =>
    (await pg.get(
      `SELECT MIN(date) AS lo, MAX(date) AS hi, COUNT(*)::int AS n FROM ${table} WHERE brand = ?`,
      [brand.code]
    )) ?? { lo: null, hi: null, n: 0 }

  const daily = await spanOf('cube_daily')
  const branches = await spanOf('cube_location_daily')
  const articles = await spanOf('cube_article_daily')
  const components = await spanOf('cube_component_daily')

  // The overlap, and null the moment either side has nothing.
  const wideFrom =
    branches.lo && articles.lo ? (branches.lo > articles.lo ? branches.lo : articles.lo) : null
  const wideTo = branches.hi && articles.hi ? (branches.hi < articles.hi ? branches.hi : articles.hi) : null

  await pg.run(
    `INSERT INTO cube_coverage
       (brand, from_date, to_date, rows, refreshed_at, detail_from, detail_to,
        components, model_from, model_to, comp_from, comp_to)
     VALUES (?, ?, ?, ?, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (brand) DO UPDATE SET
       from_date = excluded.from_date,
       to_date = excluded.to_date,
       rows = excluded.rows,
       refreshed_at = excluded.refreshed_at,
       detail_from = excluded.detail_from,
       detail_to = excluded.detail_to,
       components = excluded.components,
       comp_from = excluded.comp_from,
       comp_to = excluded.comp_to,
       model_from = COALESCE(excluded.model_from, cube_coverage.model_from),
       model_to = COALESCE(excluded.model_to, cube_coverage.model_to)`,
    [
      brand.code,
      wideFrom,
      wideTo,
      daily.n,
      daily.lo,
      daily.hi,
      components.n,
      model?.from ?? null,
      model?.to ?? null,
      components.lo,
      components.hi,
    ]
  )
  await loadCoverage()
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

  /*
   * Two windows.
   *
   * `detail` is the branch-by-product window: the cross product of those two is
   * what makes the copy big, so it stays a few months either side of today.
   *
   * `wide` is the whole model calendar, and it is what the tables without a
   * branch column carry. Those are small enough to hold the lot, and holding
   * the lot is the difference between "All dates" answering from disk and it
   * fanning out fifty queries to Power BI — which is the one date range in the
   * picker that was still slow.
   */
  const detailTo = iso(Math.min(Date.parse(anchor) + AHEAD_DAYS * DAY, Date.parse(max) || Infinity))
  const detailFrom = iso(Math.max(Date.parse(anchor) - (WINDOW_DAYS - 1) * DAY, Date.parse(min) || 0))

  // `anchor` travels with the window because the hourly refresh needs to know
  // where "now" is, not just where the window ends.
  return {
    from: detailFrom,
    to: detailTo,
    anchor,
    wide: { from: min || detailFrom, to: max || detailTo },
  }
}

/** The full window for one brand, one branch per query. */
/** Recompute one brand's coverage from the tables. Exposed so it can be tested. */
export const noteCoverageForTest = (brand) => noteCoverage(brand, null, null)

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
    await writeRows(brand.code, slice, { from: window.from, to: window.to, location })
    rows += slice.length
    onStep?.(brand.code, location, slice.length)
    await sleep(GAP_MS)
  }

  /*
   * The wide tables: the whole calendar, one query each.
   *
   * Each is tried on its own and a failure is swallowed, because these are
   * independent answers. Losing the recipe copy should not also cost the
   * Products page its year of articles — whichever one failed falls back to
   * Power BI and the others keep working.
   */
  /*
   * The span sizes are set by how many rows each grain produces, measured
   * against this model: articles run about five hundred a day per brand, so a
   * month is roughly sixteen thousand rows; components a few hundred a day, so
   * a quarter is about fourteen thousand; branch totals sixteen a day, which is
   * six thousand for the entire year and needs no splitting at all.
   */
  const wide = window.wide
  for (const [what, run] of [
    ['articles', async () =>
      writeArticles(brand.code, await inSpans(wide, 30, (w) => fetchArticles(brand, w)), wide)],
    ['branches', async () =>
      writeLocationDaily(brand.code, await fetchLocationDaily(brand, wide), wide)],
    ['components', async () =>
      writeComponents(brand.code, await inSpans(wide, 90, (w) => fetchComponents(brand, w)), wide)],
  ]) {
    try {
      await run()
      await sleep(GAP_MS)
    } catch (err) {
      console.log(`  [cube] ${brand.code} ${what} failed: ${err.message.slice(0, 80)}`)
    }
  }

  await rebuildMonthly(brand.code)

  await noteCoverage(brand, window.wide.from, window.wide.to, { from: window.from, to: window.to }, window.wide)
  return { brand: brand.code, rows, from: window.wide.from, to: window.wide.to, branches: locations.length }
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
  await writeRows(brand.code, slice, { from, to })

  // The recent days in every table that holds them, so a page reading from the
  // copy sees the same freshness whichever one it happens to read.
  const recent = { from, to }
  for (const [what, run] of [
    ['articles', async () => writeArticles(brand.code, await fetchArticles(brand, recent), recent)],
    ['branches', async () => writeLocationDaily(brand.code, await fetchLocationDaily(brand, recent), recent)],
    ['components', async () => writeComponents(brand.code, await fetchComponents(brand, recent), recent)],
  ]) {
    try {
      await run()
    } catch {
      /* that one page stays live for this brand until the next run */
    }
  }

  await rebuildMonthly(brand.code)

  // No detail window passed: a refresh does not change how far back the
  // branch-by-product table reaches, only how fresh its recent end is.
  await noteCoverage(brand, from, to)
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
export async function rebuildRollup() {
  await pg.tx(async () => {
    await pg.run('DELETE FROM cube_product_daily')
    await pg.run(`INSERT INTO cube_product_daily (brand, date, product, actual, forecast)
                  SELECT brand, date, product, SUM(actual), SUM(forecast)
                    FROM cube_daily GROUP BY brand, date, product`)
  })
}

export function coverage() {
  return pg.all('SELECT * FROM cube_coverage ORDER BY brand')
}
