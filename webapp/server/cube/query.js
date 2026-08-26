import { pg } from '../db/accounts.js'

/**
 * Answering the Overview page from the local copy.
 *
 * Same three shapes the live provider returns — trend by day, totals by branch,
 * totals by product — so the route cannot tell where the rows came from. Any
 * combination of branch, product and date range is a WHERE clause here rather
 * than another round trip to a capacity that throttles.
 */

/** Only what the cube actually holds. Anything else has to go to Power BI. */
const SUPPORTED = new Set(['brand', 'brands', 'locations', 'products', 'dateFrom', 'dateTo'])

/**
 * Keys that travel with a request but do not select any rows.
 *
 * These have to be listed. The client sends defaultFrom and defaultTo on every
 * request so the Reset button knows what to go back to, and an allowlist that
 * had never heard of them refused every real request from the browser — the
 * copy answered every test and nothing at all in the actual application.
 */
const HARMLESS = new Set(['defaultFrom', 'defaultTo', 'need', 'top'])

/**
 * Can the copy answer this request truthfully?
 *
 * Two ways it cannot, and both matter more than being fast: a filter the cube
 * has no column for (article, recipe group, prep status) would be silently
 * ignored and return too much, and a window reaching outside what has been
 * extracted would return too little. Either is worse than waiting.
 */
/**
 * What the copy covers, held in memory.
 *
 * canAnswer() is asked before nearly every read, inside conditionals that are
 * not async — `cube.canAnswer(...) ? cube.trend(...) : provider.trend(...)`.
 * Making it a database round trip would have meant rewriting that shape
 * everywhere to answer a question that changes only when the extract finishes,
 * which is once an hour.
 *
 * Seeded at boot and refreshed by the extract; a stale entry can only make the
 * copy look less capable than it is, never more.
 */
const coverageCache = new Map()

export async function loadCoverage() {
  const rows = await pg.all('SELECT * FROM cube_coverage')
  coverageCache.clear()
  for (const r of rows) coverageCache.set(r.brand, r)
  return coverageCache.size
}

export function canAnswer(brand, filters = {}) {
  for (const key of Object.keys(filters)) {
    const v = filters[key]
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue
    if (HARMLESS.has(key)) continue
    if (!SUPPORTED.has(key)) return false
  }

  const cover = coverageCache.get(brand)
  if (!cover) return false
  if (filters.dateFrom && filters.dateFrom < cover.from_date) return false
  if (filters.dateTo && filters.dateTo > cover.to_date) return false
  // A request with no window at all could mean anything; let it go live.
  return Boolean(filters.dateFrom && filters.dateTo)
}

/** WHERE fragment and bindings for one brand's slice. */
function where(brand, f = {}) {
  const sql = ['brand = ?']
  const args = [brand]

  if (f.dateFrom) {
    sql.push('date >= ?')
    args.push(f.dateFrom)
  }
  if (f.dateTo) {
    sql.push('date <= ?')
    args.push(f.dateTo)
  }
  for (const [column, values] of [
    ['location', f.locations],
    ['product', f.products],
  ]) {
    if (values?.length) {
      sql.push(`${column} IN (${values.map(() => '?').join(', ')})`)
      args.push(...values.map(String))
    }
  }
  return { sql: sql.join(' AND '), args }
}

const rowsOf = (sql, args) => pg.all(sql, args)

/**
 * The rollup is an optimisation, not a source of truth.
 *
 * cube_product_daily is cube_daily summed across branches, rebuilt after each
 * extract. Between a brand's rows landing and that rebuild running it is empty,
 * and reading it alone made a covered brand report zero — a wrong answer given
 * confidently, which is worse than a slow one. So an empty result falls back to
 * the table the rows actually live in.
 */
async function fromRollupOr(daily, sqlFor, args) {
  const rows = await rowsOf(sqlFor(daily), args)
  if (rows.length || daily === 'cube_daily') return rows
  return rowsOf(sqlFor('cube_daily'), args)
}

export async function trend(brand, f) {
  // Same reasoning as topProducts: a daily total does not need the branch
  // column unless a branch filter is applied.
  const table = f.locations?.length ? 'cube_daily' : 'cube_product_daily'
  const w = where(brand, f)
  return fromRollupOr(
    table,
    (t) => `SELECT date AS "Date",
            SUM(actual)   AS "Actual_Qty",
            SUM(forecast) AS "Forecast_Qty"
       FROM ${t}
      WHERE ${w.sql}
      GROUP BY date
      ORDER BY date ASC`,
    w.args
  )
}

export async function byLocation(brand, f) {
  const w = where(brand, f)
  return rowsOf(
    `SELECT location AS "LocationID",
            SUM(actual)   AS "Actual_Qty",
            SUM(forecast) AS "Forecast_Qty"
       FROM cube_daily
      WHERE ${w.sql}
      GROUP BY location
      ORDER BY SUM(actual) DESC`,
    w.args
  )
}

export async function topProducts(brand, f, top = 0) {
  // Without a branch filter the branch-free rollup has the same answer over a
  // seventh of the rows. With one, it does not have the column to filter on.
  const table = f.locations?.length ? 'cube_daily' : 'cube_product_daily'
  const w = where(brand, f)
  const limit = Number(top) > 0 ? ` LIMIT ${Math.floor(Number(top))}` : ''
  return fromRollupOr(
    table,
    (t) => `SELECT product AS "ProductName_Fixed_Option",
            SUM(actual)   AS "Actual_Qty",
            SUM(forecast) AS "Forecast_Qty"
       FROM ${t}
      WHERE ${w.sql}
      GROUP BY product
      ORDER BY SUM(actual) DESC${limit}`,
    w.args
  )
}

/**
 * Article-grain rows for the Products page.
 *
 * cube_article_daily has no branch column, so this only answers when no branch
 * filter is applied — canAnswerArticles enforces that rather than leaving it to
 * the caller to remember.
 */
/* ------------------------------------------------------- slicer lists --- */

/**
 * The values a slicer offers, from the local copy.
 *
 * These were the slowest thing in the application and nobody noticed, because
 * the cost only appears with several brands selected: one DAX query per list
 * per brand, so six lists across nine brands is fifty-four queries and about
 * four and a half seconds before a dropdown opens.
 *
 * Three of those lists are columns the copy already holds. Answering them here
 * leaves only the recipe-side lists to fetch, and those belong to a model the
 * copy does not mirror.
 *
 * The same filters apply as anywhere else, so the lists still cross-filter each
 * other: narrowing to one branch narrows the product list to what that branch
 * sells, exactly as the live query does.
 */
export async function locations(brand, f) {
  const { sql, args } = where(brand, { ...f, locations: null })
  return rowsOf(
    `SELECT DISTINCT location AS v FROM cube_daily WHERE ${sql} AND location <> '' ORDER BY location`,
    args
  ).map((r) => r.v)
}

export async function products(brand, f) {
  const { sql, args } = where(brand, { ...f, products: null })
  return rowsOf(
    `SELECT DISTINCT product AS v FROM cube_daily WHERE ${sql} AND product <> '' ORDER BY product`,
    args
  ).map((r) => r.v)
}

/**
 * Articles, with the product they belong to.
 *
 * Only when no branch is chosen: the article table is kept without a location
 * column, because carrying one would make it four hundred thousand rows a brand
 * rather than thirty-seven thousand. A branch-filtered article list therefore
 * has to go live, and says so by refusing here.
 */
export async function articleNames(brand, f) {
  if (f?.locations?.length) return null
  const { sql, args } = where(brand, { ...f, locations: null, products: null })
  const scoped = sql.replace(/location/g, 'article')
  return rowsOf(
    `SELECT DISTINCT article AS v, product AS p FROM cube_article_daily WHERE ${scoped} AND article <> ''
      ORDER BY article`,
    args
  ).map((r) => ({ value: r.v, label: String(r.v), hint: r.p || '' }))
}

/** Which of the asked-for lists this copy can answer for that brand. */
export async function listsFor(brand, f, need) {
  if (!canAnswer(brand, f)) return {}
  const out = {}
  for (const key of need ?? []) {
    if (key === 'locations') out.locations = await locations(brand, f)
    if (key === 'products') out.products = await products(brand, f)
    if (key === 'articleNames' || key === 'articles') {
      const rows = await articleNames(brand, f)
      if (!rows) continue
      out.articleNames = rows
      out.articles = rows.map((r) => r.value)
    }
  }
  return out
}

export function canAnswerArticles(brand, filters = {}) {
  if (filters.locations?.length) return false
  if (!canAnswer(brand, filters)) return false
  // Whether the article table has anything for this brand is part of what the
  // extract records, so it comes from the same cached coverage rather than a
  // count on every request.
  return Number(coverageCache.get(brand)?.rows ?? 0) > 0
}

export async function productLevel(brand, f) {
  const sql = ['brand = ?']
  const args = [brand]
  if (f.dateFrom) { sql.push('date >= ?'); args.push(f.dateFrom) }
  if (f.dateTo) { sql.push('date <= ?'); args.push(f.dateTo) }
  if (f.products?.length) {
    sql.push(`product IN (${f.products.map(() => '?').join(', ')})`)
    args.push(...f.products.map(String))
  }

  return pg.all(
    `SELECT article  AS "Clean_ItemID",
            ?        AS "CHAINID",
            product  AS "ProductName_Fixed_Option",
            SUM(actual)   AS "Actual_Qty",
            SUM(forecast) AS "Forecast_Qty",
            SUM(actual) - SUM(forecast) AS "Variance_Qty",
            CASE WHEN SUM(forecast) = 0 THEN 0
                 ELSE (SUM(actual) - SUM(forecast)) / SUM(forecast) END AS "Variance_Pct"
       FROM cube_article_daily
      WHERE ${sql.join(' AND ')}
      GROUP BY article, product
      ORDER BY SUM(actual) DESC`,
    [brand, ...args]
  )
}

export async function stats() {
  const { n } = (await pg.get('SELECT COUNT(*)::int AS n FROM cube_daily')) ?? { n: 0 }
  return { rows: n, brands: await pg.all('SELECT * FROM cube_coverage ORDER BY brand') }
}
