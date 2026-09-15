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
let baseYear = null

const key = (brand, year) => `${String(brand)}|${Number(year)}`

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

  const [rows, scoped] = await Promise.all([
    pg.all(`SELECT brand, year, value, updated_at, updated_by FROM cube_sales_plan`, []),
    baseYear
      ? pg.all(
          `SELECT brand, SUM(value) AS total FROM cube_sales_daily
            WHERE date >= ? AND date <= ? GROUP BY brand`,
          [`${baseYear}-01-01`, `${baseYear}-12-31`]
        )
      : Promise.resolve([]),
  ])
  const base = new Map(scoped.map((r) => [String(r.brand), Number(r.total) || 0]))

  plans.clear()
  for (const r of rows) {
    const brand = String(r.brand)
    const year = Number(r.year)
    const value = Number(r.value)
    if (!Number.isFinite(value) || value < 0) continue
    const baseTotal = base.get(brand) ?? 0
    plans.set(key(brand, year), {
      brand,
      year,
      value,
      baseYear,
      baseTotal,
      // No base-year sales means nothing to scale from, so the plan is recorded
      // but drives nothing. A null ratio is checked for on every read.
      ratio: baseTotal > 0 ? value / baseTotal : null,
      updatedAt: r.updated_at ?? null,
      updatedBy: r.updated_by ?? null,
    })
  }
  return plans.size
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
    if (p.brand !== brand || !p.ratio) continue
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
 * Does this window fall inside a plan year, and if so what does it scale from?
 *
 * Returns null — meaning "nothing to do, behave exactly as before" — unless the
 * window lies wholly inside one planned year for this brand and that plan has a
 * usable ratio. A window straddling the boundary is deliberately refused rather
 * than half-answered: the two halves come from different places and adding them
 * would report a figure that is part measured and part typed without saying so.
 */
export function planWindow(brand, filters) {
  const from = String(filters?.dateFrom ?? '').slice(0, 10)
  const to = String(filters?.dateTo ?? '').slice(0, 10)
  if (!from || !to || !baseYear) return null
  const y = Number(from.slice(0, 4))
  if (!Number.isFinite(y) || y === baseYear) return null
  if (Number(to.slice(0, 4)) !== y) return null

  const plan = plans.get(key(brand, y))
  if (!plan?.ratio) return null
  return {
    ...plan,
    // The equivalent window in the base year, which is what actually gets read.
    from: toBaseYear(from, y, baseYear),
    to: toBaseYear(to, y, baseYear),
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
