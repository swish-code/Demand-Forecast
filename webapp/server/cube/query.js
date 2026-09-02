import { timed } from '../perf.js'
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

/**
 * Which window a question has to fit inside.
 *
 * A question that names a branch can only be answered from cube_daily, which
 * holds branch crossed with product and is therefore kept to a few months
 * either side of today. Everything else reads a table with no branch column,
 * and those carry the whole model calendar.
 *
 * So the same date range can be answerable one way and not the other, and the
 * branch filter is what decides which.
 */
function windowFor(cover, filters) {
  if (!filters.locations?.length) {
    // Null means the tables behind the wide pages hold nothing for this brand.
    // That is a refusal, not an open range.
    if (!cover.from_date || !cover.to_date) return null
    return { from: cover.from_date, to: cover.to_date }
  }
  if (!cover.detail_from || !cover.detail_to) return null
  return { from: cover.detail_from, to: cover.detail_to }
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

  const win = windowFor(cover, filters)
  if (!win) return false
  // A request with no window at all could mean anything; let it go live.
  if (!filters.dateFrom || !filters.dateTo) return false
  return within(cover, win, filters)
}

/*
 * A window is answerable once it is clamped to the days that exist.
 *
 * The Overview asks for the selected period *and* the one before it in one
 * query, so choosing "All dates" asks for 2025 — a year the model has never
 * held. Compared against coverage that reads as "not covered", and the whole
 * page fell back to Power BI to be told, slowly, that there is nothing there.
 *
 * The model's own calendar is recorded with the coverage, so a request reaching
 * outside it is asking for days that do not exist anywhere. What matters is
 * whether the part that does exist is covered.
 */
function within(cover, win, filters) {
  const from = cover.model_from && filters.dateFrom < cover.model_from ? cover.model_from : filters.dateFrom
  const to = cover.model_to && filters.dateTo > cover.model_to ? cover.model_to : filters.dateTo

  // Clamped past itself: the window lies entirely outside the calendar, and an
  // empty answer from the copy is the truthful one.
  if (from > to) return true

  return from >= win.from && to <= win.to
}

/**
 * The model's calendar, out of the copy.
 *
 * Every page needs these four dates before it can resolve its own window, so
 * they were fetched live on every cold load — one query per brand, nine of
 * them, measured at six seconds. They change once a day and the extract already
 * asks for them, so it writes them down and this reads them back.
 *
 * Null when the copy has not recorded them yet, which sends the caller to the
 * model exactly as before.
 */
export function dateRangeFor(brand) {
  const cover = coverageCache.get(brand)
  if (!cover?.cal_today || !cover?.model_from || !cover?.model_to) return null
  return {
    min: cover.model_from,
    max: cover.model_to,
    today: cover.cal_today,
    lastActual: cover.cal_last_actual ?? null,
  }
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

const rowsOf = (sql, args) => timed('copy', () => pg.all(sql, args))

/*
 * A window, split into the whole months it contains and the days at each end.
 *
 * Summing a year of daily rows took seconds; the same year as twelve monthly
 * rows takes milliseconds. Most windows are not whole months though, so the
 * range is cut into three: the days before the first whole month, the whole
 * months themselves, and the days after the last one. Each piece is read from
 * the grain that suits it and the pieces are added together.
 *
 * The three cover disjoint dates by construction, so nothing is counted twice —
 * which is the only property that matters here, and the reason the boundaries
 * are computed rather than guessed at with string comparisons.
 */
const lastOfMonth = (yyyymm) => {
  const [y, m] = yyyymm.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

const nextMonth = (yyyymm) => {
  const [y, m] = yyyymm.split('-').map(Number)
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)
}

export function splitWindow(from, to) {
  if (!from || !to || from > to) return { head: null, months: null, tail: null }

  // The first month wholly inside the window, and the last.
  const firstWhole = from.slice(8) === '01' ? from.slice(0, 7) : nextMonth(from.slice(0, 7))
  const lastWhole = to === lastOfMonth(to.slice(0, 7)) ? to.slice(0, 7) : null
  const lastCandidate = lastWhole ?? (() => {
    const prev = to.slice(0, 7)
    const [y, m] = prev.split('-').map(Number)
    return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7)
  })()

  if (firstWhole > lastCandidate) return { head: { from, to }, months: null, tail: null }

  const monthsFrom = firstWhole
  const monthsTo = lastCandidate
  const headTo = new Date(Date.parse(`${monthsFrom}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  const tailFrom = new Date(Date.parse(`${lastOfMonth(monthsTo)}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10)

  return {
    head: from <= headTo ? { from, to: headTo } : null,
    months: { from: monthsFrom, to: monthsTo },
    tail: tailFrom <= to ? { from: tailFrom, to } : null,
  }
}

/**
 * One answer, read from whichever grain suits each part of the window.
 *
 * The pieces cover disjoint dates, so they can simply be stacked and grouped:
 * a row counted in the monthly middle cannot also appear in a daily end.
 */
/**
 * The distinct values of some columns over a window, across both grains.
 *
 * A list of values does not depend on the grain — the products sold in March
 * are the same whether the rows are a day or a month apart — so this takes the
 * same split as the sums, and for the same reason: scanning a year of daily
 * rows to produce twenty-five list entries took five seconds, longer than every
 * other query on the page put together.
 */
async function distinctOverWindow({ brand, daily, monthly, columns, where: extra = '', from, to, order }) {
  const span = splitWindow(from, to)
  // Inside the union the columns are expressions with aliases; outside, only
  // the aliases exist. Selecting the expression again out there asks for a
  // column that is no longer in scope.
  const cols = columns.join(', ')
  const aliases = columns.map((c) => c.split(/\s+AS\s+/i).pop().trim()).join(', ')
  const pieces = []
  const args = []

  const piece = (table, dateCol, lo, hi) => {
    pieces.push(
      `SELECT DISTINCT ${cols} FROM ${table}
        WHERE brand = ? AND ${dateCol} >= ? AND ${dateCol} <= ?${extra ? ` AND ${extra}` : ''}`
    )
    args.push(brand, lo, hi)
  }

  if (span.head) piece(daily, 'date', span.head.from, span.head.to)
  if (span.months) piece(monthly, 'month', span.months.from, span.months.to)
  if (span.tail) piece(daily, 'date', span.tail.from, span.tail.to)
  if (!pieces.length) return []

  return rowsOf(
    `SELECT DISTINCT ${aliases} FROM (${pieces.join(' UNION ALL ')}) t ORDER BY ${order}`,
    args
  )
}

async function sumOverWindow({
  brand,
  daily,
  monthly,
  group,
  select,
  filters,
  from,
  to,
  order,
  limit = '',
  // The measure columns the union carries through. Every forecast table holds
  // an actual and a forecast; the outbound copy holds one quantity.
  values = ['actual', 'forecast'],
}) {
  const span = splitWindow(from, to)
  const extra = filters?.sql?.length ? ` AND ${filters.sql.join(' AND ')}` : ''
  const pieces = []
  const args = []

  const piece = (table, dateCol, lo, hi) => {
    pieces.push(
      `SELECT ${group.join(', ')}, ${values.join(', ')}
         FROM ${table}
        WHERE brand = ? AND ${dateCol} >= ? AND ${dateCol} <= ?${extra}`
    )
    args.push(brand, lo, hi, ...(filters?.args ?? []))
  }

  if (span.head) piece(daily, 'date', span.head.from, span.head.to)
  if (span.months) piece(monthly, 'month', span.months.from, span.months.to)
  if (span.tail) piece(daily, 'date', span.tail.from, span.tail.to)
  if (!pieces.length) return []

  return rowsOf(
    `SELECT ${select}
       FROM (${pieces.join(' UNION ALL ')}) t
      GROUP BY ${group.join(', ')}
      ORDER BY ${order}${limit}`,
    args
  )
}


/**
 * Falling back to cube_daily, but only from the table it is derived from.
 *
 * cube_product_daily is cube_daily summed across branches, rebuilt after each
 * extract. Between a brand's rows landing and that rebuild running it is empty,
 * and reading it alone made a covered brand report zero — a wrong answer given
 * confidently, which is worse than a slow one.
 *
 * The other two must not fall back, and the reason is the point of this whole
 * change: cube_location_daily and cube_article_daily carry the entire calendar,
 * cube_daily carries about four months. Falling back from a year-long window
 * would answer it with a third of the year and say nothing — the same shape of
 * wrong answer, quietly, on a page about totals. Empty from those tables means
 * the brand has nothing there, and empty is the truthful answer.
 */
async function fromRollupOr(daily, sqlFor, args) {
  const rows = await rowsOf(sqlFor(daily), args)
  if (rows.length || daily !== 'cube_product_daily') return rows
  return rowsOf(sqlFor('cube_daily'), args)
}

export async function trend(brand, f) {
  // Same reasoning as topProducts: a daily total does not need the branch
  // column unless a branch filter is applied.
  /*
   * A daily total needs no product and no branch unless one is filtered on.
   *
   * cube_location_daily is the cheapest table that can answer it — a year of it
   * is a few thousand rows a brand — and it carries the whole calendar, so
   * "All dates" reads from here instead of fanning out to Power BI.
   */
  const table = f.locations?.length
    ? 'cube_daily'
    : f.products?.length
      ? 'cube_product_daily'
      : 'cube_location_daily'
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
  // Only a product filter forces the big table here — the branch rollup has
  // every branch for the whole calendar and no product column to filter on.
  const table = f.products?.length ? 'cube_daily' : 'cube_location_daily'
  const w = where(brand, f)
  return fromRollupOr(
    table,
    (t) => `SELECT location AS "LocationID",
            SUM(actual)   AS "Actual_Qty",
            SUM(forecast) AS "Forecast_Qty"
       FROM ${t}
      WHERE ${w.sql}
      GROUP BY location
      ORDER BY SUM(actual) DESC`,
    w.args
  )
}

export async function topProducts(brand, f, top = 0) {
  // Without a branch filter the branch-free rollup has the same answer over a
  // seventh of the rows. With one, it does not have the column to filter on.
  /*
   * cube_article_daily carries the whole calendar and holds the product name
   * beside the code, so grouping it by product answers this for any date range.
   * cube_product_daily only reaches as far as cube_daily does, so it is the
   * fallback rather than the first choice.
   */
  const limit = Number(top) > 0 ? ` LIMIT ${Math.floor(Number(top))}` : ''

  // A branch filter forces the detail table, which has no monthly twin — it is
  // already confined to a few months, so a window it can answer is small.
  if (f.locations?.length) {
    const w = where(brand, f)
    return rowsOf(
      `SELECT product AS "ProductName_Fixed_Option",
              SUM(actual)   AS "Actual_Qty",
              SUM(forecast) AS "Forecast_Qty"
         FROM cube_daily
        WHERE ${w.sql}
        GROUP BY product
        ORDER BY SUM(actual) DESC${limit}`,
      w.args
    )
  }

  const filters = { sql: [], args: [] }
  if (f.products?.length) {
    filters.sql.push(`product IN (${f.products.map(() => '?').join(', ')})`)
    filters.args.push(...f.products.map(String))
  }

  return sumOverWindow({
    brand,
    daily: 'cube_article_daily',
    monthly: 'cube_article_monthly',
    group: ['product'],
    select: `product AS "ProductName_Fixed_Option",
             SUM(actual)   AS "Actual_Qty",
             SUM(forecast) AS "Forecast_Qty"`,
    filters,
    from: f.dateFrom,
    to: f.dateTo,
    order: 'SUM(actual) DESC',
    limit,
  })
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
  // The branch rollup carries every branch for the whole calendar; only a
  // product filter needs the table that has a product column to filter on.
  const table = f.products?.length ? 'cube_daily' : 'cube_location_daily'
  const rows = await rowsOf(
    `SELECT DISTINCT location AS v FROM ${table} WHERE ${sql} AND location <> '' ORDER BY location`,
    args
  )
  return rows.map((r) => r.v)
}

export async function products(brand, f) {
  // A branch filter falls back to the detail table, which has no monthly twin.
  // It is confined to a few months anyway, so that scan is small either way.
  if (f.locations?.length) {
    const { sql, args } = where(brand, { ...f, products: null })
    const rows = await rowsOf(
      `SELECT DISTINCT product AS v FROM cube_daily WHERE ${sql} AND product <> '' ORDER BY product`,
      args
    )
    return rows.map((r) => r.v)
  }

  const rows = await distinctOverWindow({
    brand,
    daily: 'cube_article_daily',
    monthly: 'cube_article_monthly',
    columns: ['product AS v'],
    where: "product <> ''",
    from: f.dateFrom,
    to: f.dateTo,
    order: 'v',
  })
  return rows.map((r) => r.v)
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
  const rows = await distinctOverWindow({
    brand,
    daily: 'cube_article_daily',
    monthly: 'cube_article_monthly',
    columns: ['article AS v', 'product AS p'],
    where: "article <> ''",
    from: f.dateFrom,
    to: f.dateTo,
    order: 'v',
  })
  return rows.map((r) => ({ value: r.v, label: String(r.v), hint: r.p || '' }))
}

/** Which of the asked-for lists this copy can answer for that brand. */
/**
 * The three recipe-side lists, from the copy.
 *
 * Scoped by brand and window only — deliberately not by each other, which is
 * what the live query does too: choosing a recipe group should not empty the
 * component list you are about to choose from.
 */
async function recipeList(brand, f, column) {
  const rows = await distinctOverWindow({
    brand,
    daily: 'cube_component_daily',
    monthly: 'cube_component_monthly',
    columns: [`${column} AS v`],
    where: `${column} <> ''`,
    from: f.dateFrom,
    to: f.dateTo,
    order: 'v',
  })
  return rows.map((r) => r.v)
}

export async function listsFor(brand, f, need) {
  const out = {}
  const wanted = need ?? []

  if (canAnswer(brand, f)) {
    for (const key of wanted) {
      if (key === 'locations') out.locations = await locations(brand, f)
      if (key === 'products') out.products = await products(brand, f)
      if (key === 'articleNames' || key === 'articles') {
        const rows = await articleNames(brand, f)
        if (!rows) continue
        out.articleNames = rows
        out.articles = rows.map((r) => r.value)
      }
    }
  }

  /*
   * The recipe lists have their own gate.
   *
   * They come from a different table with a different shape, and it can be
   * populated when the branch-grain one is not. Asking canAnswer for them would
   * refuse the whole Ingredients page's dropdowns whenever a branch was picked,
   * even though these three lists never depended on the branch.
   */
  if (canAnswerComponents(brand, f)) {
    for (const [key, column] of [
      ['items', 'item'],
      ['recipeGroups', 'recipe'],
      ['nodeTypes', 'node_type'],
    ]) {
      if (wanted.includes(key)) out[key] = await recipeList(brand, f, column)
    }
  }

  return out
}

/**
 * The Ingredients page, from the copy.
 *
 * This page went to Power BI on every single request — the recipe side was
 * never copied at all — which made it the slowest page in the app for every
 * date range rather than only for the uncovered ones.
 *
 * cube_component_daily has no branch column, so a branch filter still goes
 * live. It does have the recipe group, the item, the unit and the production
 * type, which is every dimension this page filters or groups on.
 */
const COMPONENT_FILTERS = new Set([
  'brand',
  'brands',
  'dateFrom',
  'dateTo',
  'items',
  'recipeGroups',
  'nodeTypes',
])

export function canAnswerComponents(brand, filters = {}) {
  if (filters.locations?.length) return false
  // A product filter narrows which recipes are in play, and the copy has no
  // product column on the recipe side to work that out from.
  if (filters.products?.length || filters.articles?.length) return false

  for (const key of Object.keys(filters)) {
    const v = filters[key]
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue
    if (HARMLESS.has(key)) continue
    if (!COMPONENT_FILTERS.has(key)) return false
  }

  const cover = coverageCache.get(brand)
  if (!cover) return false
  if (!filters.dateFrom || !filters.dateTo) return false
  // The recipe copy's own dates. It is fetched separately and can be behind the
  // rest, so borrowing the wide range would claim days it does not hold.
  if (!cover.comp_from || !cover.comp_to) return false
  if (!within(cover, { from: cover.comp_from, to: cover.comp_to }, filters)) return false
  return Number(cover.components ?? 0) > 0
}

export async function componentLevel(brand, f, grain = {}) {
  // The recipe-side predicates, held apart from the date and the brand so the
  // same list can be dropped into either grain's query.
  const filters = { sql: [], args: [] }
  for (const [key, column] of [
    ['items', 'item'],
    ['recipeGroups', 'recipe'],
    ['nodeTypes', 'node_type'],
  ]) {
    if (f[key]?.length) {
      filters.sql.push(`${column} IN (${f[key].map(() => '?').join(', ')})`)
      filters.args.push(...f[key].map(String))
    }
  }

  const sql = ['brand = ?', 'date >= ?', 'date <= ?', ...filters.sql]
  const args = [brand, f.dateFrom, f.dateTo, ...filters.args]

  /*
   * Split by day, only the daily table will do — the monthly rollup has thrown
   * the day away, which is the whole reason it is small. Everything else reads
   * both grains.
   */
  if (grain.date) {
    return rowsOf(
      `SELECT date AS "Date",
              recipe    AS "Recipe Group",
              item      AS "Item",
              article   AS "Item No.",
              bu        AS "BU",
              node_type AS "Node Type",
              SUM(actual)   AS "Component_Actual_Qty",
              SUM(forecast) AS "Component_Forecast_Qty"
         FROM cube_component_daily
        WHERE ${sql.join(' AND ')}
        GROUP BY date, recipe, item, article, bu, node_type
        ORDER BY SUM(forecast) DESC`,
      args
    )
  }

  return sumOverWindow({
    brand,
    daily: 'cube_component_daily',
    monthly: 'cube_component_monthly',
    group: ['recipe', 'item', 'article', 'bu', 'node_type'],
    select: `recipe    AS "Recipe Group",
             item      AS "Item",
             article   AS "Item No.",
             bu        AS "BU",
             node_type AS "Node Type",
             SUM(actual)   AS "Component_Actual_Qty",
             SUM(forecast) AS "Component_Forecast_Qty"`,
    filters,
    from: f.dateFrom,
    to: f.dateTo,
    order: 'SUM(forecast) DESC',
  })
}

/**
 * Outbound from the copy, by article, for a window.
 *
 * Returns null when the copy does not hold the window, so the caller can ask
 * Warehouse Analytics instead rather than reporting that nothing moved.
 */
/**
 * The part of the window outbound can actually answer for.
 *
 * A window running to the end of the month reaches past the last day the
 * warehouse has reported, and refusing it outright blanked the entire Outbound
 * column — and Accuracy with it — for anybody looking at the month they are
 * ordering for. What has already gone out this month is exactly what they need
 * to see beside the requirement.
 *
 * So the end is clamped to the last day held and the start is not: reaching
 * back before the copy begins is a real hole and would understate the figure,
 * while reaching forward is only asking about days that have not happened yet.
 */
function outboundWindow(cover, f) {
  if (!cover?.out_from || !cover?.out_to) return null
  if (!f?.dateFrom || !f?.dateTo) return null
  if (f.dateFrom < cover.out_from) return null
  // Entirely in the future: nothing has gone out, and nothing is the answer.
  if (f.dateFrom > cover.out_to) return null
  return { from: f.dateFrom, to: f.dateTo > cover.out_to ? cover.out_to : f.dateTo }
}

export async function outboundByArticle(brand, f) {
  const win = outboundWindow(coverageCache.get(brand), f)
  if (!win) return null

  const rows = await sumOverWindow({
    brand,
    daily: 'cube_outbound_daily',
    monthly: 'cube_outbound_monthly',
    group: ['article'],
    select: 'article, SUM(qty) AS qty',
    filters: { sql: [], args: [] },
    values: ['qty'],
    from: win.from,
    to: win.to,
    order: 'SUM(qty) DESC',
  })

  const out = new Map()
  for (const r of rows) out.set(String(r.article), Number(r.qty) || 0)
  return out
}

/** The same, split by day, for a table that is. */
export async function outboundByArticleDay(brand, f) {
  const win = outboundWindow(coverageCache.get(brand), f)
  if (!win) return null

  const rows = await rowsOf(
    `SELECT date, article, SUM(qty) AS qty
       FROM cube_outbound_daily
      WHERE brand = ? AND date >= ? AND date <= ?
      GROUP BY date, article`,
    [brand, win.from, win.to]
  )
  const out = new Map()
  for (const r of rows) out.set(`${r.article}|${String(r.date).slice(0, 10)}`, Number(r.qty) || 0)
  return out
}

/**
 * Every article the warehouse has ever shipped to this brand.
 *
 * The point is to tell two different zeros apart. An article the warehouse ships
 * to this brand regularly and did not ship this month is a real zero, and the
 * forecast asking for it anyway is a real miss. An article the warehouse has
 * never once shipped to this brand cannot be measured at all — it reaches the
 * shops another way, or its code does not match — and scoring it zero says the
 * forecast is wrong about something nobody has any evidence on.
 *
 * Measured over the whole outbound copy rather than the requested window, which
 * is the point: a month tells you nothing about whether an article exists.
 *
 * Cached because it changes only when the extract runs, and it is asked once per
 * brand per request.
 */
const shippedCache = new Map()

export async function articlesShippedTo(brand) {
  const held = shippedCache.get(brand)
  if (held) return held
  const rows = await rowsOf('SELECT DISTINCT article FROM cube_outbound_monthly WHERE brand = ?', [brand])
  const out = new Set(rows.map((r) => String(r.article)))
  shippedCache.set(brand, out)
  return out
}

/** Dropped when the extract rewrites outbound, so a new article shows up. */
export function forgetShipped() {
  shippedCache.clear()
}

/**
 * The brand's own sales, month by month.
 *
 * The denominator of the warehouse constant: how much this brand sold in a
 * month, in the same units the forecast counts. Actuals for the months behind
 * us, the forecast for the month ahead.
 */
export async function monthlySales(brand, months, { allBrands = false } = {}) {
  if (!months?.length) return new Map()
  /*
   * The catch-all bucket has no sales of its own.
   *
   * It stands for the central kitchen, the bakery, head office and FM — real
   * consumers with no forecast behind them. Asked for "its" sales it returns
   * nothing, every month is unusable, and every constant derived from it comes
   * out empty, which is why WH forecast stayed blank on exactly the articles
   * the outbound fix had just filled in. Measured against every brand's sales
   * together it has a denominator again, and the rate it produces is per item
   * the business sells rather than per item one brand sells.
   */
  const rows = await rowsOf(
    `SELECT LEFT(date, 7) AS month,
            SUM(actual)   AS actual,
            SUM(forecast) AS forecast
       FROM cube_location_daily
      WHERE ${allBrands ? '' : 'brand = ? AND '}LEFT(date, 7) IN (${months.map(() => '?').join(', ')})
      GROUP BY LEFT(date, 7)`,
    allBrands ? [...months] : [brand, ...months]
  )
  const out = new Map()
  for (const r of rows) {
    out.set(String(r.month), { actual: Number(r.actual) || 0, forecast: Number(r.forecast) || 0 })
  }
  return out
}

/** What went out to this brand, by article and by month. */
export async function outboundByMonth(brand, months) {
  if (!months?.length) return new Map()
  const rows = await rowsOf(
    `SELECT article, month, qty
       FROM cube_outbound_monthly
      WHERE brand = ? AND month IN (${months.map(() => '?').join(', ')})`,
    [brand, ...months]
  )
  const out = new Map()
  for (const r of rows) {
    const a = String(r.article)
    if (!out.has(a)) out.set(a, new Map())
    out.get(a).set(String(r.month), Number(r.qty) || 0)
  }
  return out
}

/** The brand's forecast sales over an arbitrary window, from the copy. */
export async function forecastSales(brand, f, { allBrands = false } = {}) {
  if (!f?.dateFrom || !f?.dateTo) return null
  // Same reasoning as monthlySales: the bucket borrows everyone's denominator.
  const rows = await rowsOf(
    `SELECT SUM(forecast) AS forecast
       FROM cube_location_daily
      WHERE ${allBrands ? '' : 'brand = ? AND '}date >= ? AND date <= ?`,
    allBrands ? [f.dateFrom, f.dateTo] : [brand, f.dateFrom, f.dateTo]
  )
  const v = Number(rows[0]?.forecast)
  return Number.isFinite(v) ? v : null
}

/** The dashboard's own idea of today, as the model reports it. */
export function todayFor(brand) {
  return coverageCache.get(brand)?.cal_today ?? null
}

/**
 * Where each article goes when it does not go to a brand.
 *
 * Only for articles nothing could be attributed to, so the blank on the page
 * can say why it is blank. Cached: it changes when the extract runs, and it is
 * asked once per request.
 */
let elsewhereCache = null

export async function outboundElsewhere() {
  if (elsewhereCache) return elsewhereCache
  const work = (async () => {
    const rows = await rowsOf(
      `SELECT article, destination, qty FROM cube_article_elsewhere ORDER BY qty DESC`
    )
    const out = new Map()
    for (const r of rows) {
      const a = String(r.article)
      const held = out.get(a) ?? { total: 0, top: null }
      held.total += Number(r.qty) || 0
      // Rows arrive largest first, so the first one seen is the main route.
      if (!held.top) held.top = { destination: String(r.destination), qty: Number(r.qty) || 0 }
      out.set(a, held)
    }
    return out
  })()
  elsewhereCache = work
  return work
}

/** Dropped when the extract rewrites it. */
export function forgetElsewhere() {
  elsewhereCache = null
}

/**
 * Every article the warehouse knows, by number.
 *
 * The whole master, not the subset that happened to move last month. The rows
 * appended for warehouse-only articles were being named from cube_constant,
 * which only holds what shipped in the month the constant was measured over —
 * so an article with six months of history but a quiet August came out named by
 * its bare number. "SWISH MAYONNAISE" appeared as "106200080", which is not
 * something anybody would search for or recognise.
 *
 * Cached: it changes when the extract runs and is asked once per request.
 */
let masterCache = null

export async function articleMaster() {
  if (masterCache) return masterCache
  const work = (async () => {
    // An explicit empty list: the driver binds whatever it is handed, and
    // `undefined` reaches PostgreSQL as one bad parameter.
    const rows = await rowsOf('SELECT article, name, unit FROM cube_article', [])
    const out = new Map()
    for (const r of rows) {
      out.set(String(r.article), { name: r.name ?? '', unit: r.unit ?? '' })
    }
    return out
  })()
  masterCache = work
  return work
}

/** Dropped when the extract rewrites the master. */
export function forgetMaster() {
  masterCache = null
}

/** The constants for items no recipe covers, and the article master. */
export async function constantsFromCopy(brand) {
  const rows = await rowsOf(
    `SELECT c.article, c.constant, c.outbound, a.name, a.unit
       FROM cube_constant c
       LEFT JOIN cube_article a ON a.article = c.article
      WHERE c.brand = ?`,
    [brand]
  )
  const out = new Map()
  for (const r of rows) {
    out.set(String(r.article), {
      constant: Number(r.constant),
      outbound: Number(r.outbound) || 0,
      name: r.name ?? '',
      unit: r.unit ?? '',
    })
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
  const filters = { sql: [], args: [] }
  if (f.products?.length) {
    filters.sql.push(`product IN (${f.products.map(() => '?').join(', ')})`)
    filters.args.push(...f.products.map(String))
  }

  const rows = await sumOverWindow({
    brand,
    daily: 'cube_article_daily',
    monthly: 'cube_article_monthly',
    group: ['article', 'product'],
    select: `article AS "Clean_ItemID",
             product AS "ProductName_Fixed_Option",
             SUM(actual)   AS "Actual_Qty",
             SUM(forecast) AS "Forecast_Qty",
             SUM(actual) - SUM(forecast) AS "Variance_Qty",
             CASE WHEN SUM(forecast) = 0 THEN 0
                  ELSE (SUM(actual) - SUM(forecast)) / SUM(forecast) END AS "Variance_Pct"`,
    filters,
    from: f.dateFrom,
    to: f.dateTo,
    order: 'SUM(actual) DESC',
  })

  // The brand is the same for every row of this call, so it is stamped on here
  // rather than carried through the union as a constant column.
  return rows.map((r) => ({ ...r, CHAINID: brand }))
}

/**
 * Tomorrow's plan, from the copy.
 *
 * The page's slicers become a WHERE clause here. Prep status included: it is a
 * stored column rather than a measure once it is local, so filtering on it no
 * longer needs its own round trip.
 *
 * Returns null when nothing has been copied for this brand, so the caller asks
 * Power BI exactly as it did before.
 */
export async function planFor(brand, f = {}) {
  const held = await rowsOf('SELECT COUNT(*)::int AS n FROM cube_plan WHERE brand = ?', [brand])
  if (!(held[0]?.n > 0)) return null

  const sql = ['brand = ?']
  const args = [brand]
  for (const [column, values] of [
    ['location', f.locations],
    ['product', f.products],
    ['article', f.articles],
    ['prep_status', Array.isArray(f.prepStatus) ? f.prepStatus : f.prepStatus ? [f.prepStatus] : null],
  ]) {
    const list = (values ?? []).filter((v) => v && v !== 'All')
    if (!list.length) continue
    sql.push(`${column} IN (${list.map(() => '?').join(', ')})`)
    args.push(...list.map(String))
  }

  const rows = await rowsOf(
    `SELECT article AS "Clean_ItemID",
            location AS "LocationID",
            product AS "ProductName_Fixed_Option",
            tomorrow_qty AS "Tomorrow_Forecast_Qty",
            last_avg AS "Last_Avg_Actual",
            demand_change AS "Demand_Change_Pct",
            prep_status AS "Prep_Status"
       FROM cube_plan
      WHERE ${sql.join(' AND ')} AND tomorrow_qty > 0
      ORDER BY tomorrow_qty DESC`,
    args
  )
  return rows.map((r) => ({ ...r, CHAINID: brand }))
}

/** The five cards above it. Null when nothing has been copied. */
export async function planKpisFor(brand) {
  const rows = await rowsOf('SELECT * FROM cube_plan_kpis WHERE brand = ?', [brand])
  const r = rows[0]
  if (!r) return null
  return {
    Tomorrow_Forecast_Qty: Number(r.tomorrow_qty) || 0,
    Products_To_Prepare: Number(r.to_prepare) || 0,
    High_Demand_Products: Number(r.high_demand) || 0,
    Low_Demand_Products: Number(r.low_demand) || 0,
    Today_Forecast_Qty: Number(r.today_qty) || 0,
    Plan_Date: r.plan_date ?? null,
    Today_Date: r.today_date ?? null,
  }
}

export async function stats() {
  const { n } = (await pg.get('SELECT COUNT(*)::int AS n FROM cube_daily')) ?? { n: 0 }
  return { rows: n, brands: await pg.all('SELECT * FROM cube_coverage ORDER BY brand') }
}
