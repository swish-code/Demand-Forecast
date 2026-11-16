/**
 * PM theoretical restricted to LEVEL 1 recipe lines.
 *
 * Added 15 Nov 2026, on request, for the Article-Level Variance Reconciliation
 * page and that page ALONE:
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

const LEVEL_1 = `\n  FILTER(ALL('RECIPE TABLE'[Level]), 'RECIPE TABLE'[Level] = 1),`

const queryFor = (brand, from, to) => `EVALUATE
SUMMARIZECOLUMNS(
  'RECIPE TABLE'[Item No.],${chainFilter(brand)}${LEVEL_1}
  TREATAS(CALENDAR(${daxDate(from)}, ${daxDate(to)}), DateTable[Date]),
  "qty", [Component_Actual_Qty]
)`

const brandOf = (code) =>
  config.brands.find((b) => b.code.toUpperCase() === String(code).trim().toUpperCase()) ?? null

/** Sum a result into `article -> qty`, dropping the blanks and the zeroes. */
function fold(rows) {
  const out = new Map()
  for (const r of rows ?? []) {
    const article = canonArticle(val(r, 'Item No.'))
    if (!article) continue
    const qty = Number(val(r, 'qty')) || 0
    if (!qty) continue
    out.set(article, (out.get(article) ?? 0) + qty)
  }
  return out
}

/**
 * Level 1 PM theoretical per article, for one brand over one window.
 *
 * Returns null - never an empty map - when the read fails, so a caller can
 * tell "no Level 1 usage" from "we could not ask". Falling back to the
 * unfiltered figure on a failure would quietly restore the behaviour the
 * request removed, so callers refuse instead.
 */
export async function level1ByArticle(brandCode, { from, to }) {
  const brand = brandOf(brandCode)
  if (!brand?.datasetId || !from || !to) return null
  return cached(
    `level1:${brand.code}:${from}:${to}`,
    async () => {
      const rows = await executeQuery(queryFor(brand, from, to), brand.datasetId, {
        bulk: true,
        workspace: brand.workspaceId || undefined,
      }).catch((err) => {
        console.warn(`  [level1] ${brand.code} ${from}..${to}: ${String(err.message).slice(0, 80)}`)
        return null
      })
      if (!rows) return null
      const held = fold(rows)
      console.log(`  [level1] ${brand.code} ${from}..${to}: ${held.size} articles`)
      return held
    },
    { seconds: TTL }
  )
}

/**
 * The same, a month at a time, for the monthly trend.
 *
 * ONE QUERY PER BRAND PER MONTH. `DateTable` carries nothing but `Date` -
 * verified against its own columns on 15 Nov 2026 - so there is no month
 * column to group on, and a daily grouping would return hundreds of thousands
 * of rows to be folded back up. Six narrow queries beat one enormous one.
 *
 * Cached on the brand and the month list, so moving the page's date slicer
 * does not re-fetch: the trend covers whole months regardless of the dates on
 * screen, exactly as the consumption trend does.
 */
export async function level1ByArticleMonth(brandCode, months) {
  const brand = brandOf(brandCode)
  if (!brand?.datasetId || !months?.length) return null
  const key = `level1m:${brand.code}:${months.join(',')}`
  return cached(
    key,
    async () => {
      const out = new Map()
      let failed = 0
      await Promise.all(
        months.map(async (month) => {
          const from = `${String(month).slice(0, 7)}-01`
          const rows = await executeQuery(queryFor(brand, from, lastOfMonth(from)), brand.datasetId, {
            bulk: true,
            workspace: brand.workspaceId || undefined,
          }).catch((err) => {
            failed += 1
            console.warn(
              `  [level1m] ${brand.code} ${month}: ${String(err.message).slice(0, 70)}`
            )
            return null
          })
          if (!rows) return
          for (const [article, qty] of fold(rows)) {
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
    },
    { seconds: TTL }
  )
}
