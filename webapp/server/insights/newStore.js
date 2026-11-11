/**
 * The first ninety days of a branch that does not exist yet.
 *
 * WHAT THIS IS, IN ONE LINE
 *
 * The new branch is the brand's own forecast curve, scaled to the sales the
 * user expects it to do.
 *
 * THE ARITHMETIC, AND WHY IT COLLAPSES
 *
 *   rate(plu, period) = brand qty for that PLU  /  brand sales KD    same dates
 *   period qty(plu)   = new branch sales KD  x  rate
 *   daily qty(plu, d) = period qty  x  daily weight
 *
 * where a period is thirty days from the opening day - days 1-30, 31-60 and
 * 61-90 - and the daily weights are normalised to sum to 1 within each period.
 * Substituting, the whole thing is
 *
 *   new daily qty = brand daily qty x (new branch period sales / brand period sales)
 *
 * so it reconciles to the period figure by construction rather than by
 * arithmetic that has to be checked. The intermediate columns are still
 * computed and returned, because they are what make the output auditable - a
 * reader can see the rate and the weight that produced a number.
 *
 * WHY THERE IS NO BASE YEAR HERE
 *
 * An earlier design read the daily shape from a base year through `planBasis`,
 * because when this was first investigated the product forecast stopped at
 * 31 December 2026 and 2027 was empty in all nine models. That was a
 * workaround for missing data, not a method. The 2027 spine removes the
 * premise, so this module reads 2027 directly and imports nothing from
 * `planForecast.js` or `salesPlan.js`. It therefore cannot be affected by
 * `pickBaseYear`, and cannot affect Sales Plan or Procurement.
 *
 * It also means no Ramadan adjustment is needed: a 2027 forecast already sits
 * on 2027's calendar, with Ramadan where 2027 puts it. Thirty-day periods do
 * not disturb that - whatever days a period contains, the weights over them
 * sum to one, so the period total is preserved and Ramadan simply reshapes
 * which days inside it carry the units.
 *
 * TWO THINGS IT REFUSES TO DO
 *
 * It will not substitute another year when 2027 is missing - it reports the
 * window as unavailable, because a forecast quietly drawn from the wrong year
 * is worse than no forecast.
 *
 * It will not redistribute excluded products' demand across the rest. Dropping
 * a product means its quantity goes, and the shortfall against the typed sales
 * target is returned as a figure for the page to state. Redistribution assumes
 * a customer who cannot buy one thing buys another, which over-orders when it
 * is wrong, and doing it properly needs a per-product price that has not been
 * validated. See `impliedSales` in the result.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { cached } from '../cache.js'

/** Three periods of thirty days each, counted from the opening day. */
const PERIOD_COUNT = 3
const PERIOD_DAYS = 30

const iso = (d) => d.toISOString().slice(0, 10)
const dax = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}
/*
 * Trim a float to `n` places for the wire.
 *
 * Every figure here is displayed at four places at most, while JSON.stringify
 * writes seventeen - `0.010183299389002037` for a weight shown as "1.02%".
 * Rounding well past what anything renders keeps the arithmetic identical and
 * takes about a tenth off the payload.
 */
const round = (v, n) => {
  if (!Number.isFinite(v)) return v
  const f = 10 ** n
  return Math.round(v * f) / f
}

const addDays = (s, n) =>
  iso(new Date(Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) + n * 86_400_000))

/**
 * The window: days 1-30, 31-60 and 61-90 from the opening day.
 *
 * WHY NOT CALENDAR MONTHS, SINCE 11 NOV 2026
 *
 * It was three calendar months, which made the first one short whenever a
 * branch opened mid-month - a branch opening on the 28th got a three-day
 * "month 1" sized by a full month's sales figure. Three equal periods of
 * thirty days remove that: every period is the same length whatever day the
 * branch opens, so the three figures the user types are directly comparable
 * to each other and the ramp-up reads as a ramp-up rather than as an artefact
 * of the calendar.
 *
 * The cost is that a period straddles calendar months, so the rate can no
 * longer be read off a month. It is computed over the period's OWN dates
 * instead - see `newStoreForecast` - which is the more honest denominator
 * anyway: the brand's sales on exactly the days being forecast.
 */
export function windowFor(openingDate) {
  const from = String(openingDate).slice(0, 10)
  const periods = []
  for (let i = 0; i < PERIOD_COUNT; i += 1) {
    periods.push({
      period: i + 1,
      from: addDays(from, i * PERIOD_DAYS),
      to: addDays(from, (i + 1) * PERIOD_DAYS - 1),
      days: PERIOD_DAYS,
    })
  }
  return {
    from,
    to: periods[periods.length - 1].to,
    periods,
    days: PERIOD_COUNT * PERIOD_DAYS,
  }
}

/**
 * How much of a period the source actually covers, and what that permits.
 *
 * Pure, and exported, because it is the rule the whole fix rests on and it
 * must be testable without a Power BI token. `covered` is how many of the
 * period's own dates appear in `coveredDates`; nothing short of all of them
 * may be forecast.
 *
 * Not a threshold: 29 of 30 is refused exactly as 1 of 30 is. A missing day is
 * a day of product quantity absent from a numerator whose denominator still
 * holds thirty days of sales, so any gap understates the rate by that day's
 * share, and a rule with a tolerance only moves the point at which the answer
 * is quietly wrong instead of removing it.
 */
export function coverageOf(periodDates, coveredDates) {
  const days = periodDates.length
  let covered = 0
  for (const d of periodDates) if (coveredDates.has(d)) covered += 1
  const status = days > 0 && covered === days ? 'complete' : covered === 0 ? 'none' : 'partial'
  return { days, covered, status, available: status === 'complete' }
}

/**
 * Fold the brand's daily forecast rows into everything the arithmetic needs.
 *
 * THE GRAIN IS THE PLU, SINCE 11 NOV 2026
 *
 * It was the product name, with the PLU carried alongside as a label. The
 * measure makes per-PLU safe: [Total_Forecast_Qty] is additive over
 * Clean_ItemID, so the PLU rates of one product sum to the product's rate and
 * the product totals are preserved. What genuinely changes is ROUNDING, which
 * now happens per PLU per day - see `rounding` in the result.
 *
 * `coveredDates` is filled BEFORE the exclusion check, and at BRAND x DATE
 * grain. What the reader chose not to sell says nothing about what the source
 * holds; and a PLU with no row on a Tuesday is not missing data, it is the
 * model saying that item sells nothing that Tuesday. Measured on 1-30 July
 * 2026 - a window with all thirty days present - only 202 of 474 PLUs carry a
 * row on every day, so a per-PLU coverage rule would discard 57% of the menu
 * from a period that is completely covered.
 *
 * A product is what gets EXCLUDED: nobody delists one barcode of a drink and
 * keeps the other, and the exclusion picker lists product names.
 *
 * Pure and exported so the fold can be tested on synthetic rows, without a
 * Power BI token.
 */
export function foldDaily(daily, periodOf, exclude = []) {
  const dropped = new Set(exclude.map((p) => String(p).trim()).filter(Boolean))
  const perDay = new Map() // `${product}|${plu}|${date}` -> qty
  const perPeriod = new Map() // `${product}|${plu}|${period}` -> qty
  const items = new Map() // `${product}|${plu}` -> { product, plu }
  const products = new Set()
  const excludedQty = new Map() // period -> qty of the products dropped
  const pluQty = new Map() // `${product}|${plu}` -> qty over the whole window
  const coveredDates = new Set()

  for (const r of daily ?? []) {
    const date = String(val(r, 'DateTable[Date]') ?? '').slice(0, 10)
    const product = String(val(r, 'Forecast_Product_Table[ProductName_Fixed_Option]') ?? '').trim()
    const plu = String(val(r, 'Forecast_Product_Table[Clean_ItemID]') ?? '').trim()
    const qty = Number(val(r, 'Qty')) || 0
    if (!date || !product || !(qty > 0)) continue
    const p = periodOf.get(date)
    if (!p) continue
    coveredDates.add(date)
    if (dropped.has(product)) {
      excludedQty.set(p, (excludedQty.get(p) ?? 0) + qty)
      continue
    }
    /*
     * A product row with no PLU still has a forecast; it just has no code to
     * put against it. Kept under an explicit marker rather than discarded, so
     * the quantity is not silently lost from the branch's plan.
     */
    const code = plu || '(no PLU)'
    const key = `${product}|${code}`
    products.add(product)
    if (!items.has(key)) items.set(key, { product, plu: code })
    pluQty.set(key, (pluQty.get(key) ?? 0) + qty)
    perDay.set(`${key}|${date}`, (perDay.get(`${key}|${date}`) ?? 0) + qty)
    perPeriod.set(`${key}|${p}`, (perPeriod.get(`${key}|${p}`) ?? 0) + qty)
  }

  /* Each product's PLUs, busiest first - for the CSV and the cell tooltip. */
  const plusOf = new Map()
  for (const [key, qty] of pluQty) {
    const { product, plu } = items.get(key)
    if (!plusOf.has(product)) plusOf.set(product, [])
    plusOf.get(product).push({ plu, qty })
  }
  for (const list of plusOf.values()) list.sort((a, b) => b.qty - a.qty)

  return { items, perDay, perPeriod, products, excludedQty, coveredDates, pluQty, plusOf }
}

/** Every date in the window, with the period and opening-day number it carries. */
export function daysOf({ periods }) {
  const out = []
  let n = 1
  for (const p of periods) {
    for (let d = new Date(`${p.from}T00:00:00Z`); iso(d) <= p.to; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push({ date: iso(d), period: p.period, day: n })
      n += 1
    }
  }
  return out
}

/**
 * Largest remainder, so the days add up to the month exactly.
 *
 * Rounding each day on its own loses or invents units - ninety days of "round
 * to nearest" on a product selling 0.4 a day produces zero, and the monthly
 * figure it was supposed to add up to is simply gone. This gives every day its
 * floor, then hands the remaining whole units to the days with the largest
 * fractional parts, so the total is preserved and the units land on the busiest
 * days rather than being spread as fractions nobody can order.
 */
export function largestRemainder(values, target) {
  const whole = values.map((v) => Math.floor(v))
  let left = Math.round(target) - whole.reduce((a, b) => a + b, 0)
  if (left <= 0) return whole
  const order = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; k < order.length && left > 0; k += 1, left -= 1) whole[order[k].i] += 1
  // More to give than days to give it to: another pass, same order.
  for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) whole[order[k].i] += 1
  return whole
}

/** The brand's daily product quantities over the window's calendar months. */
async function brandDaily(brand, from, to) {
  return cached(
    `newstore:daily:${brand.code}:${from}:${to}`,
    async () => {
      const rows = await executeQuery(
        `EVALUATE
SUMMARIZECOLUMNS(
  DateTable[Date],
  Forecast_Product_Table[ProductName_Fixed_Option],
  Forecast_Product_Table[Clean_ItemID],
  TREATAS(CALENDAR(${dax(from)}, ${dax(to)}), DateTable[Date]),
  "Qty", [Total_Forecast_Qty]
)`,
        brand.datasetId
      )
      return rows ?? []
    },
    { seconds: 900 }
  )
}

/** The brand's own sales, per calendar month - the rate's denominator. */
async function brandSales(brand, from, to) {
  return cached(
    `newstore:sales:${brand.code}:${from}:${to}`,
    async () => {
      const rows = await executeQuery(
        `EVALUATE
SUMMARIZECOLUMNS(
  'FORECAST (2)'[Date],
  FILTER(ALL('FORECAST (2)'[Brand]), 'FORECAST (2)'[Brand] = "${brand.chain ?? brand.code}"),
  FILTER(ALL('FORECAST (2)'[Date]),
    'FORECAST (2)'[Date] >= ${dax(from)} && 'FORECAST (2)'[Date] <= ${dax(to)}),
  "Value", SUM('FORECAST (2)'[Totalsale])
)`,
        brand.datasetId
      )
      return rows ?? []
    },
    { seconds: 900 }
  )
}

/** How many branches the brand is forecasting, for the per-branch average. */
async function branchCount(brand, from, to) {
  return cached(
    `newstore:branches:${brand.code}:${from}:${to}`,
    async () => {
      const rows = await executeQuery(
        `EVALUATE
ROW("N", CALCULATE(
  DISTINCTCOUNT(Forecast_Product_Table[LocationID]),
  TREATAS(CALENDAR(${dax(from)}, ${dax(to)}), DateTable[Date])
))`,
        brand.datasetId
      )
      const r = rows?.[0] ?? {}
      return Number(r['[N]'] ?? r.N) || 0
    },
    { seconds: 900 }
  )
}

/*
 * Read one field from a Power BI row, whatever shape the key arrives in.
 *
 * WHY THIS IS NOT A ONE-LINER
 *
 * It was `r[`[${k}]`] ?? r[k]`, and that silently emptied this whole module.
 * The client strips table prefixes from result keys, so a column grouped as
 * `Forecast_Product_Table[ProductName_Fixed_Option]` comes back as plain
 * `ProductName_Fixed_Option`. Asking for the name as the DAX spells it matched
 * nothing, the product name read as '', and the row loop skipped all 18,815
 * rows of a fully populated window - which surfaced as "no forecast for this
 * window yet", blaming the data for a defect in this file.
 *
 * Case is not dependable either: 'FORECAST (2)'[Date] comes back as `DATE` in
 * capitals while Forecast_Product_Table[Date] comes back as `Date`. Two
 * spellings of the same word, from two tables, in one module.
 *
 * So the lookup tries, in order: the key as given, the bare column name with
 * any table prefix removed, and finally a case-insensitive match on that bare
 * name. Call sites keep the DAX-shaped name, which says where the value came
 * from, and are no longer hostage to how the client happened to spell it.
 */
const bare = (k) => {
  const m = String(k).match(/\[([^\]]+)\]\s*$/)
  return m ? m[1] : String(k)
}

export const val = (r, k) => {
  if (!r) return undefined
  for (const cand of [k, `[${k}]`, bare(k), `[${bare(k)}]`]) {
    if (r[cand] !== undefined) return r[cand]
  }
  const want = bare(k).toLowerCase()
  for (const key of Object.keys(r)) if (bare(key).toLowerCase() === want) return r[key]
  return undefined
}

/**
 * The ninety-day forecast for a branch that does not exist yet.
 *
 * `periodSales` is three KD figures, one per thirty-day period of the window.
 * `exclude` is product names the new branch will not sell.
 */
export async function newStoreForecast({
  brand: brandCode,
  branchName,
  openingDate,
  periodSales = [],
  exclude = [],
} = {}) {
  const brand = (config.brands ?? []).find(
    (b) => b.code === String(brandCode).toUpperCase() && b.datasetId
  )
  if (!brand) throw new Error(`Unknown brand: ${brandCode}`)
  if (!openingDate) throw new Error('An opening date is required')

  const win = windowFor(openingDate)
  const days = daysOf(win)
  /*
   * Both sides of the rate are read over exactly the window's own days - the
   * ninety from the opening date, no more. With calendar months this had to
   * reach wider than the window so a short first month was not divided by a
   * part-month of sales; equal periods remove that need entirely.
   */
  const fullFrom = win.from
  const fullTo = win.to

  const [daily, sales, branches] = await Promise.all([
    brandDaily(brand, fullFrom, fullTo),
    brandSales(brand, fullFrom, fullTo),
    branchCount(brand, fullFrom, fullTo),
  ])

  /*
   * Which period each date belongs to. Built from the window rather than from
   * arithmetic on the date, so there is one definition of "period 2" and both
   * halves of the rate are keyed by it.
   */
  const periodOf = new Map()
  for (const d of days) periodOf.set(d.date, d.period)

  /* brand sales per period, from the brand's own daily sales */
  const salesByPeriod = new Map()
  for (const r of sales) {
    // Arrives as `DATE`, in capitals; `val` resolves it.
    const date = String(val(r, "'FORECAST (2)'[Date]") ?? '').slice(0, 10)
    const p = periodOf.get(date)
    if (!p) continue
    salesByPeriod.set(p, (salesByPeriod.get(p) ?? 0) + (Number(val(r, 'Value')) || 0))
  }

  /*
   * Brand quantity per PLU per day, and per PLU per period.
   *
   * THE GRAIN IS THE PLU, SINCE 11 NOV 2026
   *
   * It was the product name, with the PLU carried alongside as a label. Asked
   * for per-PLU figures, and the measure makes that safe: [Total_Forecast_Qty]
   * is additive over Clean_ItemID, so the PLU rates of one product sum to the
   * product's rate and the product totals are preserved exactly. The only
   * thing that genuinely changes is ROUNDING - whole units are now allocated
   * per PLU per day rather than per product per day, so a PLU carrying a
   * fraction of a unit a day can round away where the product it belongs to
   * would not have. `rounding` in the result measures that rather than leaving
   * the reader to wonder.
   *
   * A product is still what gets EXCLUDED: nobody delists one barcode of a
   * drink and keeps the other, and the exclusion picker lists product names.
   */
  const { items, perDay, perPeriod, products, excludedQty, coveredDates, plusOf } = foldDaily(
    daily,
    periodOf,
    exclude
  )

  /*
   * Nothing to scale. Returned rather than thrown: the window simply has no
   * forecast in it yet, which is a state the page should say out loud while
   * the 2027 spine is being loaded.
   */
  if (!items.size) {
    return {
      brand: brand.code,
      branchName,
      openingDate: win.from,
      window: win,
      branches,
      periods: win.periods.map((p, i) => ({
        period: p.period,
        from: p.from,
        to: p.to,
        days: p.days,
        covered: 0,
        status: 'none',
        available: false,
        sales: Number(periodSales[i]) || 0,
        // Null rather than the brand's real sales: a sales figure beside a
        // missing quantity reads as measured demand of nothing.
        brandSales: null,
        productQty: null,
        keptShare: null,
        impliedSales: null,
        excludedQty: null,
        reason: `No product forecast exists for ${p.from} to ${p.to}.`,
      })),
      rows: [],
      products: [],
      grain: 'plu',
      items: 0,
      row: { Brand: brand.code, Branch: branchName, Opening_Date: win.from },
      coverage: { complete: 0, partial: 0, none: win.periods.length, lastCovered: null },
      rounding: { exact: 0, whole: 0, lost: 0, zeroed: 0 },
      plus: {},
      available: false,
      reason:
        `The product forecast holds nothing for ${win.from} to ${win.to}. ` +
        `Once those dates are in Forecast_Product_Table and the copy has been ` +
        `refreshed, this will fill. No other year has been substituted.`,
    }
  }

  const periodDays = new Map()
  for (const d of days) periodDays.set(d.period, (periodDays.get(d.period) ?? []).concat(d))

  const rows = []
  const periodSummary = []
  /* Which PLUs were given a quantity, and which survived rounding. */
  const hadQty = new Set()
  const hadRow = new Set()

  win.periods.forEach((p, i) => {
    const userSales = Number(periodSales[i]) || 0
    const brandPeriodSales = salesByPeriod.get(p.period) ?? 0
    const inWindow = periodDays.get(p.period) ?? []
    let periodQty = 0

    /*
     * Coverage decides whether this period may be forecast at all.
     *
     * Anything short of every day is refused outright rather than pro-rated.
     * A period with one covered day of thirty divides one day of product
     * quantity by thirty days of brand sales, which is not a partial answer -
     * it is a confident wrong one, roughly a thirtieth of the truth, and it
     * looks entirely plausible on the page. The 1 Dec 2026 opening produced
     * exactly that: 5,223 units for a month backed by 31 December alone.
     */
    const { covered, status } = coverageOf(
      inWindow.map((d) => d.date),
      coveredDates
    )

    if (status !== 'complete') {
      periodSummary.push({
        period: p.period,
        from: p.from,
        to: p.to,
        days: inWindow.length,
        covered,
        status,
        available: false,
        sales: userSales,
        /*
         * Null, not zero, for everything the missing days make unknowable.
         * A zero here is a claim - "this brand sells nothing" - and showing
         * the brand's own sales beside it would make the claim look measured.
         */
        brandSales: null,
        productQty: null,
        keptShare: null,
        impliedSales: null,
        excludedQty: null,
        reason:
          status === 'none'
            ? `No product forecast exists for ${p.from} to ${p.to}.`
            : `The product forecast covers only ${covered} of the ${inWindow.length} days in ${p.from} to ${p.to}.`,
      })
      return
    }

    for (const [key, item] of items) {
      const brandQtyPeriod = perPeriod.get(`${key}|${p.period}`) ?? 0
      if (!(brandQtyPeriod > 0) || !(brandPeriodSales > 0) || !(userSales > 0)) continue

      // quantity per KD of the brand's own sales, over this period's own days
      const rate = brandQtyPeriod / brandPeriodSales
      const periodProductQty = userSales * rate

      /*
       * Weights across the period's thirty days.
       *
       * Every day of the period is a day the branch is open, so these are the
       * brand's own daily shape divided by its own total - summing to 1, which
       * is what makes the daily figures add back to the period figure.
       */
      const open = inWindow.map((d) => ({ d, q: perDay.get(`${key}|${d.date}`) ?? 0 }))
      const openTotal = open.reduce((a, b) => a + b.q, 0)
      if (!(openTotal > 0)) continue

      const exact = open.map((o) => periodProductQty * (o.q / openTotal))
      const rounded = largestRemainder(exact, periodProductQty)

      if (periodProductQty > 0) hadQty.add(key)

      /*
       * What a row carries, and what it deliberately does not.
       *
       * Brand, Branch and Opening_Date were identical on all 25,774 rows and
       * now sit once on the envelope. Period_Days, Brand_Avg_Daily_Qty and
       * Period_Sales_KD were each derivable from something the envelope
       * already holds - the period number, `branches`, and `periods[]` - so
       * the page derives them rather than the wire repeating them. The floats
       * are rounded to more precision than anything displays, which costs
       * nothing and saved about forty bytes a row against JavaScript's
       * seventeen-digit default.
       */
      open.forEach((o, k) => {
        if (!rounded[k]) return
        hadRow.add(key)
        rows.push({
          Forecast_Date: o.d.date,
          Opening_Day: o.d.day,
          Period: p.period,
          Product: item.product,
          // The row's OWN PLU - this is the grain, not a label on it.
          Product_PLU: item.plu,
          Brand_Daily_Qty: round(o.q, 3),
          Daily_Weight_Pct: round(o.q / openTotal, 8),
          Incident_Rate: round(rate, 10),
          /*
           * Six places, not four. `largestRemainder` ran on the UNROUNDED
           * quantity, and the page checks the daily figures against
           * Math.round() of this one - so the wire value has to be far enough
           * from a .5 boundary that trimming it can never flip that rounding.
           */
          Period_Product_Qty: round(periodProductQty, 6),
          Daily_Product_Qty: rounded[k],
        })
      })
      periodQty += periodProductQty
    }

    /*
     * What the dropped products would have been worth, as a share of the
     * brand's own quantity. Stated so the page can say that the forecast
     * covers less than the typed target rather than letting it look complete.
     */
    const keptQty = [...items.keys()].reduce((a, k) => a + (perPeriod.get(`${k}|${p.period}`) ?? 0), 0)
    const goneQty = excludedQty.get(p.period) ?? 0
    const share = keptQty + goneQty > 0 ? keptQty / (keptQty + goneQty) : 1
    periodSummary.push({
      period: p.period,
      from: p.from,
      to: p.to,
      days: inWindow.length,
      covered,
      status,
      available: true,
      sales: userSales,
      brandSales: brandPeriodSales,
      productQty: periodQty,
      keptShare: share,
      impliedSales: userSales * share,
      excludedQty: goneQty,
      reason: null,
    })
  })

  /*
   * What rounding at PLU grain costs, measured rather than asserted.
   *
   * `exact` is what the arithmetic produced before whole units were allocated;
   * `whole` is what the branch will actually be told to prepare. At product
   * grain the two differed by a few units in a hundred thousand. At PLU grain
   * the gap can only widen, because a product's quantity is now split over its
   * codes before each is rounded - so a PLU carrying under half a unit a day
   * rounds to nothing where the product would have kept it.
   *
   * Returned so the page can state it. A forecast that quietly loses units is
   * worse than one that says how many it lost.
   */
  const exactTotal = periodSummary.reduce((a, p) => a + (p.productQty ?? 0), 0)
  const wholeTotal = rows.reduce((a, r) => a + r.Daily_Product_Qty, 0)
  /*
   * PLUs that were given a quantity and ended up with no whole unit anywhere.
   *
   * `hadQty` and `hadRow` are filled in the loop above rather than derived
   * here. Deriving it was a filter over 621 PLUs with a `.some()` over 25,774
   * rows inside it - sixteen million string comparisons on every request, to
   * produce one integer. It also counted the wrong thing: a PLU the brand
   * simply does not sell in the window has no row either, and that is absence,
   * not rounding.
   */
  const zeroedCount = [...hadQty].filter((k) => !hadRow.has(k)).length

  /*
   * Availability now means coverage, not "the query returned something".
   *
   * `available` is true only where at least one period is fully backed, so a
   * window with nothing usable cannot present itself as a forecast. Each
   * period carries its own status besides, because the common case while the
   * 2027 spine is missing is one good month followed by two that are not.
   */
  const usable = periodSummary.filter((p) => p.available)
  const lastCovered = [...coveredDates].sort().pop() ?? null

  return {
    brand: brand.code,
    branchName,
    openingDate: win.from,
    window: win,
    branches,
    periods: periodSummary,
    rows,
    products: [...products].sort(),
    /** The forecast's grain, so the page never has to guess at it. */
    grain: 'plu',
    items: items.size,
    /** Hoisted off every row - they were identical on all of them. */
    row: { Brand: brand.code, Branch: branchName, Opening_Date: win.from },
    coverage: {
      complete: usable.length,
      partial: periodSummary.filter((p) => p.status === 'partial').length,
      none: periodSummary.filter((p) => p.status === 'none').length,
      lastCovered,
    },
    rounding: {
      exact: exactTotal,
      whole: wholeTotal,
      lost: exactTotal - wholeTotal,
      zeroed: zeroedCount,
    },
    // product -> [{ plu, qty }], busiest first, so the page can list every PLU
    // behind a product rather than only the one shown in the cell.
    plus: Object.fromEntries([...plusOf].filter(([p]) => products.has(p))),
    available: usable.length > 0,
    reason:
      usable.length > 0
        ? null
        : `No month in ${win.from} to ${win.to} has a complete product forecast behind it` +
          (lastCovered ? `; the forecast data stops at ${lastCovered}` : '') +
          '. Nothing has been substituted from another year or extrapolated.',
  }
}

/** Every product the brand forecasts in a window, for the exclusion picker. */
export async function newStoreProducts({ brand: brandCode, openingDate } = {}) {
  const brand = (config.brands ?? []).find(
    (b) => b.code === String(brandCode).toUpperCase() && b.datasetId
  )
  if (!brand || !openingDate) return []
  const win = windowFor(openingDate)
  const rows = await brandDaily(brand, win.from, win.to)
  const out = new Set()
  for (const r of rows) {
    const p = String(val(r, 'Forecast_Product_Table[ProductName_Fixed_Option]') ?? '').trim()
    if (p && Number(val(r, 'Qty')) > 0) out.add(p)
  }
  return [...out].sort()
}
