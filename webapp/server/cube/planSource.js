/**
 * HOW BIG a planned year is, taken from the model rather than typed.
 *
 * WHY THIS EXISTS
 *
 * `cube_sales_plan` holds an annual figure somebody typed, and salesPlan.js
 * explains why: an audit on 15 Sep 2026 found `Forecast_Product_Table` empty
 * for 2027 and concluded that "a typed figure is the only 2027 number there
 * is".
 *
 * That conclusion was drawn from the PRODUCT table and never checked the BRAND
 * one. Audited again on 20 Oct 2026 across all nine brands,
 * 'FORECAST (2)'[Totalsale] carries every month of 2027, every month positive:
 *
 *   BBT 6,218,954   SS 10,338,430   YP 5,653,919   MM 5,463,984
 *   TBL 4,258,978   PAT   704,662   SLC  670,730   CHP   218,649   BUR 85,675
 *
 * The product-table half of that audit was and remains correct - there is still
 * no 2027 product data, which is why the MIX is still borrowed from the base
 * year. Only the claim about the brand total was wrong.
 *
 * The typed figures are the high ones every time - BBT 10,262,328 against
 * 6,218,954, YP 10,076,033 against 5,653,919 - so every 2027 quantity the page
 * produced was inflated by 16% to 78%.
 *
 * SIZE ONLY, NOT SHAPE
 *
 * This supplies the annual SIZE. WHEN those sales happen still comes from
 * `cube_plan_shape`, which prefers the seasonal factors, and planShape.js
 * argues that preference from measurements: the factors put March at 1.26-1.46
 * while Totalsale has it at 8.9-9.3% of the year, barely above a flat 8.33%.
 *
 * Keeping them apart is what stops the source being applied twice. The twelve
 * monthly figures are stored anyway - not to shape anything, but so the
 * month-by-month reconciliation can be shown without going back to Power BI.
 *
 * SAME FAILURE RULE AS planShape.js
 *
 * A failed query writes nothing and leaves what is already stored alone. That
 * file learned this the hard way: swallowing an error into a fallback pinned
 * BBT to the weaker shape permanently, because the fallback was then WRITTEN
 * and never revisited. A throttled request must cost nothing but a retry.
 */
import { config } from '../config.js'
import { pg } from '../db/accounts.js'
import { fetchForecastMonths } from './planShape.js'

const MONTHS = 12

/**
 * Twelve monthly figures, or null.
 *
 * All twelve or none, for the same reason `planShapeFor` demands a complete
 * factor set: a part-filled year would put a whole year's label on whatever
 * months happen to be populated and read as deliberate.
 */
export function usableMonths(values) {
  if (!Array.isArray(values) || values.length !== MONTHS) return null
  const list = values.map((v) => Number(v))
  if (!list.every((v) => Number.isFinite(v) && v > 0)) return null
  return list
}

/**
 * The authoritative annual sales for a forecast year, from the model alone.
 *
 * WHY THIS TAKES NO TYPED FIGURE
 *
 * It deliberately has no parameter for a manually entered target, and that is
 * the point rather than an omission. A forecast year's size is a fact about the
 * model, and the Sales Plan page is a separate feature for recording what the
 * business INTENDS - the two must not be the same number by accident.
 *
 * An earlier revision of this function took `typed` and fell back to it when
 * the model had no complete year. That looked safe and was not: the fallback is
 * silent, so a single throttled Power BI read at boot would quietly hand every
 * warehouse, product and article forecast back to a typed target - which was
 * measured on 20 Oct 2026 at 16-78% above the model. Because the parameter no
 * longer exists, no caller can reintroduce that path by mistake.
 *
 * Returns null when the model cannot answer. Callers must surface that, not
 * substitute something.
 */
export function forecastAnnual(sourceMonths) {
  const months = usableMonths(sourceMonths)
  if (!months) return null
  const total = months.reduce((s, v) => s + v, 0)
  if (!(total > 0)) return null
  return { value: total, months }
}

/** Read every stored monthly source figure, keyed `brand|year`. */
export async function loadPlanSources() {
  const rows = await pg.all(`SELECT brand, year, month, value FROM cube_plan_source`, [])
  const gathered = new Map()
  for (const r of rows) {
    const k = `${String(r.brand)}|${Number(r.year)}`
    if (!gathered.has(k)) gathered.set(k, new Array(MONTHS).fill(null))
    const m = Number(r.month)
    if (!(m >= 1 && m <= MONTHS)) continue
    gathered.get(k)[m - 1] = Number(r.value)
  }
  return gathered
}

/** Store one brand-year's twelve figures, replacing whatever was there. */
async function store(brand, year, months) {
  const now = new Date().toISOString()
  await pg.tx(async () => {
    await pg.run('DELETE FROM cube_plan_source WHERE brand = ? AND year = ?', [
      String(brand),
      Number(year),
    ])
    for (let m = 1; m <= MONTHS; m += 1) {
      await pg.run(
        `INSERT INTO cube_plan_source (brand, year, month, value, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (brand, year, month) DO UPDATE
           SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at`,
        [String(brand), Number(year), m, months[m - 1], 'forecast', now]
      )
    }
  })
}

/**
 * Fetch and store one brand's figures for one year.
 *
 * Returns what happened rather than throwing, so one brand's unreachable model
 * cannot take the other eight down with it - the same brand-by-brand shape
 * `refreshPlanShapes` uses, and for the same reason.
 */
export async function refreshPlanSourceFor(brand, year) {
  const found = typeof brand === 'string' ? config.brands.find((b) => b.code === brand) : brand
  if (!found) return { brand: String(brand), skipped: 'unknown brand' }

  let raw = null
  try {
    raw = await fetchForecastMonths(found, year)
  } catch (err) {
    // Nothing is written. The brand keeps whatever it already had, which is
    // either the last good read or nothing at all, and the next run retries.
    return { brand: found.code, error: String(err.message).slice(0, 140) }
  }

  // fetchForecastMonths returns a 1-based array of 13; drop the unused slot.
  const months = usableMonths(Array.isArray(raw) ? raw.slice(1, MONTHS + 1) : null)
  if (!months) return { brand: found.code, skipped: 'no complete year in the model' }

  await store(found.code, year, months)
  return {
    brand: found.code,
    total: months.reduce((s, v) => s + v, 0),
    source: 'forecast',
  }
}

/** Refresh every brand for one year. */
export async function refreshPlanSources(year, onBrand = null) {
  const out = []
  for (const brand of config.brands) {
    const row = await refreshPlanSourceFor(brand, year)
    out.push(row)
    onBrand?.(row)
  }
  return out
}

/**
 * Make sure a brand-year has figures, fetching only when it has none.
 *
 * The cheap path for boot and for the save handler, mirroring
 * `ensurePlanShape`: once twelve rows are there this is a single count.
 */
export async function ensurePlanSource(brand, year) {
  const held = await pg.all(
    'SELECT COUNT(*)::int AS n FROM cube_plan_source WHERE brand = ? AND year = ?',
    [String(brand), Number(year)]
  )
  if (Number(held[0]?.n ?? 0) === MONTHS) return { brand: String(brand), cached: true }
  return refreshPlanSourceFor(String(brand), year)
}
