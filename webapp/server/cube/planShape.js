/**
 * WHEN a planned year's sales happen — twelve weights per brand.
 *
 * The typed figure in `cube_sales_plan` says how big a plan year is. This says
 * what shape it has. Keeping the two apart is the whole point: a manual target
 * changes the SIZE of the plan, never its SEASONAL SHAPE.
 *
 * TWO SOURCES, IN ORDER OF PREFERENCE
 *
 *   1. `'Seasonal Effect Branch'[Seasonal Effect]` — the brand's twelve monthly
 *      factors, normalised to shares. Chosen on 22 Sep 2026; see
 *      `planShapeFor` for the measurements behind the choice.
 *
 *      The plan year's own factors where it has them, otherwise the newest
 *      complete set. The factors are branch-uniform, average almost exactly
 *      1.0, and differ by brand: February is 0.76 for SS, 0.73 for MM, 0.91 for
 *      BUR.
 *
 *   2. The plan year's own `FORECAST (2)[Totalsale]`, month by month — kept
 *      only as a rescue for a brand with no usable factor set, so that such a
 *      brand can still be planned rather than refused.
 *
 * WHY NOT THE BASE YEAR'S SALES, WHICH IS WHAT THIS REPLACES
 *
 * Until 19 Sep 2026 a plan year was shaped by rewriting its dates to the base
 * year and scaling that year's own daily sales. That inherits whatever the base
 * year did, including things that are not seasonality at all:
 *
 *   BBT January 2026 = -1        ->  January 2027 = -2      negative
 *   CHP January 2026 =  0        ->  January 2027 =  0      against a 10.6M target
 *
 * CHP opened in March 2026, so its sales history is a launch ramp and repeating
 * it forecasts a second launch. Its seasonal factors, by contrast, run 0.87 to
 * 1.16 — perfectly healthy. That contrast is the argument for this table.
 *
 * THE YEAR STAMP ON THE FACTORS
 *
 * All nine brands carry 2027-stamped factors as of 22 Sep 2026, so every brand
 * is shaped by its own plan-year seasonality. The fallback to the newest year a
 * brand has remains for the case where a plan year is missing: that is reuse of
 * SEASONALITY, not of base-year sales - "February is a weak month for SS" is a
 * claim about February, and it does not expire on 31 December. `from` records
 * which year was used and `source` which table, so the page can say both.
 */
import { config } from '../config.js'
import { pg } from '../db/accounts.js'
import { executeQuery } from '../powerbi/client.js'

const SEASONAL = `'Seasonal Effect Branch'`
const MONTHS = 12
const val = (row, name) => row?.[name] ?? row?.[`[${name}]`]

/**
 * The plan year's own monthly forecast, where the model has one.
 *
 * Grouped on `Year_Forecast`/`Month_Forecast` rather than on the date, because
 * those are real columns and SUMMARIZECOLUMNS will not group by an expression.
 */
async function fetchForecastMonths(brand, year) {
  const code = brand.chain ?? brand.code
  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS('FORECAST (2)'[Month_Forecast],
  FILTER(ALL('FORECAST (2)'[Brand]), 'FORECAST (2)'[Brand] = "${code}"),
  FILTER(ALL('FORECAST (2)'[Year_Forecast]), 'FORECAST (2)'[Year_Forecast] = ${Number(year)}),
  "Total", SUM('FORECAST (2)'[Totalsale]))`,
    brand.datasetId,
    { bulk: true }
  )
  const out = new Array(MONTHS + 1).fill(0)
  for (const r of rows) {
    const m = Number(val(r, 'Month_Forecast'))
    if (m >= 1 && m <= MONTHS) out[m] = Number(val(r, 'Total')) || 0
  }
  return out
}

/**
 * The brand's monthly seasonal factors, for the plan year or the newest year it
 * has. `MIN` rather than `SUM` because the factor is repeated per branch and it
 * is one number per brand-month, not a total to add up.
 */
async function fetchSeasonalFactors(brand, year) {
  const code = brand.chain ?? brand.code
  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(${SEASONAL}[Year_SeasonalEffect], ${SEASONAL}[Month_SeasonalEffect],
  FILTER(ALL(${SEASONAL}[Brand]), ${SEASONAL}[Brand] = "${code}"),
  "SE", MIN(${SEASONAL}[Seasonal Effect]))`,
    brand.datasetId,
    { bulk: true }
  )

  const years = new Map()
  for (const r of rows) {
    const y = Number(val(r, 'Year_SeasonalEffect'))
    const m = Number(val(r, 'Month_SeasonalEffect'))
    const se = Number(val(r, 'SE'))
    if (!Number.isFinite(y) || !(m >= 1 && m <= MONTHS) || !Number.isFinite(se)) continue
    if (!years.has(y)) years.set(y, new Array(MONTHS + 1).fill(null))
    years.get(y)[m] = se
  }

  // The plan year's own factors when it has them, otherwise the newest complete
  // set. Incomplete years are skipped rather than part-used: eleven factors
  // normalised as if they were twelve would quietly inflate every month.
  const complete = (f) => f && f.slice(1).every((v) => Number.isFinite(v) && v > 0)
  if (complete(years.get(Number(year)))) return { factors: years.get(Number(year)), from: Number(year) }
  for (const y of [...years.keys()].sort((a, b) => b - a)) {
    if (complete(years.get(y))) return { factors: years.get(y), from: y }
  }
  return null
}

/** Twelve positive numbers to twelve shares that sum to exactly 1. */
function normalise(values) {
  const list = values.slice(1, MONTHS + 1).map((v) => Number(v) || 0)
  if (list.some((v) => v < 0)) return null
  const total = list.reduce((s, v) => s + v, 0)
  if (!(total > 0)) return null
  return list.map((v) => v / total)
}

/**
 * Work out one brand's shape for one year, preferring its seasonal factors.
 *
 * Returns null when neither source can answer, which leaves the brand with no
 * row and therefore no plan — a refusal rather than a guessed shape.
 */
export async function planShapeFor(brand, year) {
  /*
   * The seasonal factors come FIRST, from 22 Sep 2026.
   *
   * This used to prefer the plan year's own FORECAST (2)[Totalsale] and reach
   * the factors only when that was blank - which was the right call while only
   * MM had a 2027 Totalsale, and the wrong one once every brand had both. Two
   * things settled it, measured side by side across all nine brands:
   *
   *   The two sources disagree about ONE claim, and it is a seasonal one. Seven
   *   of nine brands diverge most in March, always the same way: the factors put
   *   March at 1.26-1.46 while Totalsale has it at 8.9-9.3% of the year, barely
   *   above a flat 8.33%. SS March moves 946,742 -> 1,205,589, MM 684,856 ->
   *   887,079. Away from March the two agree inside 0.7 pp.
   *
   *   Totalsale is flatter for seven of the nine (BBT 1.28 against 1.51 between
   *   its largest and smallest month) and it is revised often - MM's series
   *   moved between two audits a day apart. The factors are twelve numbers a
   *   person maintains, average almost exactly 1.0, and do not drift.
   *
   * The deeper reason is that this whole design separates SIZE from SHAPE: the
   * typed target is the size, and this function answers the shape. Totalsale is
   * a forecast of size whose shape we were borrowing and whose size we then
   * discarded. An index is the right kind of thing to ask.
   */
  const seasonal = await fetchSeasonalFactors(brand, year).catch(() => null)
  if (seasonal) {
    const weights = normalise(seasonal.factors)
    if (weights) return { weights, source: 'seasonal', from: seasonal.from }
  }

  /*
   * Totalsale is kept as the rescue, not the preference.
   *
   * A brand with no usable factor set at all would otherwise have no shape and
   * no plan. Its own monthly forecast is a reasonable second answer, and it is
   * better than refusing to plan the brand.
   */
  let forecast = null
  try {
    forecast = await fetchForecastMonths(brand, year)
  } catch {
    // A model without the table or the columns is not an error here - the brand
    // simply has no shape, and the caller leaves it unplannable.
    forecast = null
  }

  /*
   * Only usable if every month has something in it.
   *
   * A partly-filled year would put the whole target into the months that happen
   * to be populated, which would look deliberate and be wrong. All twelve or
   * none.
   */
  if (forecast && forecast.slice(1).every((v) => v > 0)) {
    const weights = normalise(forecast)
    if (weights) return { weights, source: 'forecast', from: Number(year) }
  }

  return null
}

/**
 * Make sure one brand-year has a shape, fetching it only if it has none.
 *
 * Called when a figure is saved, so that typing a target is all anybody has to
 * do — the shape it will be spread by is fetched in the same request. Cheap
 * when it is already there, which is every save after the first.
 */
export async function ensurePlanShape(brand, year) {
  const held = await pg.all(
    'SELECT COUNT(*)::int AS n FROM cube_plan_shape WHERE brand = ? AND year = ?',
    [String(brand), Number(year)]
  )
  if (Number(held[0]?.n ?? 0) === MONTHS) return { brand: String(brand), cached: true }

  const found = config.brands.find((b) => b.code === String(brand))
  if (!found) return { brand: String(brand), skipped: 'unknown brand' }

  const shape = await planShapeFor(found, year)
  if (!shape) return { brand: String(brand), skipped: 'no usable pattern' }

  await pg.tx(async () => {
    await pg.run('DELETE FROM cube_plan_shape WHERE brand = ? AND year = ?', [String(brand), Number(year)])
    for (let m = 1; m <= MONTHS; m += 1) {
      await pg.run(
        `INSERT INTO cube_plan_shape (brand, year, month, weight, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (brand, year, month) DO UPDATE
           SET weight = EXCLUDED.weight, source = EXCLUDED.source`,
        [String(brand), Number(year), m, shape.weights[m - 1], shape.source]
      )
    }
  })
  return { brand: String(brand), source: shape.source, from: shape.from, cached: false }
}

/**
 * Refresh the shapes for one year across every brand.
 *
 * Written brand by brand rather than as one transaction so that a brand whose
 * model cannot answer leaves the shape it already had, instead of taking every
 * other brand's down with it.
 */
export async function refreshPlanShapes(year, onBrand = null) {
  const out = []
  for (const brand of config.brands) {
    try {
      const shape = await planShapeFor(brand, year)
      if (!shape) {
        out.push({ brand: brand.code, skipped: 'no usable pattern' })
        onBrand?.({ brand: brand.code, skipped: 'no usable pattern' })
        continue
      }
      await pg.tx(async () => {
        await pg.run('DELETE FROM cube_plan_shape WHERE brand = ? AND year = ?', [brand.code, Number(year)])
        for (let m = 1; m <= MONTHS; m += 1) {
          await pg.run(
            `INSERT INTO cube_plan_shape (brand, year, month, weight, source)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (brand, year, month) DO UPDATE
               SET weight = EXCLUDED.weight, source = EXCLUDED.source`,
            [brand.code, Number(year), m, shape.weights[m - 1], shape.source]
          )
        }
      })
      const row = { brand: brand.code, source: shape.source, from: shape.from }
      out.push(row)
      onBrand?.(row)
    } catch (err) {
      const row = { brand: brand.code, error: String(err.message).slice(0, 140) }
      out.push(row)
      onBrand?.(row)
    }
  }
  return out
}
