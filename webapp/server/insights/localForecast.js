/**
 * The locally built product forecast — Power BI's method, computed here.
 *
 * WHY THIS EXISTS
 *
 * `Forecast_Product_Table` is a calculated table in each brand's semantic
 * model: every active item x location combination crossed with every forecast
 * date, carrying eighteen DAX columns. Extending it into 2027 is what the
 * brands cannot afford — the models are already at their memory ceiling, and
 * BBT (which did extend) shows what it buys: 299,274 rows a month of zeros
 * from July 2027 onward, because the RATE runs out before the rows do.
 *
 * THE METHOD, READ OUT OF THE MODELS THEMSELVES
 *
 * From `Forecast_Product_Table.tmdl` and `Forecast_Spine.tmdl`:
 *
 *   Forecast_Qty_7(last 28+2) = ROUND([Incidence Rate Final] * [Forecast_Orders], 0)
 *   Forecast_Orders           = DIVIDE([Total_Sales], [AOV], 0)
 *   Total_Sales               = MAX('FORECAST (2)'[Totalsale])   -- future dates
 *   AOV                       = mean Daily_AOV of the 3 most recent dates
 *                               sharing this date's weekday, before it
 *   Incidence Rate Final      = Forecast_Spine[Forecasted_Incidence_Rate],
 *                               but only where the item sold in the last 3 days
 *
 * THE OBSERVATION THAT MAKES THIS CHEAP
 *
 * `Forecasted_Incidence_Rate` is a long calculation — a 28-day rolling rate
 * weighted by EXP(-0.08 * age), blended with a weekday memory of 0.7 x last
 * week and 0.3 x the week before, the blend weighted by how often the item
 * sells, and overridden entirely by the last-7-day rate when the two differ by
 * more than 20%. But every one of those parts anchors on the ITEM'S LAST
 * ACTUAL DATE. The only way the forecast date enters is `WEEKDAY(_spineDate, 2)`.
 *
 * So a combination has SEVEN rates, not one per day. Measured on CHP across
 * 40,000 spine rows: 1,909 item-location-weekday groups, every single one
 * holding exactly one rate; at most 7 distinct rates per item-location.
 *
 * The same collapse applies to AOV. For any future date every actual lies
 * before it, so "the 3 most recent same-weekday dates before this one" is the
 * same three dates for every future Wednesday. Reproduced against Power BI's
 * own AOV column for 10 March 2027 across all 15 BBT branches: exact to the
 * fourth decimal, every branch.
 *
 * Hence: store the rates (combos x 7) and the branch-days, and compute the
 * quantity on read. A year for one brand is tens of thousands of rows rather
 * than millions, and extending the horizon costs nothing, because the rate
 * table does not grow with the calendar.
 *
 * PROVEN, NOT ASSUMED
 *
 * Rebuilt BBT's 10 March 2027 forecast from these three inputs and compared
 * against the figure Power BI itself holds for that date: 3,348 rows compared,
 * 3,348 exact matches, none off even by rounding. See `verifyAgainstPowerBI`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not invent a horizon. `Forecast_Spine` is built as `TODAY() + 210`,
 * so rates exist to 14 June 2027 and no further. Past that the rate is absent
 * and this returns NOTHING for that date rather than holding the last rate
 * flat — an extrapolation nobody has sanctioned, on numbers people order
 * stock against. When the spine is widened in Power BI, re-running the extract
 * picks the new dates up with no change here.
 */
import { pg } from '../db/accounts.js'
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'

/* ---------------------------------------------------------------- pure bits */

/** WEEKDAY(date, 2): 1 = Monday .. 7 = Sunday, matching the DAX. */
export function weekday(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  const js = d.getUTCDay() // 0 = Sunday
  return js === 0 ? 7 : js
}

/**
 * Mean `Daily_AOV` over the three most recent dates sharing `on`'s weekday.
 *
 * `history` is [{ date, aov }] for ONE location. Strictly before `on`, matching
 * the DAX's `< _currentDate`. Fewer than three is not an error — the model
 * divides by however many it found — but none at all is, and returns null so
 * the caller can refuse the row rather than divide by zero.
 */
export function aovFrom(history, on) {
  const want = weekday(on)
  if (!want || !Array.isArray(history)) return null
  const picks = history
    .filter((r) => r.date < on && weekday(r.date) === want && Number.isFinite(Number(r.aov)))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 3)
  if (!picks.length) return null
  return picks.reduce((s, r) => s + Number(r.aov), 0) / picks.length
}

/**
 * `DIVIDE([Total_Sales], [AOV], 0)` — DAX DIVIDE, so a zero or absent divisor
 * yields the fallback rather than an error or an infinity.
 */
export function ordersFrom(totalSales, aov) {
  const s = Number(totalSales)
  const a = Number(aov)
  if (!Number.isFinite(s) || !Number.isFinite(a) || a === 0) return 0
  return s / a
}

/** `ROUND([Incidence Rate Final] * [Forecast_Orders], 0)`. */
export function forecastQty(rate, orders) {
  /*
   * Checked before coercion, because Number(null) is 0 and 0 is finite — so a
   * missing rate would otherwise pass straight through as a forecast of none.
   * Past the spine there IS no rate, and "no answer" must not read as "zero".
   */
  if (rate === null || rate === undefined) return null
  if (orders === null || orders === undefined) return null
  const r = Number(rate)
  const o = Number(orders)
  if (!Number.isFinite(r) || !Number.isFinite(o)) return null
  /*
   * DAX ROUND is half-away-from-zero; JavaScript's Math.round is half-UP, so
   * they part company on exact negative halves. Rates are never negative here,
   * but the forecast is the thing people order against and a function that is
   * right only for the inputs it happens to get is a trap for the next reader.
   */
  const v = r * o
  return Math.sign(v) * Math.round(Math.abs(v))
}

/** Every date in [from, to], inclusive. */
export function datesBetween(from, to) {
  const out = []
  let cur = String(from).slice(0, 10)
  const end = String(to).slice(0, 10)
  let guard = 0
  while (cur <= end && guard < 4000) {
    out.push(cur)
    const d = new Date(`${cur}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    cur = d.toISOString().slice(0, 10)
    guard += 1
  }
  return out
}

/* ------------------------------------------------------------- the extract */

const val = (r, k) => {
  if (!r) return undefined
  for (const cand of [k, `[${k}]`]) if (r[cand] !== undefined) return r[cand]
  const want = String(k).toLowerCase()
  for (const key of Object.keys(r)) {
    const bare = String(key).match(/\[([^\]]+)\]\s*$/)
    if ((bare ? bare[1] : key).toLowerCase() === want) return r[key]
  }
  return undefined
}

const daxDate = (d) =>
  `DATE(${String(d).slice(0, 4)}, ${Number(String(d).slice(5, 7))}, ${Number(String(d).slice(8, 10))})`

const lit = (s) => `"${String(s).replace(/"/g, '""')}"`

const brandOf = (code) =>
  (config.brands ?? []).find((b) => b.code === String(code).toUpperCase() && b.datasetId)

/**
 * The chain filter.
 *
 * SLC shares a dataset with BUR, and MM with TBL. Without this both brands of
 * a pair return each other's rows — the same fault that once made MM and TBL
 * report identical figures in every month.
 */
const chainOf = (brand) => brand.chain ?? brand.code

/**
 * Run the first of several candidate queries that the model accepts.
 *
 * THE MODELS ARE NOT CONSISTENT WITH EACH OTHER, and discovering that one at a
 * time is how this gets fragile. Measured across the nine brands:
 *
 *   AOV_Table's chain column   BBT, CHP, PAT, SLC, BUR carry CHAINID
 *                              YP, MM, TBL carry Brand
 *   the product name column    SS calls it ProductName
 *                              every other brand ProductName_Fixed_Option
 *
 * A per-brand lookup table would encode today's shape and quietly rot the next
 * time somebody renames a column. Trying the alternatives in order does not,
 * and a brand where none works raises rather than returning something emptier
 * but plausible.
 */
async function firstThatWorks(brand, label, candidates) {
  let lastErr = null
  for (const { dax } of candidates) {
    try {
      // `bulk`, so the 90-second extract deadline applies rather than the 8
      // seconds meant for a page waiting on a reader.
      return await executeQuery(dax, brand.datasetId, { bulk: true })
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `${brand.code}: no usable ${label} query (${String(lastErr?.message ?? '').slice(0, 140)})`
  )
}

/** The spine's rates, already collapsed to their real grain. */
async function spineRates(brand) {
  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(
  Forecast_Spine[CleanNewItemID],
  Forecast_Spine[CleanLocationID],
  Forecast_Spine[CHAINID],
  Forecast_Spine[DOW],
  FILTER(ALL(Forecast_Spine[CHAINID]), Forecast_Spine[CHAINID] = ${lit(chainOf(brand))}),
  "rate", MAX(Forecast_Spine[Forecasted_Incidence_Rate])
)`,
    brand.datasetId,
    /*
     * `bulk`, which is 90 seconds rather than 8.
     *
     * This is the single heaviest query of the extract - it groups the whole
     * spine, which is two million rows for BBT - and it measured 4.6s for TBL,
     * 6.8s for PAT and 7.9s for SS. The ordinary 8-second deadline is meant
     * for a page with somebody waiting on it, and BBT, YP and MM all blew
     * straight through it and failed the build.
     */
    { bulk: true }
  )
  return rows ?? []
}

/** The window the spine actually covers, so the horizon is reported not guessed. */
async function spineWindow(brand) {
  const rows = await executeQuery(
    `EVALUATE ROW(
  "lo", MIN(Forecast_Spine[Date]),
  "hi", CALCULATE(MAX(Forecast_Spine[Date]),
    FILTER(Forecast_Spine, Forecast_Spine[Forecasted_Incidence_Rate] > 0))
)`,
    brand.datasetId,
    { bulk: true }
  )
  const r = rows?.[0] ?? {}
  return {
    from: String(val(r, 'lo') ?? '').slice(0, 10) || null,
    to: String(val(r, 'hi') ?? '').slice(0, 10) || null,
  }
}

/** Product names live on the incidence table, as `Forecast_Product_Table` reads them. */
async function productNames(brand) {
  /* SS calls this column ProductName; every other brand ProductName_Fixed_Option. */
  const rows = await firstThatWorks(
    brand,
    'product name',
    ['ProductName_Fixed_Option', 'ProductName'].map((col) => ({
      dax: `EVALUATE
SUMMARIZECOLUMNS(
  Incidence_Table[CleanNewItemID],
  Incidence_Table[CleanLocationID],
  FILTER(ALL(Incidence_Table[CHAINID]), Incidence_Table[CHAINID] = ${lit(chainOf(brand))}),
  "product", MAX(Incidence_Table[${col}])
)`,
    }))
  )
  const out = new Map()
  for (const r of rows ?? []) {
    out.set(
      `${String(val(r, 'CleanNewItemID') ?? '')}|${String(val(r, 'CleanLocationID') ?? '')}`,
      String(val(r, 'product') ?? '')
    )
  }
  return out
}

/**
 * Daily AOV history per branch — the three-same-weekday lookup's raw material.
 *
 * FILTERED BY CHAIN, WHICH IS NOT OPTIONAL
 *
 * SLC shares a dataset with BUR, and MM with TBL, and they share BRANCH CODES
 * too: MM and TBL both trade as MHB, ARD, SAL, JHR and KHR, and SLC and BUR
 * both as YRD. Reading AOV by location alone therefore mixes two chains'
 * takings at seven branches, and because the fold takes MAX(Daily_AOV) per
 * location-date it would quietly pick whichever chain took more that day.
 * AOV is the divisor for orders, so every quantity at those branches would be
 * wrong — and wrong in a way nothing on screen would reveal.
 *
 * The column naming is NOT consistent across the models: BBT and SLC carry
 * `CHAINID`, MM carries `Brand`. Rather than keep a per-brand map that the
 * next model to change would silently invalidate, this tries one and falls
 * back to the other, and refuses to continue unfiltered if neither works.
 */
async function aovHistory(brand) {
  const queryWith = (column) => `EVALUATE
SELECTCOLUMNS(
  SUMMARIZE(
    FILTER(ALL(AOV_Table), AOV_Table[${column}] = ${lit(chainOf(brand))}),
    AOV_Table[LOCATIONID], AOV_Table[VOUCHERDATE],
    "d", MAX(AOV_Table[Daily_AOV])),
  "loc", AOV_Table[LOCATIONID], "date", AOV_Table[VOUCHERDATE], "aov", [d])`

  /*
   * Deliberately NO unfiltered fallback. That query would succeed and return
   * plausible numbers, which is exactly why having it would be dangerous.
   */
  const rows = await firstThatWorks(
    brand,
    'AOV chain filter',
    ['CHAINID', 'Brand'].map((col) => ({ dax: queryWith(col) }))
  )
  const byLoc = new Map()
  for (const r of rows ?? []) {
    const loc = String(val(r, 'loc') ?? '').trim()
    const date = String(val(r, 'date') ?? '').slice(0, 10)
    const aov = Number(val(r, 'aov'))
    if (!loc || !date || !Number.isFinite(aov)) continue
    if (!byLoc.has(loc)) byLoc.set(loc, [])
    byLoc.get(loc).push({ date, aov })
  }
  return byLoc
}

/** The sales plan per branch-day — the only input that varies with the date. */
async function salesPlan(brand, from, to) {
  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(
  'FORECAST (2)'[BRANCH],
  'FORECAST (2)'[DATE],
  FILTER(ALL('FORECAST (2)'[BRAND]), 'FORECAST (2)'[BRAND] = ${lit(chainOf(brand))}),
  FILTER(ALL('FORECAST (2)'[DATE]),
    'FORECAST (2)'[DATE] >= ${daxDate(from)} && 'FORECAST (2)'[DATE] <= ${daxDate(to)}),
  "ts", MAX('FORECAST (2)'[Totalsale])
)`,
    brand.datasetId,
    { bulk: true }
  )
  return rows ?? []
}

/* ---------------------------------------------------------------- building */

/**
 * Extract one brand's inputs and store them.
 *
 * Returns what it found rather than only writing, so the admin page can report
 * the horizon without a second read.
 */
export async function buildLocalForecast(brandCode, { from, to } = {}) {
  const brand = brandOf(brandCode)
  if (!brand) throw new Error(`Unknown brand: ${brandCode}`)

  const window = await spineWindow(brand)
  /*
   * Default to exactly what the spine can answer for. Asking beyond it is not
   * refused outright — a caller may legitimately want the sales side stored
   * ahead of a spine widening — but no rate means no row, so nothing is
   * fabricated for those dates either way.
   */
  const salesFrom = String(from ?? window.from ?? '').slice(0, 10)
  const salesTo = String(to ?? window.to ?? '').slice(0, 10)
  if (!salesFrom || !salesTo) {
    throw new Error(`${brand.code}: the forecast spine holds no dated rates to build from`)
  }

  const [rates, names, aovByLoc, sales] = await Promise.all([
    spineRates(brand),
    productNames(brand),
    aovHistory(brand),
    salesPlan(brand, salesFrom, salesTo),
  ])

  /* --- rates --- */
  const rateRows = []
  const combos = new Set()
  for (const r of rates ?? []) {
    const plu = String(val(r, 'CleanNewItemID') ?? '').trim()
    const loc = String(val(r, 'CleanLocationID') ?? '').trim()
    const dow = Number(val(r, 'DOW'))
    const rate = Number(val(r, 'rate'))
    if (!plu || !loc || !(dow >= 1 && dow <= 7)) continue
    if (!Number.isFinite(rate) || rate <= 0) continue
    combos.add(`${plu}|${loc}`)
    rateRows.push([
      brand.code,
      chainOf(brand),
      loc,
      plu,
      names.get(`${plu}|${loc}`) ?? '',
      dow,
      rate,
    ])
  }

  /* --- branch-days --- */
  const orderRows = []
  for (const r of sales ?? []) {
    const loc = String(val(r, 'BRANCH') ?? '').trim()
    const date = String(val(r, 'DATE') ?? '').slice(0, 10)
    const ts = Number(val(r, 'ts'))
    if (!loc || !date || !Number.isFinite(ts)) continue
    const aov = aovFrom(aovByLoc.get(loc) ?? [], date)
    orderRows.push([brand.code, loc, date, ts, aov, aov === null ? null : ordersFrom(ts, aov)])
  }

  await pg.run('DELETE FROM local_forecast_rate WHERE brand = ?', [brand.code])
  await pg.run('DELETE FROM local_forecast_orders WHERE brand = ? AND date >= ? AND date <= ?', [
    brand.code,
    salesFrom,
    salesTo,
  ])
  await insertMany(
    'local_forecast_rate',
    ['brand', 'chain', 'location', 'plu', 'product', 'dow', 'rate'],
    rateRows
  )
  await insertMany(
    'local_forecast_orders',
    ['brand', 'location', 'date', 'total_sales', 'aov', 'orders'],
    orderRows
  )

  const meta = {
    brand: brand.code,
    built_at: new Date().toISOString(),
    rate_from: window.from,
    rate_to: window.to,
    sales_from: salesFrom,
    sales_to: salesTo,
    combos: combos.size,
    rate_rows: rateRows.length,
    order_rows: orderRows.length,
    note: '',
  }
  await pg.run(
    `INSERT INTO local_forecast_meta
       (brand, built_at, rate_from, rate_to, sales_from, sales_to, combos, rate_rows, order_rows, note)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (brand) DO UPDATE SET
       built_at = EXCLUDED.built_at, rate_from = EXCLUDED.rate_from, rate_to = EXCLUDED.rate_to,
       sales_from = EXCLUDED.sales_from, sales_to = EXCLUDED.sales_to, combos = EXCLUDED.combos,
       rate_rows = EXCLUDED.rate_rows, order_rows = EXCLUDED.order_rows, note = EXCLUDED.note`,
    [
      meta.brand, meta.built_at, meta.rate_from, meta.rate_to, meta.sales_from,
      meta.sales_to, meta.combos, meta.rate_rows, meta.order_rows, meta.note,
    ]
  )
  return meta
}

/**
 * Build every brand that is missing or stale — the scheduled entry point.
 *
 * WHY THIS IS SCHEDULED RATHER THAN ASKED FOR
 *
 * The forecast has to be sitting in the database before anybody opens a page,
 * for two reasons. A reader changing a filter cannot wait minutes for seven
 * datasets to be re-extracted; and the pages that consume these quantities -
 * the new-store forecast today, others later - read the table directly and
 * have no sensible behaviour if it is empty.
 *
 * WHY DAILY
 *
 * Both halves of the forecast move every day. `Forecast_Spine` is rebuilt as
 * `TODAY() + 210`, so the horizon slides forward one day at a time, and every
 * rate re-anchors on the item's last actual date, so yesterday's trading
 * changes today's answer. A rebuild older than about a day is answering with
 * a stale anchor.
 *
 * Sequential, and one brand's failure never stops the others: a dataset that
 * is throttled or mid-refresh should cost that brand's figures, not all nine.
 */
export async function buildAllLocalForecasts({ force = false, maxAgeHours = 20 } = {}) {
  const codes = (config.brands ?? []).filter((b) => b.datasetId).map((b) => b.code)
  const fresh = new Map()
  if (!force) {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString()
    for (const r of await pg.all(
      'SELECT brand, built_at FROM local_forecast_meta WHERE built_at > ? AND rate_rows > 0',
      [cutoff]
    )) {
      fresh.set(r.brand, r.built_at)
    }
  }

  const built = []
  const failed = []
  const skipped = []
  for (const code of codes) {
    if (fresh.has(code)) {
      skipped.push(code)
      continue
    }
    try {
      built.push(await buildLocalForecast(code))
    } catch (err) {
      failed.push({ brand: code, error: String(err.message).slice(0, 200) })
    }
  }
  if (built.length || failed.length) {
    console.log(
      `  [local forecast] built ${built.length}` +
        `${skipped.length ? `, ${skipped.length} still fresh` : ''}` +
        `${failed.length ? `, ${failed.length} FAILED: ${failed.map((f) => `${f.brand} (${f.error})`).join('; ')}` : ''}`
    )
  }
  return { built, failed, skipped }
}

/** Chunked multi-row insert — PGlite takes a bounded number of parameters. */
async function insertMany(table, cols, rows, chunk = 500) {
  if (!rows.length) return
  const names = cols.join(', ')
  const tuple = `(${cols.map(() => '?').join(', ')})`
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const params = []
    for (const row of slice) params.push(...row)
    await pg.run(
      `INSERT INTO ${table} (${names}) VALUES ${slice.map(() => tuple).join(', ')} ` +
        `ON CONFLICT DO NOTHING`,
      params
    )
  }
}

/* ----------------------------------------------------------------- reading */

/**
 * The generated rows, at `Forecast_Product_Table`'s own grain.
 *
 * A date with no stored rate produces NO row, which is why this is safe to
 * read past the spine: the horizon enforces itself. `brands` and `locations`
 * are the page's filters; both are optional and both are inclusive lists.
 */
export async function localForecastRows({
  brands = [],
  locations = [],
  from,
  to,
  limit = 5000,
  offset = 0,
} = {}) {
  const where = ['o.date >= ?', 'o.date <= ?']
  const params = [String(from).slice(0, 10), String(to).slice(0, 10)]
  /*
   * The page's two filters. Both are inclusive lists and both are optional, so
   * an unfiltered read is the same query with two fewer clauses rather than a
   * second code path.
   */
  if (brands.length) {
    where.push(`r.brand IN (${brands.map(() => '?').join(', ')})`)
    params.push(...brands)
  }
  if (locations.length) {
    where.push(`r.location IN (${locations.map(() => '?').join(', ')})`)
    params.push(...locations)
  }

  /*
   * The join IS the cross product the Power BI table materialises — but it is
   * produced for the dates asked for and nothing else, which is the whole
   * saving. `dow` is computed in SQL so the rate lands on its own weekdays.
   */
  return pg.all(
    `SELECT r.brand, r.chain, r.location, r.plu, r.product, o.date,
            r.rate, o.total_sales, o.aov, o.orders,
            ROUND((r.rate * o.orders)::numeric, 0) AS qty
       FROM local_forecast_orders o
       JOIN local_forecast_rate  r
         ON r.brand = o.brand AND r.location = o.location
        -- ISODOW is 1 = Monday .. 7 = Sunday, which is exactly WEEKDAY(date, 2).
        AND r.dow = EXTRACT(ISODOW FROM o.date::date)
      WHERE ${where.join(' AND ')}
        AND o.orders IS NOT NULL
      ORDER BY o.date, r.location, r.plu
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )
}

/**
 * One brand's daily product quantities, in the shape `newStore` already folds.
 *
 * Brand-wide: the quantities are summed across branches, because that is the
 * grain the new-store forecast reads — it scales a brand curve to a branch
 * that does not exist yet, so a per-branch split would be meaningless here.
 *
 * `dates` is the specific days wanted rather than a range. The caller passes
 * only the days Power BI could not answer for, which is what keeps the two
 * sources from ever both contributing to the same day.
 */
export async function localDailyFor(brandCode, dates) {
  const brand = brandOf(brandCode)
  if (!brand || !dates?.length) return []
  return pg.all(
    `SELECT o.date                             AS "Forecast_Product_Table[Date]",
            r.product                          AS "Forecast_Product_Table[ProductName_Fixed_Option]",
            r.plu                              AS "Forecast_Product_Table[Clean_ItemID]",
            SUM(ROUND((r.rate * o.orders)::numeric, 0)) AS "[Qty]"
       FROM local_forecast_orders o
       JOIN local_forecast_rate  r
         ON r.brand = o.brand AND r.location = o.location
        AND r.dow = EXTRACT(ISODOW FROM o.date::date)
      WHERE o.brand = ?
        AND o.date IN (${dates.map(() => '?').join(', ')})
        AND o.orders IS NOT NULL
      GROUP BY o.date, r.product, r.plu
     HAVING SUM(ROUND((r.rate * o.orders)::numeric, 0)) > 0`,
    [brand.code, ...dates]
  )
}

/** Which of `dates` the local copy can actually answer for. */
export async function localCoverage(brandCode, dates) {
  const brand = brandOf(brandCode)
  if (!brand || !dates?.length) return new Set()
  const rows = await pg.all(
    `SELECT DISTINCT o.date
       FROM local_forecast_orders o
       JOIN local_forecast_rate r
         ON r.brand = o.brand AND r.location = o.location
        AND r.dow = EXTRACT(ISODOW FROM o.date::date)
      WHERE o.brand = ?
        AND o.date IN (${dates.map(() => '?').join(', ')})
        AND o.orders IS NOT NULL`,
    [brand.code, ...dates]
  )
  return new Set(rows.map((r) => String(r.date).slice(0, 10)))
}

/** The brands built, and how far each reaches — the admin page's status strip. */
export async function localForecastStatus() {
  return pg.all('SELECT * FROM local_forecast_meta ORDER BY brand')
}

/** Branches available to filter by, per brand. */
export async function localForecastBranches() {
  return pg.all(
    'SELECT DISTINCT brand, location FROM local_forecast_rate ORDER BY brand, location'
  )
}

/**
 * Score the local build against Power BI for one date.
 *
 * Kept in the module rather than a scratch script because it is the only thing
 * that justifies the table existing, and it should be re-runnable whenever the
 * upstream model changes.
 */
export async function verifyAgainstPowerBI(brandCode, date) {
  const brand = brandOf(brandCode)
  if (!brand) throw new Error(`Unknown brand: ${brandCode}`)
  const theirs = await executeQuery(
    `EVALUATE
SELECTCOLUMNS(
  FILTER(Forecast_Product_Table, Forecast_Product_Table[Date] = ${daxDate(date)}),
  "plu", Forecast_Product_Table[Clean_ItemID],
  "loc", Forecast_Product_Table[LocationID],
  "qty", Forecast_Product_Table[Forecast_Qty_7(last 28+2)])`,
    brand.datasetId
  )
  const mine = new Map()
  for (const r of await localForecastRows({
    brands: [brand.code],
    from: date,
    to: date,
    limit: 1_000_000,
  })) {
    mine.set(`${r.plu}|${r.location}`, Number(r.qty))
  }

  let compared = 0
  let exact = 0
  let off = 0
  let absent = 0
  for (const r of theirs ?? []) {
    const pbi = Number(val(r, 'qty'))
    if (!Number.isFinite(pbi) || pbi === 0) continue
    const k = `${String(val(r, 'plu') ?? '')}|${String(val(r, 'loc') ?? '')}`
    if (!mine.has(k)) { absent += 1; continue }
    compared += 1
    if (mine.get(k) === pbi) exact += 1
    else off += 1
  }
  return { brand: brand.code, date, compared, exact, off, absent }
}
