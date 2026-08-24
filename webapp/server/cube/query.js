import { db } from '../db/index.js'

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
export function canAnswer(brand, filters = {}) {
  for (const key of Object.keys(filters)) {
    const v = filters[key]
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue
    if (HARMLESS.has(key)) continue
    if (!SUPPORTED.has(key)) return false
  }

  const cover = db.prepare('SELECT * FROM cube_coverage WHERE brand = ?').get(brand)
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

const rowsOf = (sql, args) => db.prepare(sql).all(...args)

export function trend(brand, f) {
  // Same reasoning as topProducts: a daily total does not need the branch
  // column unless a branch filter is applied.
  const table = f.locations?.length ? 'cube_daily' : 'cube_product_daily'
  const w = where(brand, f)
  return rowsOf(
    `SELECT date AS Date,
            SUM(actual)   AS Actual_Qty,
            SUM(forecast) AS Forecast_Qty
       FROM ${table}
      WHERE ${w.sql}
      GROUP BY date
      ORDER BY date ASC`,
    w.args
  )
}

export function byLocation(brand, f) {
  const w = where(brand, f)
  return rowsOf(
    `SELECT location AS LocationID,
            SUM(actual)   AS Actual_Qty,
            SUM(forecast) AS Forecast_Qty
       FROM cube_daily
      WHERE ${w.sql}
      GROUP BY location
      ORDER BY Actual_Qty DESC`,
    w.args
  )
}

export function topProducts(brand, f, top = 0) {
  // Without a branch filter the branch-free rollup has the same answer over a
  // seventh of the rows. With one, it does not have the column to filter on.
  const table = f.locations?.length ? 'cube_daily' : 'cube_product_daily'
  const w = where(brand, f)
  const limit = Number(top) > 0 ? ` LIMIT ${Math.floor(Number(top))}` : ''
  return rowsOf(
    `SELECT product AS ProductName_Fixed_Option,
            SUM(actual)   AS Actual_Qty,
            SUM(forecast) AS Forecast_Qty
       FROM ${table}
      WHERE ${w.sql}
      GROUP BY product
      ORDER BY Actual_Qty DESC${limit}`,
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
export function canAnswerArticles(brand, filters = {}) {
  if (filters.locations?.length) return false
  if (!canAnswer(brand, filters)) return false
  return db.prepare('SELECT COUNT(*) AS n FROM cube_article_daily WHERE brand = ?').get(brand).n > 0
}

export function productLevel(brand, f) {
  const sql = ['brand = ?']
  const args = [brand]
  if (f.dateFrom) { sql.push('date >= ?'); args.push(f.dateFrom) }
  if (f.dateTo) { sql.push('date <= ?'); args.push(f.dateTo) }
  if (f.products?.length) {
    sql.push(`product IN (${f.products.map(() => '?').join(', ')})`)
    args.push(...f.products.map(String))
  }

  return db
    .prepare(
      `SELECT article  AS Clean_ItemID,
              ?        AS CHAINID,
              product  AS ProductName_Fixed_Option,
              SUM(actual)   AS Actual_Qty,
              SUM(forecast) AS Forecast_Qty,
              SUM(actual) - SUM(forecast) AS Variance_Qty,
              CASE WHEN SUM(forecast) = 0 THEN 0
                   ELSE (SUM(actual) - SUM(forecast)) / SUM(forecast) END AS Variance_Pct
         FROM cube_article_daily
        WHERE ${sql.join(' AND ')}
        GROUP BY article, product
        ORDER BY Actual_Qty DESC`
    )
    .all(brand, ...args)
}

export function stats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM cube_daily').get().n
  return { rows: total, brands: db.prepare('SELECT * FROM cube_coverage ORDER BY brand').all() }
}
