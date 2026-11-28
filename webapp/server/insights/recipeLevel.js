/**
 * PM theoretical for the Variance Analysis page: STOP AT PA.
 *
 * CHANGED 22 Nov 2026, on request: the page now counts Level 1 lines AND the
 * lines inside PREP sub-recipes, stopping at PA articles - see `paScope.js`
 * for the rule, why it was chosen and how each line is placed. The query
 * below groups by recipe path as well as article so every line can be placed;
 * nothing in the recipe file or the models changed.
 *
 * The exported names still say "level1" so the route does not change; what
 * they return is the stop-at-PA figure.
 *
 * THE ORIGINAL RULE, kept for the record. Added 15 Nov 2026, on request, for
 * the Article-Level Variance Reconciliation page and that page ALONE:
 *
 *   "Only Level 1 articles should be considered as articles supplied directly
 *    to brands... Please update the logic on this page only."
 *
 * WHY THIS IS NOT A FILTER ON THE EXISTING FIGURES
 *
 * `'RECIPE TABLE'[Level]` is a property of a recipe LINE, not of an article.
 * Measured 15 Nov 2026 across the nine brands, 6,975 article-brands sit at more
 * than one level: the same article number is a Level 1 line in one recipe and a
 * Level 3 line inside a prep in another. So "Level 1 articles" cannot be
 * answered by keeping a list of articles - the quantity has to be re-summed
 * over the Level 1 lines only.
 *
 * Confirmed with the business on 15 Nov 2026, with both readings measured:
 *
 *   every level          72,289,419   100.0%   2,230 article-brands
 *   Level 1 LINES only   52,899,310    73.2%   1,215      <- chosen
 *   ever-Level-1 articles 67,975,560   94.0%   1,526
 *
 * WHY IT COMES FROM POWER BI RATHER THAN THE LOCAL COPY
 *
 * `cube_component_daily` carries recipe, item, article, BU and node type - but
 * not Level, so the copy simply cannot answer the question. Adding the column
 * means a schema change and a full re-extract of every brand, which changes a
 * table four other pages read from. Reading it from Power BI keeps the change
 * inside this page exactly as the request asks, and Power BI is the source the
 * copy is built from, so the figures are the same ones one step upstream.
 *
 * The cost is latency, which is why everything here is cached hard.
 */
import { executeQuery } from '../powerbi/client.js'
import { config } from '../config.js'
import { cached } from '../cache.js'
import { placerFor, countsTowardPm } from './paScope.js'
import { level1LinesFor } from './recipeLines.js'
import { salesFromSnowflake, snowflakeSales, canonPlu } from '../snowflake/foodicsSales.js'
import { CATERING_BRANCHES } from '../powerbi/consumption.js'
import { datedPm, daysOf } from './datedPm.js'

/** One hour. The recipe tree moves when the model is republished, not hourly. */
const TTL = 3600

const daxDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}

const lastOfMonth = (iso) => {
  const [y, m] = String(iso).slice(0, 7).split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/**
 * One article number, written one way.
 *
 * `'RECIPE TABLE'[Item No.]` is an integer in the semantic models and Oracle
 * writes it as text, so "0102000003" and "102000003" are one article written
 * two ways. The same rule `canonArticle` applies in `powerbi/consumption.js`,
 * repeated here rather than imported so this module has no opinion about
 * consumption.
 */
export function canonArticle(article) {
  const raw = String(article ?? '').trim()
  if (!raw) return ''
  const n = Number(raw)
  return Number.isFinite(n) ? String(n) : raw
}

/**
 * Read a column off a Power BI row whatever prefix it came back with.
 *
 * The client strips table prefixes from some results and not others, and a
 * lookup written one way silently returns undefined for the other - which on
 * the New Store page discarded every row and produced an empty page that
 * looked like missing data. Matched on the bare name, case-insensitively.
 */
const val = (r, name) => {
  const want = String(name).toLowerCase()
  for (const key of Object.keys(r)) {
    const bare = key.replace(/^.*\[/, '').replace(/\]$/, '').toLowerCase()
    if (bare === want) return r[key]
  }
  return undefined
}

/**
 * THE CHAIN FILTER IS NOT OPTIONAL.
 *
 * SLC shares a dataset with BUR, and MM with TBL. Without the CHAINID filter
 * both brands of a pair return the identical result and the quantity is
 * counted twice - measured 15 Nov 2026, that inflated a one-off extract from
 * 861 articles to 1,314.
 */
const chainFilter = (brand) =>
  brand?.chain ? `\n  TREATAS({"${brand.chain}"}, Forecast_Product_Table[CHAINID]),` : ''

/*
 * CATERING IS LEFT OUT OF PM AS WELL - 26 Nov 2026.
 *
 * MC's theoretical on this page has excluded the catering branch since 15 Nov
 * ("Dont consider branch CAT, for MC theoretical for any brands"), but PM kept
 * counting catering's sales, so the two sides covered different outlets. Measured
 * 26 Nov 2026 against MC: BUR November 89.4% -> 99.9%, PAT October 87.8% ->
 * 89.7%, PAT November 88.9% -> 91.0%; no brand lower. Only the theoretical is
 * affected; consumption is untouched, as on the MC side.
 */
const cateringFilter = () =>
  `\n  FILTER(ALL(Forecast_Product_Table[LocationID]), NOT (Forecast_Product_Table[LocationID] IN {${CATERING_BRANCHES.map(
    (b) => `"${String(b).replace(/"/g, '""')}"`
  ).join(', ')}})),`

/*
 * Grouped by PATH as well as article, at every level, so each line can be
 * placed (`paScope.js`) and the ones inside a PA's recipe left out. MM, the
 * largest brand, returns about 20,000 rows a month and answers in seconds.
 */
const queryFor = (brand, from, to) => `EVALUATE
SUMMARIZECOLUMNS(
  'RECIPE TABLE'[Item No.],
  'RECIPE TABLE'[Recipe Path],${chainFilter(brand)}${cateringFilter()}
  TREATAS(CALENDAR(${daxDate(from)}, ${daxDate(to)}), DateTable[Date]),
  "qty", [Component_Actual_Qty]
)`

/** Power BI drops rows past 100,000 without an error; an answer near it is not trusted. */
const NEAR_CAP = 95_000

const brandOf = (code) =>
  config.brands.find((b) => b.code.toUpperCase() === String(code).trim().toUpperCase()) ?? null

/**
 * Sum a result into `article -> qty`, keeping only the lines that count
 * (`place(path)`), and dropping the blanks and the zeroes.
 */
export function fold(rows, place) {
  const out = new Map()
  let ambiguous = 0
  for (const r of rows ?? []) {
    const article = canonArticle(val(r, 'Item No.'))
    if (!article) continue
    const qty = Number(val(r, 'qty')) || 0
    if (!qty) continue
    const where = place(val(r, 'Recipe Path'))
    if (where === 'AMBIGUOUS') ambiguous += 1
    if (!countsTowardPm(where)) continue
    out.set(article, (out.get(article) ?? 0) + qty)
  }
  if (ambiguous) console.warn(`  [level1] ${ambiguous} lines could not be placed and were left out`)
  return out
}

/**
 * The whole months a window covers, or null if it does not start on the 1st
 * and end on a month's last day.
 *
 * Capped at 36 months: past that a single window query is the cheaper ask.
 */
export function wholeMonthsOf(from, to) {
  const f = String(from ?? '').slice(0, 10)
  const t = String(to ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-01$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
  if (t !== lastOfMonth(t) || t < f) return null
  const out = []
  for (let m = f; m <= t; ) {
    out.push(m)
    if (out.length > 36) return null
    const [y, mo] = m.split('-').map(Number)
    m = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)
  }
  return out
}

/**
 * ONE read: a brand's Level 1 figure over one window, cached.
 *
 * Throws on failure rather than answering null, so a refused read is never
 * stored. It used to catch inside the cache and return null, and `cached`
 * kept that null for the full hour - one throttle at the wrong moment and the
 * brand silently showed unrestricted figures until the TTL ran out.
 */
function readWindow(brand, from, to) {
  if (salesFromSnowflake(brand.code)) return readWindowSnowflake(brand, from, to)
  return cached(
    // "stoppa-nocat": a figure cached before catering was left out must not be served.
    `stoppa-nocat:${brand.code}:${from}:${to}`,
    async () => {
      const [rows, place] = await Promise.all([
        executeQuery(queryFor(brand, from, to), brand.datasetId, {
          bulk: true,
          workspace: brand.workspaceId || undefined,
        }),
        placerFor(brand),
      ])
      if (rows.length >= NEAR_CAP) {
        throw new Error(`${rows.length} rows - at Power BI's row limit, so it may be cut short`)
      }
      const held = fold(rows, place)
      console.log(`  [level1] ${brand.code} ${from}..${to}: ${held.size} articles`)
      return held
    },
    { seconds: TTL }
  )
}

/**
 * BBT AND YELO: SALES FROM SNOWFLAKE - 25 Nov 2026, on request.
 *
 * Same figure, same rule, different source for one ingredient. The Power BI
 * measure above is SUMX over the recipe lines of QTY BU x the units whose
 * Clean_ItemID equals the line's Product PLU. Here the units come from
 * Snowflake (`snowflake/foodicsSales.js`, MAPPED_SKU = Clean_ItemID) and the
 * lines from the same recipe file, placed by the same stop-at-PA rule
 * (`recipeLines.js`). The branch tab has assembled PM this way since 17 Nov
 * 2026 and reproduced the measure to the gram for CHP, PAT and SS.
 *
 * What changes is the sales: Snowflake carries every completed line, PRODUCT
 * and OPTION, which is what MC itself receives; Power BI's BBT sales held the
 * OPTION lines only. See foodicsSales.js for the measurements.
 *
 * No fallback to Power BI: a Snowflake failure throws, and the caller reports
 * the brand as unavailable.
 */
function readWindowSnowflake(brand, from, to) {
  return cached(
    `stoppa-sf-nocat:${brand.code}:${from}:${to}`,
    async () => {
      const held = await pmFromSnowflake(brand, from, to)
      console.log(
        `  [level1-sf] ${brand.code} ${from}..${to}: ${held.size} articles; ` +
          `${Math.round(held.stats.unitsCosted)} of ${Math.round(held.stats.units)} units on a recipe PLU`
      )
      return held
    },
    { seconds: TTL }
  )
}

/**
 * PM per article from Snowflake sales x recipe-file lines. The Map carries a
 * `stats` property for the log and the validation: units sold, units on a
 * PLU with counting recipe lines, and how many PLUs had none.
 */
export async function pmFromSnowflake(brand, from, to) {
  const sales = await snowflakeSales(brand.code, from, to)
  const catering = new Set(CATERING_BRANCHES.map((b) => String(b).toUpperCase()))
  const byPlu = new Map()
  for (const s of sales.lines) {
    if (catering.has(String(s.branch).toUpperCase())) continue
    byPlu.set(s.plu, (byPlu.get(s.plu) ?? 0) + s.q)
  }
  const lines = await level1LinesFor(brand, new Set(byPlu.keys()))
  const out = assemblePm(byPlu, lines)
  let units = sales.unmapped.q
  for (const q of byPlu.values()) units += q
  out.stats = { ...out.stats, units, unmapped: sales.unmapped.q }
  return out
}

/**
 * The assembly, pure: `plu -> units` and recipe lines -> `article -> qty`.
 * Both sides are matched on the canonical PLU.
 */
export function assemblePm(byPlu, lines) {
  const linesByPlu = new Map()
  for (const l of lines ?? []) {
    const k = canonPlu(l.plu)
    const list = linesByPlu.get(k)
    if (list) list.push(l)
    else linesByPlu.set(k, [l])
  }
  const out = new Map()
  /** article -> { item, bu } from its recipe lines, for rows the page has to add. */
  const info = new Map()
  let unitsCosted = 0
  let plusWithout = 0
  for (const [plu, q] of byPlu) {
    const list = linesByPlu.get(canonPlu(plu))
    if (!list?.length) {
      plusWithout += 1
      continue
    }
    unitsCosted += q
    for (const l of list) {
      out.set(l.article, (out.get(l.article) ?? 0) + l.qty * q)
      if (!info.has(l.article)) info.set(l.article, { item: l.item, bu: l.bu })
    }
  }
  for (const [a, v] of out) if (!v) out.delete(a)
  out.stats = { unitsCosted, plusWithout }
  out.info = info
  return out
}

/**
 * A window with its PROVEN days costed from MC's captured recipe versions -
 * 26 Nov 2026 (`datedPm.js`) - and every other day by the method above, over
 * the same sales. The other days are read as contiguous runs through
 * `readWindow`, so each day is counted exactly once. Before the capture has
 * proven any day this is `readWindow` itself; a failure of the dated read
 * falls back to it too, and says so in the log.
 *
 * The result carries `.dated` = { days, units, costed, noProduct } when any
 * day came from captured versions.
 */
async function readDated(brand, from, to) {
  const dated = await datedPm(brand, from, to).catch((err) => {
    console.warn(`  [dated-pm] ${brand.code} ${from}..${to}: ${String(err.message).slice(0, 100)} - current method kept`)
    return null
  })
  if (!dated?.map) return readWindow(brand, from, to)
  const proven = new Set(dated.days.map((d) => d.day))
  const runs = []
  let start = null
  let prev = null
  for (const d of daysOf(from, to)) {
    if (proven.has(d)) {
      if (start) runs.push([start, prev])
      start = null
    } else if (!start) start = d
    prev = d
  }
  if (start) runs.push([start, prev])
  const parts = await Promise.all(runs.map(([f, t]) => readWindow(brand, f, t)))
  const out = new Map(dated.map)
  const info = new Map()
  for (const part of parts) {
    for (const [a, q] of part) out.set(a, (out.get(a) ?? 0) + q)
    for (const [a, v] of part.info ?? []) if (!info.has(a)) info.set(a, v)
  }
  if (info.size) out.info = info
  out.dated = { days: proven.size, ...dated.map.stats }
  return out
}

/** One calendar month, under the same key a one-month window would use. */
const readMonth = (brand, month) => {
  const from = `${String(month).slice(0, 7)}-01`
  return readDated(brand, from, lastOfMonth(from))
}

/**
 * Level 1 PM theoretical per article, for one brand over one window.
 *
 * A WINDOW OF WHOLE MONTHS IS THE SUM OF ITS MONTHS, and those months are the
 * ones the monthly trend has just read - so it is assembled from that cache
 * instead of asked for again. 18 Nov 2026: on the default 01 Mar - 31 Oct
 * view the separate window query was nine extra bulk queries (the slowest on
 * the page, 435 seconds of Power BI time in one load) for figures already in
 * hand. The measure is a sum over sales dates, so the months add up exactly.
 * A window that starts or ends mid-month still gets its own query.
 *
 * Returns null - never an empty map - when the read fails, so a caller can
 * tell "no Level 1 usage" from "we could not ask". Falling back to the
 * unfiltered figure on a failure would quietly restore the behaviour the
 * request removed, so callers refuse instead.
 */
export async function level1ByArticle(brandCode, { from, to }) {
  const brand = brandOf(brandCode)
  if (!brand?.datasetId || !from || !to) return null
  try {
    const months = wholeMonthsOf(from, to)
    if (!months) return await readDated(brand, from, to)
    const parts = await Promise.all(months.map((m) => readMonth(brand, m)))
    const out = new Map()
    const info = new Map()
    for (const part of parts) {
      for (const [article, qty] of part) out.set(article, (out.get(article) ?? 0) + qty)
      // Snowflake brands carry names and units; Power BI ones do not need them.
      for (const [a, v] of part.info ?? []) if (!info.has(a)) info.set(a, v)
    }
    if (info.size) out.info = info
    return out
  } catch (err) {
    console.warn(`  [level1] ${brand.code} ${from}..${to}: ${String(err.message).slice(0, 80)}`)
    return null
  }
}

/**
 * The same, a month at a time, for the monthly trend.
 *
 * ONE QUERY PER BRAND PER MONTH. `DateTable` carries nothing but `Date` -
 * verified against its own columns on 15 Nov 2026 - so there is no month
 * column to group on, and a daily grouping would return hundreds of thousands
 * of rows to be folded back up. Six narrow queries beat one enormous one.
 *
 * Each month is cached on its own (see `readMonth`), so moving the page's
 * date slicer does not re-fetch, and the window figure above reuses them.
 */
export async function level1ByArticleMonth(brandCode, months) {
  const brand = brandOf(brandCode)
  if (!brand?.datasetId || !months?.length) return null
  const out = new Map()
  let failed = 0
  await Promise.all(
    months.map(async (month) => {
      const held = await readMonth(brand, month).catch((err) => {
        failed += 1
        console.warn(`  [level1m] ${brand.code} ${month}: ${String(err.message).slice(0, 70)}`)
        return null
      })
      if (!held) return
      for (const [article, qty] of held) {
        let inner = out.get(article)
        if (!inner) {
          inner = new Map()
          out.set(article, inner)
        }
        inner.set(month, (inner.get(month) ?? 0) + qty)
      }
    })
  )
  // A partial answer is worse than none: months that failed would read as
  // months with no Level 1 usage, which is a different statement.
  if (failed) return null
  console.log(`  [level1m] ${brand.code}: ${out.size} articles over ${months.length} months`)
  return out
}
