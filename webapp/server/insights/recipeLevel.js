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
 * Grouped by PATH as well as article, at every level, so each line can be
 * placed (`paScope.js`) and the ones inside a PA's recipe left out. MM, the
 * largest brand, returns about 20,000 rows a month and answers in seconds.
 */
const queryFor = (brand, from, to) => `EVALUATE
SUMMARIZECOLUMNS(
  'RECIPE TABLE'[Item No.],
  'RECIPE TABLE'[Recipe Path],${chainFilter(brand)}
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
  return cached(
    // "stoppa", not "level1": a figure cached under the old rule must not be served for the new one.
    `stoppa:${brand.code}:${from}:${to}`,
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

/** One calendar month, under the same key a one-month window would use. */
const readMonth = (brand, month) => {
  const from = `${String(month).slice(0, 7)}-01`
  return readWindow(brand, from, lastOfMonth(from))
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
    if (!months) return await readWindow(brand, from, to)
    const parts = await Promise.all(months.map((m) => readMonth(brand, m)))
    const out = new Map()
    for (const part of parts) {
      for (const [article, qty] of part) out.set(article, (out.get(article) ?? 0) + qty)
    }
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
