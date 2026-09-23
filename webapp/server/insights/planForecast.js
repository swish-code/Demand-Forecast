import { pg } from '../db/accounts.js'
import { planMonthlyValues, salesPlanBaseYear } from './salesPlan.js'

/**
 * The plan year's product forecast — Method C.
 *
 * The plan says how much a brand will SELL each month. This says which products
 * that money is spread over, and how many units of each.
 *
 * Every input here is an OBSERVED ACTUAL. The `forecast` column is never read,
 * which is the correction that motivated the whole method: the base year's
 * forecast rows are sparse in early 2026 — BBT February holds 92,958 product
 * units against an actual 408,475, CHP February and TBL March hold none at all
 * — so a mix borrowed from them was empty or wrong for six brand-months, and
 * the plan duly produced zero or a quarter of the right answer for those
 * months. The same months read from actuals are entirely healthy.
 *
 * THE CHAIN
 *
 *   monthly sales   the 2027 plan's own figure (annual target x seasonal share)
 *   units           sales x the month's units-per-sales ratio
 *   mix             which products those units are, 75% history + 25% latest
 *   rows            each product's units split over its articles as observed
 *
 * WHY A RATIO AND A MIX RATHER THAN ONE FACTOR
 *
 * The ratio answers "how many units is a dinar", the mix answers "which
 * products". Keeping them apart is what lets a month with a broken ratio borrow
 * the brand median while still using its own mix, and a month with no mix
 * borrow the year's while still using its own ratio.
 */

const THRESHOLD = 0.25
const HISTORY_WEIGHT = 0.75
const LATEST_DAYS = 28

const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const monthRange = (y, m) => [`${monthKey(y, m)}-01`, `${monthKey(y, m)}-${lastDay(y, m)}`]
const minus = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const shares = (units) => {
  const total = [...units.values()].reduce((s, v) => s + v, 0)
  const out = new Map()
  if (!(total > 0)) return out
  for (const [k, v] of units) if (v > 0) out.set(k, v / total)
  return out
}

/**
 * The last day both halves of the evidence are in.
 *
 * Product actuals and component actuals arrive separately, and on 22 Sep 2026
 * BBT had three days of products with no components behind them. Ending the
 * latest window on the later of the two would have read those days as a
 * collapse in consumption. The earlier of the two is the last day anything can
 * honestly be said about.
 */
async function completeThrough(brand) {
  const rows = await pg.all(
    `SELECT (SELECT MAX(date) FROM cube_article_daily   WHERE brand = ? AND actual > 0) AS p,
            (SELECT MAX(date) FROM cube_component_daily WHERE brand = ? AND actual > 0) AS c`,
    [brand, brand]
  )
  const p = rows[0]?.p ?? null
  const c = rows[0]?.c ?? null
  if (!p) return c
  if (!c) return p
  return p < c ? p : c
}

/**
 * Every base-year month that is over and has evidence on both sides.
 *
 * A month still running is excluded outright rather than pro-rated: a part
 * numerator over a part denominator is the same fraction in theory and much
 * noisier in practice, because sales and deliveries do not land in step inside
 * a month.
 */
function completedMonths(baseYear, through, sales, units) {
  const out = []
  for (let m = 1; m <= 12; m += 1) {
    const [, to] = monthRange(baseYear, m)
    if (to > through) continue
    if (!(sales[m] > 0) || !(units[m] > 0)) continue
    out.push(m)
  }
  return out
}

const cache = new Map()

/** Everything about one brand's base year that the plan needs, measured once. */
export async function planBasis(brand, baseYear = salesPlanBaseYear()) {
  const key = `${brand}|${baseYear}`
  const held = cache.get(key)
  if (held) return held

  const work = (async () => {
    const through = await completeThrough(brand)
    if (!through) return null
    const from = `${baseYear}-01-01`
    const to = `${baseYear}-12-31`

    const sales = new Array(13).fill(0)
    for (const r of await pg.all(
      'SELECT LEFT(date, 7) AS m, SUM(actual) AS v FROM cube_sales_daily WHERE brand = ? AND date >= ? AND date <= ? GROUP BY LEFT(date, 7)',
      [brand, from, to]
    )) {
      sales[Number(String(r.m).slice(5, 7))] = Number(r.v) || 0
    }

    // Product units and the article split beneath them, in one pass. The table
    // carries the whole calendar; cube_product_daily holds only a recent window
    // and would silently drop January to April.
    const units = new Array(13).fill(0)
    const byMonth = Array.from({ length: 13 }, () => new Map())
    const split = new Map()
    for (const r of await pg.all(
      'SELECT LEFT(date, 7) AS m, product, article, SUM(actual) AS v FROM cube_article_daily WHERE brand = ? AND date >= ? AND date <= ? GROUP BY LEFT(date, 7), product, article',
      [brand, from, to]
    )) {
      const v = Number(r.v) || 0
      if (!(v > 0)) continue
      const m = Number(String(r.m).slice(5, 7))
      const product = String(r.product)
      units[m] += v
      byMonth[m].set(product, (byMonth[m].get(product) || 0) + v)
      if (!split.has(product)) split.set(product, new Map())
      const s = split.get(product)
      s.set(String(r.article), (s.get(String(r.article)) || 0) + v)
    }

    const complete = completedMonths(baseYear, through, sales, units)
    const ratio = new Array(13).fill(null)
    for (const m of complete) ratio[m] = units[m] / sales[m]
    const brandMedian = median(complete.map((m) => ratio[m]))

    // The latest 28 whole days of actuals, ending where the evidence ends.
    const latestFrom = minus(through, LATEST_DAYS - 1)
    const latestUnits = new Map()
    for (const r of await pg.all(
      'SELECT product, SUM(actual) AS v FROM cube_article_daily WHERE brand = ? AND date >= ? AND date <= ? GROUP BY product',
      [brand, latestFrom, through]
    )) {
      const v = Number(r.v) || 0
      if (v > 0) latestUnits.set(String(r.product), v)
    }

    return {
      brand,
      baseYear,
      through,
      latestFrom,
      sales,
      units,
      byMonth,
      split,
      complete,
      ratio,
      brandMedian,
      latest: shares(latestUnits),
    }
  })()

  cache.set(key, work)
  return work
}

/** Dropped when the extract rewrites the copy, so new actuals are picked up. */
export function forgetPlanBasis() {
  cache.clear()
}

/** Is the base year's equivalent month a usable model for this one? */
export function monthIsValid(basis, month) {
  if (!basis?.brandMedian) return false
  const r = basis.ratio[month]
  if (!(r > 0)) return false
  return Math.abs(r / basis.brandMedian - 1) <= THRESHOLD
}

/**
 * The product mix for one plan month: 75% history, 25% what is selling now.
 *
 * The history half is the equivalent base-year month where that month is sound,
 * and the rest of the year with that month taken out where it is not. Excluding
 * it is the point — a month declared unusable must not come back in through the
 * fallback it triggered.
 *
 * The latest quarter is what stops a February plan zeroing products that only
 * appeared in June: on 22 Sep 2026 the last 28 days held 95 BBT products that
 * February 2026 had never seen, carrying 33.9% of current volume.
 */
export function planMixFor(basis, month) {
  if (!basis) return null
  const valid = monthIsValid(basis, month)
  const history = valid
    ? shares(basis.byMonth[month])
    : shares(
        basis.complete
          .filter((m) => m !== month)
          .reduce((acc, m) => {
            for (const [p, v] of basis.byMonth[m]) acc.set(p, (acc.get(p) || 0) + v)
            return acc
          }, new Map())
      )
  if (!history.size && !basis.latest.size) return null

  const out = new Map()
  for (const p of new Set([...history.keys(), ...basis.latest.keys()])) {
    const v =
      HISTORY_WEIGHT * (history.get(p) || 0) + (1 - HISTORY_WEIGHT) * (basis.latest.get(p) || 0)
    if (v > 0) out.set(p, v)
  }
  // Re-normalised rather than assumed: either half can be empty, and a mix that
  // does not sum to one would quietly lose or invent units.
  const total = [...out.values()].reduce((s, v) => s + v, 0)
  if (!(total > 0)) return null
  for (const [p, v] of out) out.set(p, v / total)
  return { mix: out, valid }
}

/** How many product units one plan month's sales are worth. */
export function planUnitsFor(basis, brand, year, month) {
  if (!basis) return 0
  const values = planMonthlyValues(brand, year)
  const sales = values?.[month - 1] || 0
  if (!(sales > 0)) return 0
  const rate = monthIsValid(basis, month) ? basis.ratio[month] : basis.brandMedian
  return rate > 0 ? sales * rate : 0
}

/**
 * The plan year's rows, at the same (article, product) grain the page reads.
 *
 * Months are summed rather than returned separately because every caller — the
 * table, the download — asks for a window and wants one figure per row for it.
 * A product's units are split across its articles in the proportion the base
 * year actually shipped them, which is a description of the product rather than
 * a second forecast.
 */
export async function planProductRows(brand, year, { from = null, to = null } = {}) {
  const basis = await planBasis(brand)
  if (!basis) return []

  const target = new Map()
  for (let m = 1; m <= 12; m += 1) {
    const [mf, mt] = monthRange(year, m)
    if (from && mt < from) continue
    if (to && mf > to) continue
    const units = planUnitsFor(basis, brand, year, m)
    if (!(units > 0)) continue
    const picked = planMixFor(basis, m)
    if (!picked) continue
    for (const [product, share] of picked.mix) {
      target.set(product, (target.get(product) || 0) + units * share)
    }
  }
  if (!target.size) return []

  // Anything with no observed article split at all still belongs on the list:
  // it is a real product with a real forecast, and hiding it would read as the
  // forecast being zero rather than the split being unknown.
  const rows = []
  for (const [product, qty] of target) {
    const split = basis.split.get(product)
    const total = split ? [...split.values()].reduce((s, v) => s + v, 0) : 0
    if (!(total > 0)) {
      rows.push({ Clean_ItemID: '', ProductName_Fixed_Option: product, Forecast_Qty: qty })
      continue
    }
    for (const [article, v] of split) {
      rows.push({
        Clean_ItemID: article,
        ProductName_Fixed_Option: product,
        Forecast_Qty: qty * (v / total),
      })
    }
  }
  return rows.map((r) => ({
    ...r,
    CHAINID: brand,
    Actual_Qty: 0,
    Variance_Qty: 0 - r.Forecast_Qty,
    Variance_Pct: r.Forecast_Qty === 0 ? 0 : -1,
  }))
}
