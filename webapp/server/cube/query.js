import { timed } from '../perf.js'
import { pg } from '../db/accounts.js'
import { planWindow, plannedThrough, salesPlans, planBoundaryError } from '../insights/salesPlan.js'
import { planProductRows } from '../insights/planForecast.js'

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
 *
 * `categories` is here as well as in COMPONENT_FILTERS: it narrows articles,
 * and the brand-level endpoints on the same page - the sales series above all -
 * are not per article, so it cannot change their answer. Without it those
 * endpoints refuse the moment the slicer is touched.
 */
const HARMLESS = new Set(['defaultFrom', 'defaultTo', 'need', 'top', 'supply', 'categories'])

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
  widenForPlans()
  return coverageCache.size
}

/*
 * A planned year is answerable, so coverage has to say so.
 *
 * Three things read these dates and would otherwise refuse 2027 outright: the
 * date picker takes its bounds from `dateRangeFor`, `windowFor` decides which
 * table can answer, and `within` clamps a request to the model calendar. None
 * of them knows about a typed figure, and all three are fed from here.
 *
 * Widened in memory rather than in the table, because the extract rewrites
 * `cube_coverage` on every refresh and would undo a stored change. Re-run this
 * after `loadSalesPlans()` and the two stay in step.
 *
 * Only three columns move, and only forwards:
 *
 *   to_date   the branch-free tables, which is what the wide pages read
 *   model_to  the model calendar, which bounds the picker and the clamp
 *   comp_to   the recipe side, read separately because it lags the rest
 *
 * `detail_to` and `out_to` are deliberately left alone. Those cover the
 * branch-level table and the outbound copy, neither of which a sales plan says
 * anything about — so a 2027 window split by branch still goes to Power BI and
 * comes back empty, which is the truthful answer.
 */
function widenForPlans() {
  for (const [brand, cover] of coverageCache) {
    const through = plannedThrough(brand)
    if (!through) continue
    const wider = { ...cover }
    for (const column of ['to_date', 'model_to', 'comp_to']) {
      const held = wider[column] ? String(wider[column]).slice(0, 10) : null
      if (held && held < through) wider[column] = through
    }
    coverageCache.set(brand, wider)
  }
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

/**
 * The latest date any brand has actual sales for.
 *
 * The same `cal_last_actual` `dateRangeFor` hands to the client as
 * `dateRange.lastActual`, off the same cache - not a second source and not a
 * second way of working the date out. This exists because the caller that needs
 * it, the article status stamp, runs after the per-brand fan-out has been merged
 * and so has no brand to ask for.
 *
 * The maximum rather than the minimum: the question is "what is the latest day
 * we have real data for", and a brand whose extract is a day behind should not
 * drag the others back with it. In practice they agree - all nine read
 * 2026-09-15 when this was written.
 *
 * Null when no brand has recorded one, which leaves every caller to carry on
 * exactly as it did before this existed.
 */
export function lastActualDate() {
  let latest = null
  for (const cover of coverageCache.values()) {
    const d = cover?.cal_last_actual ? String(cover.cal_last_actual).slice(0, 10) : null
    if (d && (!latest || d > latest)) latest = d
  }
  return latest
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
  // Applied after the rows are built, from the outbound copy, so it does not
  // narrow the query itself.
  'supply',
  /*
   * The same treatment, for the same reason.
   *
   * `withRecipeKind` and `withStatus` in routes/api.js filter the assembled
   * rows, so neither narrows the query either. Left out of this set they read
   * as filters the copy has no column for, and the whole Stock Article table
   * fell back to a live component query the moment either slicer was touched --
   * on the 8s budget, because `heavy(grain)` is false without a branch split.
   * Nine brands of that answers "Could not reach Power BI". Status is not even
   * a cube column: it is classified per article at request time, so filtering
   * it in SQL was never possible and post-hoc is the only place it can happen.
   */
  'recipeKinds',
  'statuses',
  /*
   * And the article category, for the same reason again.
   *
   * `withCategory` in routes/api.js stamps it from the Inventory Control
   * article master and filters the assembled rows, so it narrows nothing here.
   * Left out of this set it read as a filter the copy has no column for, and
   * selecting a category sent the whole page to a live component query that
   * knows nothing about categories - which came back with every category on it,
   * looking exactly like a filter that does nothing.
   */
  'categories',
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
  guardPlanBoundary(brand, f)
  /*
   * A planned year, sized the same way the product level is.
   *
   * This is not a second method. Component_Forecast_Qty is the sum over every
   * recipe naming the article of (product quantity x recipe quantity per unit),
   * which is LINEAR in product quantity — so multiplying each component row by
   * the same factor gives exactly what re-exploding the sized products through
   * the recipe tree would give. The tree is untouched and the arithmetic is
   * identical.
   *
   * Linearity is why the seasonal change needed nothing here: swapping an
   * annual ratio for a window factor changes the number being multiplied, not
   * the fact that multiplying is valid.
   */
  const plan = planWindow(brand, f)
  if (plan) {
    const mix = await planMix(brand, plan)
    if (!mix) return []
    const rows = await componentLevel(brand, { ...f, dateFrom: mix.from, dateTo: mix.to }, grain)
    return rows.map((r) => ({
      ...r,
      Component_Actual_Qty: 0,
      Component_Forecast_Qty: (Number(r.Component_Forecast_Qty) || 0) * mix.factor,
    }))
  }

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

/**
 * Outbound totalled per day, for a trend rather than a table.
 *
 * The article split is what makes `outboundByArticleDay` expensive to send to a
 * browser — thirty days of three and a half thousand articles is a hundred
 * thousand rows to draw thirty points with. This aggregates in the database and
 * returns one row per day.
 *
 * `articles` narrows it to a set when one is given, which is how the supply
 * filter reaches this query: supply is a property of the article, decided by
 * whether the warehouse has shipped it in six months, so it is applied as a
 * list of articles rather than as a column that exists here.
 */
export async function outboundByDay(brand, f, articles = null) {
  const win = outboundWindow(coverageCache.get(brand), f)
  if (!win) return null
  if (articles && !articles.size) return new Map()

  const rows = await rowsOf(
    `SELECT date, SUM(qty) AS qty
       FROM cube_outbound_daily
      WHERE brand = ? AND date >= ? AND date <= ?
      ${articles ? `AND article IN (${[...articles].map(() => '?').join(', ')})` : ''}
      GROUP BY date
      ORDER BY date ASC`,
    articles ? [brand, win.from, win.to, ...articles] : [brand, win.from, win.to]
  )
  const out = new Map()
  for (const r of rows) out.set(String(r.date).slice(0, 10), Number(r.qty) || 0)
  return out
}

/**
 * Forecast sales per day — the shape the warehouse forecast is spread over.
 *
 * The constant method gives one figure for the whole window: a rate per unit
 * sold, times the sales forecast for that window. Because the rate is a
 * constant, the window figure decomposes exactly — a day's share of the
 * warehouse forecast is that day's share of the sales forecast, and the days
 * sum back to precisely the window total. That is why the trend can be drawn
 * without a second, differently-defined forecast to disagree with the first.
 */
export async function forecastSalesByDay(brand, f, { allBrands = false } = {}) {
  if (!f?.dateFrom || !f?.dateTo) return new Map()
  const rows = await rowsOf(
    `SELECT date, SUM(value) AS forecast
       FROM cube_sales_daily
      WHERE ${allBrands ? '' : 'brand = ? AND '}date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC`,
    allBrands ? [f.dateFrom, f.dateTo] : [brand, f.dateFrom, f.dateTo]
  )
  const out = new Map()
  for (const r of rows) out.set(String(r.date).slice(0, 10), Number(r.forecast) || 0)
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
            SUM(value) AS actual,
            SUM(value) AS forecast
       FROM cube_sales_daily
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
/**
 * Actual sales for the window, the twin of forecastSales.
 *
 * Same table, same window, the other column. It exists so a quantity derived
 * from the sales forecast can have a counterpart derived from the sales that
 * happened — which is the only way an article with no recipe can be scored the
 * way a recipe article is.
 */
export async function actualSales(brand, f, { allBrands = false } = {}) {
  if (!f?.dateFrom || !f?.dateTo) return null
  const rows = await rowsOf(
    `SELECT SUM(value) AS actual
       FROM cube_sales_daily
      WHERE ${allBrands ? '' : 'brand = ? AND '}date >= ? AND date <= ?`,
    allBrands ? [f.dateFrom, f.dateTo] : [brand, f.dateFrom, f.dateTo]
  )
  const v = Number(rows[0]?.actual)
  return Number.isFinite(v) ? v : null
}

/**
 * The sales forecast for a window as it stood before that window began.
 *
 * Answers the question `forecastSales` cannot answer about a finished month:
 * not "what did it sell" but "what did we think it would". Takes the newest
 * vintage stamped strictly before the window's first day - the last forecast
 * made while the month was still entirely ahead.
 *
 * Returns null when no such vintage exists, which is the normal answer for
 * every month that closed before the vintage table shipped. The caller falls
 * back to the training window's own sales rate; it must not fall back to the
 * window's actuals, which is the leak this exists to close.
 */
export async function salesVintage(brand, f, { allBrands = false } = {}) {
  if (!f?.dateFrom || !f?.dateTo) return null
  const rows = await rowsOf(
    `SELECT SUM(value) AS forecast
       FROM cube_sales_vintage
      WHERE ${allBrands ? '' : 'brand = ? AND '}date >= ? AND date <= ?
        AND as_of = (
          SELECT MAX(as_of) FROM cube_sales_vintage
           WHERE ${allBrands ? '' : 'brand = ? AND '}as_of < ?
        )`,
    allBrands
      ? [f.dateFrom, f.dateTo, f.dateFrom]
      : [brand, f.dateFrom, f.dateTo, brand, f.dateFrom]
  )
  const v = Number(rows[0]?.forecast)
  return Number.isFinite(v) && v > 0 ? v : null
}

/*
 * A planned year's sales for a window: the target, spread by the plan's shape.
 *
 * Returns null for every window that is not inside a planned year, which is
 * what keeps the untouched path untouched.
 *
 * No table is read. Until 19 Sep 2026 this read the equivalent base-year window
 * and multiplied it by an annual ratio, which made the base year's own monthly
 * sales the shape of the plan year. The shape now comes from the plan, so the
 * answer is arithmetic on a figure somebody typed and twelve weights - and it
 * cannot inherit a base-year January of -1 (BBT) or 0 (CHP), because it no
 * longer looks at one.
 *
 * The all-brands figure is summed brand by brand rather than scaled once: each
 * brand has its own target AND its own seasonal shape, so neither one blended
 * multiplier nor one blended shape would be right for any brand in the mix.
 */
/**
 * Refuse a window that crosses into a planned year, loudly.
 *
 * Thrown rather than returned because every caller here answers with rows or a
 * number, and there is no value either can carry that means "this question has
 * no answer". A 400 puts the message in front of whoever picked the dates.
 */
function guardPlanBoundary(brand, f) {
  const message = planBoundaryError(brand, f)
  if (!message) return
  const err = new Error(message)
  err.status = 400
  throw err
}

async function plannedSales(brand, f, allBrands) {
  if (allBrands) {
    const year = Number(String(f.dateFrom).slice(0, 4))
    const scoped = salesPlans().filter((p) => p.year === year && p.usable)
    if (!scoped.length) return null
    let total = 0
    for (const plan of scoped) {
      const mapped = planWindow(plan.brand, f)
      if (!mapped) continue
      total += mapped.plannedValue
    }
    return total
  }

  const plan = planWindow(brand, f)
  if (!plan) return null
  return plan.plannedValue
}

/**
 * Where to read a planned window's PRODUCT MIX from, and how much to scale it.
 *
 * The plan says what a window's sales are. It says nothing about which products
 * make them up, and there is no product data for a planned year -
 * `Forecast_Product_Table` holds 3,313,002 rows spanning 2025-11-01 to
 * 2026-12-31 and none at all for 2027. So the mix is borrowed from the base
 * year and sized to the planned figure:
 *
 *   factor = planned sales for the window / base-year sales of the mix window
 *
 * Every product keeps its share of that mix window, and the total lands on the
 * plan. That is the same arithmetic as before; what changed is the numerator,
 * which used to be the base window's own sales times an annual ratio.
 *
 * THE FALLBACK, AND WHY IT IS NOT A FUDGE
 *
 * The equivalent base window is the natural mix source - January's mix for
 * January. But a brand that was not trading then has no mix to lend: CHP opened
 * in March 2026, so its January sales are 0, and BBT's January is -1. Dividing
 * by either gives an infinity or a negative, which is exactly how the old path
 * produced a January of 0 and -2.
 *
 * So when the equivalent window has no positive sales, the mix is read from the
 * whole base year instead. The window still gets its full planned sales; only
 * the question "what does this brand sell" is answered from a wider period.
 * Losing within-year mix drift for such a month is the cost, and it is a great
 * deal cheaper than reporting nothing at all for it.
 */
async function planMix(brand, plan) {
  const salesOf = async (from, to) => {
    const rows = await rowsOf(
      `SELECT SUM(value) AS forecast FROM cube_sales_daily
        WHERE brand = ? AND date >= ? AND date <= ?`,
      [brand, from, to]
    )
    return Number(rows[0]?.forecast) || 0
  }

  const direct = await salesOf(plan.from, plan.to)
  if (direct > 0) {
    return { from: plan.from, to: plan.to, factor: plan.plannedValue / direct, fellBack: false }
  }

  const wide = await salesOf(plan.fallbackFrom, plan.fallbackTo)
  if (!(wide > 0)) return null
  return {
    from: plan.fallbackFrom,
    to: plan.fallbackTo,
    factor: plan.plannedValue / wide,
    fellBack: true,
  }
}

export async function forecastSales(brand, f, { allBrands = false } = {}) {
  if (!f?.dateFrom || !f?.dateTo) return null
  if (!allBrands) guardPlanBoundary(brand, f)
  // A typed figure for this year replaces the model's, which is the whole point
  // of the plan. Null here means there is no plan and nothing changes.
  const planned = await plannedSales(brand, f, allBrands)
  if (planned !== null) return planned
  // Same reasoning as monthlySales: the bucket borrows everyone's denominator.
  const rows = await rowsOf(
    `SELECT SUM(value) AS forecast
       FROM cube_sales_daily
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

/**
 * Articles the warehouse has moved in the last `months` whole months.
 *
 * Membership, not quantity: an article absent from this has no recent history
 * at all, so nothing can be measured against its requirement and nothing can be
 * forecast from its behaviour. Read across every bucket, brands and the
 * unattributed one alike — going to the central kitchen is still moving.
 */
const shippedSinceCache = new Map()

export async function articlesShippedSince(months = 6, today = new Date()) {
  const list = []
  for (let i = 1; i <= months; i++) {
    list.push(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
  }
  const key = list[0] + '|' + months
  const held = shippedSinceCache.get(key)
  if (held) return held

  const work = (async () => {
    const rows = await rowsOf(
      `SELECT DISTINCT article FROM cube_outbound_monthly
        WHERE month IN (${list.map(() => '?').join(', ')}) AND qty > 0`,
      list
    )
    return new Set(rows.map((r) => String(r.article)))
  })()
  shippedSinceCache.set(key, work)
  return work
}

/**
 * Every article the warehouse copy has ever moved, with no window.
 *
 * Only a fallback. The Supply classification is decided from the inbound source
 * column - see `warehouseSourcedArticles` in powerbi/warehouse.js - and this
 * stands in for it when that model cannot be reached, so a Power BI outage
 * degrades the label rather than blanking the column and emptying the supply
 * slicer. It is close but not equal: measured 14 Sep 2026 the two differed on
 * 616 articles, because the catch-all side of the copy is not source-filtered.
 */
let everShippedCache = null

export async function articlesEverShipped() {
  if (everShippedCache) return everShippedCache
  const work = (async () => {
    // An empty bind list, not none: `rowsOf` passes its second argument
    // straight to the driver, and `undefined` arrives as one null parameter
    // against a statement that takes none.
    const rows = await rowsOf(`SELECT DISTINCT article FROM cube_outbound_monthly WHERE qty > 0`, [])
    return new Set(rows.map((r) => String(r.article)))
  })()
  everShippedCache = work
  work.catch(() => {
    everShippedCache = null
  })
  return work
}

/** Dropped when the extract rewrites it. */
export function forgetElsewhere() {
  everShippedCache = null
  shippedSinceCache.clear()
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

/**
 * Every month the warehouse issued this article, and to whom.
 *
 * For the lookup that answers "why is this not on my page?". A reader who
 * cannot find an article has no way to tell the three possible answers apart —
 * it is on the page and they missed it, the warehouse has never shipped it, or
 * it shipped and stopped — and all three arrive as the same empty search. This
 * is the evidence, straight from the copy, whether or not the article is on the
 * page at all.
 *
 * Includes the catch-all destinations. An article that only ever goes to the
 * central kitchen looks absent from every brand, and "it goes to the kitchen"
 * is the answer that stops the question coming back.
 */
export async function articleHistory(article, months) {
  if (!article || !months?.length) return []
  return rowsOf(
    `SELECT brand, month, qty
       FROM cube_outbound_monthly
      WHERE article = ? AND month IN (${months.map(() => '?').join(', ')})
      ORDER BY month`,
    [String(article), ...months]
  )
}

/**
 * Articles whose number or name matches what somebody typed.
 *
 * Number first and exactly, because that is the key everything else joins on
 * and a nine-digit code typed in full is never a guess. Then a loose match on
 * the name, which is how people actually search — and the reason the reports
 * disagree in the first place, since names differ between systems while the
 * number does not.
 */
export async function findArticles(query, limit = 12) {
  const q = String(query ?? '').trim()
  if (q.length < 2) return []
  const master = await articleMaster()

  const exact = master.get(q)
  if (exact) return [{ article: q, ...exact, exact: true }]

  const needle = q.toLowerCase()
  const out = []
  for (const [article, meta] of master) {
    if (article.includes(q) || String(meta.name).toLowerCase().includes(needle)) {
      out.push({ article, ...meta, exact: false })
      if (out.length >= limit) break
    }
  }
  return out
}

/**
 * Every article some recipe names, so it is not forecast twice.
 *
 * The recipe explosion already produces a requirement for these; adding a
 * second one from the warehouse ratio would double them.
 */
let recipeCache = null

export async function recipeArticles() {
  if (recipeCache) return recipeCache
  const work = (async () => {
    const rows = await rowsOf(
      "SELECT DISTINCT article FROM cube_component_daily WHERE article <> ''",
      []
    )
    return new Set(rows.map((r) => String(r.article)))
  })()
  recipeCache = work
  return work
}

/** Dropped when the extract rewrites the recipe copy. */
export function forgetRecipeArticles() {
  recipeCache = null
}

/**
 * When each article last moved, and how often it has moved lately.
 *
 * This is what the five-status classification is built on — Active through to
 * To Be Deactivated is entirely a question of how long ago the warehouse last
 * issued the article, so the whole ladder reduces to one date per article.
 *
 * Read across every brand. An article that reached one brand last week has
 * moved, whatever the others did with it; asking per brand would put the same
 * article in two statuses at once.
 *
 * `asAt` is the end of the window on screen rather than today. Look at March
 * and the statuses shown must be the ones that applied in March, or the page
 * contradicts itself as soon as anybody scrolls back.
 *
 * `recentDays` counts distinct days shipped inside `recentFrom`, which is what
 * separates an article that is genuinely back from one that got a single
 * delivery after months of silence.
 */
const shipHistoryCache = new Map()

export async function shipHistory({ asAt, recentFrom }) {
  const key = `${asAt}|${recentFrom}`
  const held = shipHistoryCache.get(key)
  if (held) return held

  const work = (async () => {
    const rows = await rowsOf(
      `SELECT article,
              MAX(date) AS last_date,
              MIN(date) AS first_date,
              SUM(qty)  AS total_qty,
              COUNT(DISTINCT date) FILTER (WHERE date >= ?) AS recent_days
         FROM cube_outbound_daily
        WHERE qty > 0 AND date <= ?
        GROUP BY article`,
      [recentFrom, asAt]
    )
    const out = new Map()
    for (const r of rows) {
      out.set(String(r.article), {
        lastShipped: r.last_date ? String(r.last_date).slice(0, 10) : null,
        firstShipped: r.first_date ? String(r.first_date).slice(0, 10) : null,
        totalQty: Number(r.total_qty) || 0,
        recentDays: Number(r.recent_days) || 0,
      })
    }
    return out
  })()

  shipHistoryCache.set(key, work)
  return work
}

/** Dropped when the extract rewrites outbound — these are those very rows. */
export function forgetShipHistory() {
  shipHistoryCache.clear()
}

/**
 * How many distinct weeks each article shipped in, over a window.
 *
 * Counting the weeks that happened is what avoids building an article-by-week
 * grid to find the silent ones: a week with no shipment has no row, so it can
 * only be counted by subtracting from the weeks available.
 */
export async function shippingWeeks(from, to) {
  return rowsOf(
    `SELECT article,
            COUNT(DISTINCT to_char(date::date, 'IYYY-IW')) AS weeks_shipped,
            SUM(qty) AS qty
       FROM cube_outbound_daily
      WHERE qty > 0 AND date >= ? AND date <= ?
      GROUP BY article`,
    [from, to]
  )
}

/**
 * Total sales value per day across every brand, for one window.
 *
 * No brand filter: this is the same all-brands total the warehouse constant
 * divides by, so the chart and the forecast are reading one number.
 */
export async function salesByDate(from, to) {
  return rowsOf(
    `SELECT date, SUM(value) AS value
       FROM cube_sales_daily
      WHERE date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC`,
    [from, to]
  )
}

/**
 * Outbound by article and day across every brand, for one window.
 *
 * Summed over buckets rather than split by them: the SOH trend compares what
 * left the warehouse against what the warehouse was holding, and the warehouse
 * holds one pile per article whoever it is destined for.
 */
export async function outboundByArticleDates(from, to) {
  return rowsOf(
    `SELECT article, date, SUM(qty) AS qty
       FROM cube_outbound_daily
      WHERE date >= ? AND date <= ? AND qty > 0
      GROUP BY article, date`,
    [from, to]
  )
}

/** What each article shipped by day of week, Sunday = 0. */
export async function shippingWeekdays(from, to) {
  return rowsOf(
    `SELECT article,
            EXTRACT(DOW FROM date::date) AS dow,
            SUM(qty) AS qty
       FROM cube_outbound_daily
      WHERE qty > 0 AND date >= ? AND date <= ?
      GROUP BY article, EXTRACT(DOW FROM date::date)`,
    [from, to]
  )
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
  guardPlanBoundary(brand, f)
  /*
   * A planned year takes a base-year product mix, sized to the plan.
   *
   * `planMix` says which base-year window to read the mix from and what to
   * multiply it by, so that the window's total lands on the sales the plan's
   * seasonal shape gives it. Every product keeps its share of that mix.
   *
   * The multiplier is no longer the plan's annual ratio. That is what made the
   * base year's monthly sales the shape of the plan year; the shape now comes
   * from the plan itself and only the mix is borrowed.
   *
   * The recursion terminates because the mix window is in the base year, where
   * `planWindow` returns null.
   *
   * Actual is zeroed. A planned year has not traded, and zero is the same
   * convention the copy already holds for months that have not happened.
   */
  const plan = planWindow(brand, f)
  if (plan) {
    /*
     * Method C, from 23 Sep 2026. Actuals only, month by month.
     *
     * What this replaces scaled the base year's FORECAST rows by one factor for
     * the whole window. Two things were wrong with that. The forecast column is
     * sparse in early 2026 — CHP February and TBL March hold none at all — so
     * six brand-months came out zero or a quarter of the right answer. And one
     * factor for a window cannot vary the mix by month, which is the only way a
     * February plan can look like February.
     *
     * `planProductRows` reads observed actuals, decides each month's validity
     * against the brand median, and blends the history with the last 28 days.
     * It returns the same (article, product) grain the SQL below returns, so
     * every caller — the page, the download — is unchanged.
     */
    const rows = await planProductRows(brand, plan.year ?? Number(String(f.dateFrom).slice(0, 4)), {
      from: f.dateFrom,
      to: f.dateTo,
    })
    if (!f.products?.length) return rows
    const wanted = new Set(f.products.map(String))
    return rows.filter((r) => wanted.has(String(r.ProductName_Fixed_Option)))
  }

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
