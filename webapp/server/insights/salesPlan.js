/**
 * Brand sales somebody typed in, for a year the models do not cover.
 *
 * WHY THIS EXISTS
 *
 * The forecast models stop on 31 Dec 2026. Audited on 15 Sep 2026:
 * `Forecast_Product_Table` spans 2025-11-01 to 2026-12-31 and returns no rows
 * at all for 2027; every brand's model calendar reads 2026-01-01 to 2026-12-31;
 * `cube_sales_daily` holds 365 rows per brand, all of them 2026. So there is no
 * 2027 forecast to override — a typed figure is the only 2027 number there is.
 *
 * THE CHAIN IT DRIVES
 *
 *   typed brand sales -> brand 2027 sales -> product forecast -> article forecast
 *
 * Only the first link is stored. Everything downstream is derived on read, by
 * scaling the base year's own shape:
 *
 *   ratio = typed value / the brand's base-year sales
 *
 * and then, for a window inside the plan year, the equivalent base-year window
 * is read and its quantities multiplied by that ratio.
 *
 * WHY DERIVE RATHER THAN GENERATE ROWS
 *
 * Generating 2027 rows into `cube_article_monthly` and `cube_component_monthly`
 * was the obvious approach and it does not work: the extract clears those
 * tables with DELETE ... WHERE brand = ?, with no date bound, so generated rows
 * would live until the next hourly refresh and no longer. Deriving on read has
 * no such race, needs nothing kept in sync, and makes requirement 5 true by
 * construction — with no row in `cube_sales_plan`, not one code path behaves
 * differently.
 *
 * WHY SCALING PRESERVES THE METHOD
 *
 * The product mix is untouched: every product keeps its base-year share, so the
 * shape of the plan is the shape of the year it was built from.
 *
 * The article side needs no separate step. The recipe explosion is LINEAR in
 * product quantity — Component_Forecast_Qty is the sum over recipes of (product
 * quantity x recipe quantity per unit) — so multiplying every product by one
 * brand factor gives exactly the same answer as re-exploding the scaled
 * products through the tree. Scaling the component rows is therefore not an
 * approximation of the recipe method, it is the recipe method.
 *
 * The warehouse article forecast needs nothing at all. `forecastFromConstants`
 * already multiplies its decayed ratio by the window's sales, and it reads that
 * through `cube.forecastSales`, so once this answers for 2027 the warehouse
 * figures appear on the existing method. Verified during the audit:
 * `constantsFor` anchors on 2027-01-01 happily and trains on Jul-Dec 2026.
 *
 * ASSUMPTIONS, BECAUSE THEY WERE NOT SPECIFIED
 *
 *   - One annual figure per brand, spread across the plan year by the base
 *     year's own daily shape. Monthly entry would let somebody shape
 *     seasonality by hand; this inherits it, and keeps the daily series the
 *     identical 365 rows every existing read already expects.
 *   - The figure is a sales VALUE in dinar, matching 'FORECAST (2)'[Totalsale],
 *     which is what every downstream calculation assumes.
 *   - The mix basis is the whole base year, not a recent slice, so the plan is
 *     compared against a matching period rather than a seasonal fragment.
 *   - A typed figure stays until deleted here. If the business later loads real
 *     2027 into Power BI, the model calendar extends, the extract starts
 *     writing real 2027 rows, and those win for the dates they cover — real
 *     data superseding a plan is the right precedence.
 */
import { pg } from '../db/accounts.js'

/*
 * Held in memory, and readable synchronously.
 *
 * `canAnswer` and friends are synchronous, called inside conditionals all over
 * the read path, and the coverage cache beside this one is held for exactly the
 * same reason. The ratio is worked out once at load rather than on every read,
 * which is what lets `planFor` stay synchronous.
 */
const plans = new Map()
const shapes = new Map()
let baseYear = null

const key = (brand, year) => `${String(brand)}|${Number(year)}`
const MONTHS = 12
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/**
 * The last whole year the models actually cover.
 *
 * Derived rather than hard-coded: it is the year of the latest day in
 * `cube_sales_daily`, which the extract fills over each brand's model calendar.
 * Today that is 2026, and it moves on its own when the models do.
 */
export function salesPlanBaseYear() {
  return baseYear
}

/**
 * Read every typed figure, and the base-year total each one is measured against.
 *
 * Called at boot beside `loadCoverage`, and again after a save. A stale entry
 * can only make a plan year look uncovered, never make an uncovered year look
 * planned.
 */
export async function loadSalesPlans() {
  // The base year has to be known before the totals it scopes can be asked for,
  // so this is two reads rather than one parallel pair.
  const latest = await pg.all(`SELECT MAX(date) AS hi FROM cube_sales_daily`, [])
  const hi = String(latest[0]?.hi ?? '').slice(0, 10)
  baseYear = hi ? Number(hi.slice(0, 4)) : null

  const [rows, scoped, shaped] = await Promise.all([
    pg.all(`SELECT brand, year, value, updated_at, updated_by FROM cube_sales_plan`, []),
    baseYear
      ? pg.all(
          `SELECT brand, SUM(value) AS total FROM cube_sales_daily
            WHERE date >= ? AND date <= ? GROUP BY brand`,
          [`${baseYear}-01-01`, `${baseYear}-12-31`]
        )
      : Promise.resolve([]),
    pg.all(`SELECT brand, year, month, weight, source FROM cube_plan_shape`, []),
  ])
  const base = new Map(scoped.map((r) => [String(r.brand), Number(r.total) || 0]))

  /*
   * The twelve weights, gathered per brand-year.
   *
   * A set with a missing month is dropped rather than part-used: eleven weights
   * that were normalised as twelve would put the twelfth month's share into the
   * other eleven and inflate every one of them.
   */
  shapes.clear()
  const gathered = new Map()
  for (const r of shaped) {
    const k = key(r.brand, r.year)
    if (!gathered.has(k)) gathered.set(k, { weights: new Array(MONTHS).fill(null), source: null })
    const m = Number(r.month)
    if (!(m >= 1 && m <= MONTHS)) continue
    gathered.get(k).weights[m - 1] = Number(r.weight)
    gathered.get(k).source = String(r.source ?? '')
  }
  for (const [k, g] of gathered) {
    if (!g.weights.every((w) => Number.isFinite(w) && w >= 0)) continue
    const total = g.weights.reduce((s, w) => s + w, 0)
    if (!(total > 0)) continue
    // Stored normalised, but re-normalised here so a rounding drift in the
    // table can never make a year's months miss its target.
    shapes.set(k, { weights: g.weights.map((w) => w / total), source: g.source })
  }

  plans.clear()
  for (const r of rows) {
    const brand = String(r.brand)
    const year = Number(r.year)
    const value = Number(r.value)
    if (!Number.isFinite(value) || value < 0) continue
    const baseTotal = base.get(brand) ?? 0
    const shape = shapes.get(key(brand, year)) ?? null
    plans.set(key(brand, year), {
      brand,
      year,
      value,
      baseYear,
      baseTotal,
      /*
       * `ratio` is the year-on-year growth the typed figure implies, and it is
       * shown on the page as exactly that. It is NOT what shapes the plan any
       * more: the months come from `shape` below, and this is not multiplied
       * through anything.
       */
      ratio: baseTotal > 0 ? value / baseTotal : null,
      shape: shape?.weights ?? null,
      shapeSource: shape?.source ?? null,
      /*
       * Two things are needed before a plan drives anything: a shape, which
       * says when the year's sales happen, and some base-year sales, which is
       * where the product mix is read from. Missing either, the figure is
       * recorded and does nothing.
       */
      usable: Boolean(shape) && baseTotal > 0,
      updatedAt: r.updated_at ?? null,
      updatedBy: r.updated_by ?? null,
    })
  }
  return plans.size
}

/** The twelve weights for a brand-year, or null. */
export function planShape(brand, year) {
  return shapes.get(key(brand, year)) ?? null
}

/**
 * The plan's twelve monthly sales values.
 *
 * The target spread across the year by its own shape. These sum to the target
 * exactly, which is the property the whole design turns on.
 */
export function planMonthlyValues(brand, year) {
  const plan = plans.get(key(brand, year))
  if (!plan?.usable) return null
  return plan.shape.map((w) => plan.value * w)
}

/** Every typed figure, newest first, for the page that edits them. */
export function salesPlans() {
  return [...plans.values()].sort((a, b) => a.year - b.year || a.brand.localeCompare(b.brand))
}

/** The plan for one brand and year, or null. */
export function salesPlanFor(brand, year) {
  return plans.get(key(brand, year)) ?? null
}

/** The last day any plan covers for this brand, so coverage can be widened. */
export function plannedThrough(brand) {
  let last = null
  for (const p of plans.values()) {
    if (p.brand !== brand || !p.usable) continue
    const end = `${p.year}-12-31`
    if (!last || end > last) last = end
  }
  return last
}

/**
 * Map a plan-year date back to the base year.
 *
 * A straight year substitution. 29 February is clamped to the 28th so a leap
 * base year cannot produce a date the plan year does not have — with 2026 and
 * 2027 both common years this never fires today, and it is the one edge a
 * substitution like this has.
 */
const toBaseYear = (iso, from, to) => {
  const d = String(iso).slice(0, 10)
  if (Number(d.slice(0, 4)) !== from) return d
  const md = d.slice(5)
  return `${to}-${md === '02-29' ? '02-28' : md}`
}

/**
 * How much of each month a window covers.
 *
 * Returns one entry per month the window touches, with the fraction of that
 * month's days it holds. A whole month is 1; 15-30 November is 16/30.
 *
 * Days are the split within a month because the shape is monthly and says
 * nothing finer. That is stated here rather than discovered: a month's sales
 * are spread evenly across its days, and only the month-to-month pattern is
 * claimed to be seasonality.
 */
function monthCoverage(from, to, year) {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []

  const out = []
  for (let m = 1; m <= MONTHS; m += 1) {
    const days = daysInMonth(year, m)
    const mStart = Date.UTC(year, m - 1, 1)
    const mEnd = Date.UTC(year, m - 1, days)
    const lo = Math.max(start, mStart)
    const hi = Math.min(end, mEnd)
    if (hi < lo) continue
    const held = Math.round((hi - lo) / 86400000) + 1
    out.push({ month: m, fraction: held / days, days: held })
  }
  return out
}

/**
 * A window that spans a planned year and another year, which cannot be answered.
 *
 * Returns a message, or null when the window is fine. The two halves come from
 * different places — one measured, one typed against a shape — and adding them
 * would report a figure that is part one and part the other without saying so.
 *
 * Until 19 Sep 2026 this was claimed to be refused and was not: the plan simply
 * did not apply and the raw table answered, so 15 Dec 2026 - 15 Jan 2027 came
 * back as 287,232, which is December alone, with nothing to say January was
 * missing. It is refused properly now.
 */
export function planBoundaryError(brand, filters) {
  const from = String(filters?.dateFrom ?? '').slice(0, 10)
  const to = String(filters?.dateTo ?? '').slice(0, 10)
  if (!from || !to || !baseYear) return null
  const a = Number(from.slice(0, 4))
  const b = Number(to.slice(0, 4))
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null

  // Only a planned year makes a mixed window unanswerable. Two ordinary years
  // side by side are read from the same table and add up honestly.
  const touched = []
  for (let y = Math.min(a, b); y <= Math.max(a, b); y += 1) {
    if (plans.get(key(brand, y))?.usable) touched.push(y)
  }
  if (!touched.length) return null

  return (
    `A date range cannot cross into ${touched.join(' and ')}, which ${touched.length > 1 ? 'are' : 'is'} a planned year for ${brand}. ` +
    `Planned years are built from a sales target and a seasonal shape, and measured years are read from the model; ` +
    `adding the two would give a total that is part plan and part actual without saying which. ` +
    `Choose a range inside one year.`
  )
}

/**
 * Does this window fall inside a plan year, and if so what shapes it?
 *
 * Returns null — meaning "nothing to do, behave exactly as before" — unless the
 * window lies wholly inside one planned year for this brand and that plan is
 * usable.
 *
 * WHAT CHANGED ON 19 SEP 2026
 *
 * This used to return the plan's annual `ratio`, and every caller multiplied
 * the equivalent base-year window by it. That made the base year's own monthly
 * sales the shape of the plan year, which is what produced a January of -2 for
 * BBT and 0 for CHP.
 *
 * It now returns `plannedValue`: what the target says this window's sales are,
 * worked out from the plan's twelve weights. The base-year window is still
 * returned, but only as the source of the PRODUCT MIX — there is no 2027
 * product data anywhere, so the mix has to be borrowed. Callers size that mix
 * to `plannedValue` instead of scaling it by an annual ratio.
 *
 * Those two uses of the base year are different things and the distinction is
 * the point of the change: WHEN the sales happen comes from the plan's shape,
 * WHAT is sold comes from the mix.
 */
export function planWindow(brand, filters) {
  const from = String(filters?.dateFrom ?? '').slice(0, 10)
  const to = String(filters?.dateTo ?? '').slice(0, 10)
  if (!from || !to || !baseYear) return null
  const y = Number(from.slice(0, 4))
  if (!Number.isFinite(y) || y === baseYear) return null
  if (Number(to.slice(0, 4)) !== y) return null

  const plan = plans.get(key(brand, y))
  if (!plan?.usable) return null

  const months = monthCoverage(from, to, y)
  if (!months.length) return null

  /*
   * The window's share of the year, and therefore its sales.
   *
   * Summed over whole and part months alike, so a window of the whole year
   * sums the twelve weights back to 1 and lands exactly on the typed figure.
   */
  const share = months.reduce((s, m) => s + plan.shape[m.month - 1] * m.fraction, 0)

  return {
    ...plan,
    months,
    share,
    plannedValue: plan.value * share,
    // The equivalent window in the base year. The MIX comes from here; the size
    // does not.
    from: toBaseYear(from, y, baseYear),
    to: toBaseYear(to, y, baseYear),
    // Where to read a mix from when the equivalent window has no usable sales -
    // CHP's January, which is zero because the brand opened in March.
    fallbackFrom: `${baseYear}-01-01`,
    fallbackTo: `${baseYear}-12-31`,
  }
}

/** Write or replace one brand's figure for one year. */
export async function saveSalesPlan(brand, year, value, who = null) {
  const code = String(brand ?? '').trim()
  const y = Number(year)
  const v = Number(value)
  if (!code) throw new Error('A brand is required.')
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error('That is not a usable year.')
  if (!Number.isFinite(v) || v < 0) throw new Error('The sales figure has to be a number, and not negative.')

  await pg.run(
    `INSERT INTO cube_sales_plan (brand, year, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (brand, year) DO UPDATE
       SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [code, y, v, new Date().toISOString(), who]
  )
  await loadSalesPlans()
  return salesPlanFor(code, y)
}

/** Remove one brand's figure, and with it everything derived from it. */
export async function clearSalesPlan(brand, year) {
  await pg.run(`DELETE FROM cube_sales_plan WHERE brand = ? AND year = ?`, [
    String(brand ?? '').trim(),
    Number(year),
  ])
  await loadSalesPlans()
}

/** The base-year total a ratio would be measured against, for the page. */
export async function baseYearTotals() {
  if (!baseYear) return new Map()
  const rows = await pg.all(
    `SELECT brand, SUM(value) AS total FROM cube_sales_daily
      WHERE date >= ? AND date <= ? GROUP BY brand`,
    [`${baseYear}-01-01`, `${baseYear}-12-31`]
  )
  return new Map(rows.map((r) => [String(r.brand), Number(r.total) || 0]))
}
