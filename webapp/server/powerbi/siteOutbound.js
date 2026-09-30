import { config } from '../config.js'
import { cached } from '../cache.js'
import { executeQuery } from './client.js'

/**
 * What a PRODUCTION SITE issued of each article, per brand, for one window.
 *
 * WHY THIS IS NOT THE OUTBOUND COLUMN
 *
 * The existing Outbound column measures `Mapped Cost Center/Store = "Central
 * Warehouse"` - what the warehouse shipped out. That is the right question for
 * a bought article and the wrong one for a prepared one: a prepared article is
 * made at the Central Kitchen, the Bakery or the Yelo Factory and issued from
 * there, so the warehouse has no line for it and never will.
 *
 * Asked for on 29 Sep 2026 after the warehouse Outbound column was put on the
 * Production pages and read blank on almost every row - `Marinated BBT Chicken
 * tender`, `BBT Sesame Bun Loaf`, `Egyptain Bread` and the rest. They move in
 * quantity; they move from the kitchens.
 *
 * So this is the same fact table and the same measure with one filter changed:
 * the sites replace the warehouse as the source. The destination filter is
 * unchanged, so a figure still belongs to the brand whose shops received it.
 *
 * The site names come from `productionSource.js` rather than being repeated
 * here, so the classification and this quantity can never disagree about what
 * counts as a production site. Both `Central Production Unit` and `Centeral
 * Kitchen` (the source's spelling) are included - the audit on 28 Sep found
 * them to be one cost centre renamed in early 2026, and either way both are
 * genuinely production.
 *
 * NOT included, and deliberately: `FM- CPU` belongs to a separate company,
 * `ERMG CK` to a dormant separate entity, and `Staff Meal` is a canteen.
 */

/** The raw cost-centre names that are production sites. */
export const SITE_NAMES = [
  'Central Production Unit',
  'Centeral Kitchen',
  'Swish Bakery',
  'Yelo Factory',
]

const isConfigured = () =>
  Boolean(config.warehouse?.datasetId && config.warehouse?.workspaceId)

const lit = (values) => values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(', ')
const asDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}

/**
 * article number -> quantity the sites issued to this brand in the window.
 *
 * Null when the warehouse model is not configured or the window is missing, so
 * the caller can tell "no evidence available" from "nothing moved" - the same
 * distinction the warehouse column already draws, and for the same reason: a
 * zero against an article nothing can measure reads as a forecast that missed
 * completely.
 *
 * Cached on brand and window. A page reads it once per brand per request and
 * the answer cannot change inside one.
 */
export async function siteOutboundByArticle(brandCode, { dateFrom, dateTo } = {}) {
  if (!isConfigured() || !brandCode || !dateFrom || !dateTo) return null

  return cached(`site-outbound:${brandCode}:${dateFrom}:${dateTo}`, async () => {
    const dax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
  TREATAS({${lit(SITE_NAMES)}}, fact_outbound_line[Cost Center/Store]),
  TREATAS({${lit([brandCode])}}, fact_outbound_line[Mapped Transfer To]),
  DATESBETWEEN(dim_date[Date], ${asDate(dateFrom)}, ${asDate(dateTo)}),
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${lit(config.warehouse.statuses)}}
  ),
  "Site_Outbound_Qty", SUM(fact_outbound_line[Action Base Qty])
)`

    const rows = await executeQuery(dax, config.warehouse.datasetId, {
      bulk: true,
      workspace: config.warehouse.workspaceId,
    }).catch((err) => {
      console.warn(`  [site-outbound] ${brandCode}: ${String(err.message).slice(0, 90)}`)
      return null
    })
    if (!rows) return null

    const out = new Map()
    for (const r of rows) {
      const article = String(r['Article No.'] ?? r['[Article No.]'] ?? '').trim()
      const qty = Number(r.Site_Outbound_Qty ?? r['[Site_Outbound_Qty]']) || 0
      if (!article) continue
      out.set(article, (out.get(article) ?? 0) + qty)
    }
    return out
  })
}

/**
 * What the sites issued of each article, to EVERY destination.
 *
 * `siteOutboundByArticle` above requires the destination to be a brand, because
 * a quantity has to belong to the brand whose shops received it before it can
 * sit beside that brand's forecast. That rule is kept, and it drops everything
 * the sites send somewhere that is not a brand - audited 29 Sep 2026 over
 * 1 Mar-31 Aug: 1,126,175 units, 7.6% of all site outbound.
 *
 *   FM                737,066   a separate company, no forecast model here
 *   Central Warehouse 314,529   a site returning stock to the warehouse
 *   CKU/CPU            56,957   site to site
 *   SWISH BAKERY       14,536   site to site
 *   R&D / SM / HO       3,087
 *
 * Asked for on 30 Sep 2026 for the YELO FACTORY page only, where the question
 * is "what did this factory send out", full stop - the factory supplies other
 * parts of the business, not only branded shops, and a brand-scoped figure made
 * most of its work invisible.
 *
 * Deliberately NOT the default. Used on one page, where the accuracy columns
 * beside it are read as "did the factory make what we expected" rather than as
 * a brand's fulfilment - and every other page keeps the brand rule, so nothing
 * built on it moves.
 */
export async function siteOutboundTotalByArticle({ dateFrom, dateTo } = {}) {
  if (!isConfigured() || !dateFrom || !dateTo) return null

  return cached(`site-outbound-all-dest:${dateFrom}:${dateTo}`, async () => {
    const dax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
  TREATAS({${lit(SITE_NAMES)}}, fact_outbound_line[Cost Center/Store]),
  DATESBETWEEN(dim_date[Date], ${asDate(dateFrom)}, ${asDate(dateTo)}),
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${lit(config.warehouse.statuses)}}
  ),
  "Site_Outbound_Qty", SUM(fact_outbound_line[Action Base Qty])
)`

    const rows = await executeQuery(dax, config.warehouse.datasetId, {
      bulk: true,
      workspace: config.warehouse.workspaceId,
    }).catch((err) => {
      console.warn(`  [site-outbound-all] ${String(err.message).slice(0, 90)}`)
      return null
    })
    if (!rows) return null

    const out = new Map()
    for (const r of rows) {
      const article = String(r['Article No.'] ?? r['[Article No.]'] ?? '').trim()
      const qty = Number(r.Site_Outbound_Qty ?? r['[Site_Outbound_Qty]']) || 0
      if (!article) continue
      out.set(article, (out.get(article) ?? 0) + qty)
    }
    return out
  })
}

const lastDayOf = (month) => {
  const [y, m] = String(month).split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * The same measurement as a HISTORY, for the forecast to train on.
 *
 * One month per query, and every brand in one go - the destination is a grouping
 * column here rather than a filter. That shape was chosen by measurement: asking
 * for several months at once returns far more rows and Power BI answers a query
 * that returns too much with 200 and roughly half the rows, saying nothing. A
 * six-month all-brand version of this query did exactly that during the 29 Sep
 * backtest and had to be abandoned; month by month, twelve months came back
 * clean.
 *
 * `dim_date[Year]` and `[Month]` do not exist in this model, which is the other
 * reason the month is a filter rather than a grouping - the caller labels each
 * batch with the month it asked for.
 *
 * Rows are returned rather than a Map: the caller writes them to the copy, and
 * the brand is part of the key.
 */
export async function siteOutboundByMonth(months) {
  if (!isConfigured() || !months?.length) return null

  const out = []
  for (const month of months) {
    const [y, m] = String(month).split('-').map(Number)
    if (!y || !m) continue
    const dax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Mapped Transfer To],
  fact_outbound_line[Article No.],
  TREATAS({${lit(SITE_NAMES)}}, fact_outbound_line[Cost Center/Store]),
  DATESBETWEEN(dim_date[Date], ${asDate(`${month}-01`)}, ${asDate(`${month}-${lastDayOf(month)}`)}),
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${lit(config.warehouse.statuses)}}
  ),
  "Site_Outbound_Qty", SUM(fact_outbound_line[Action Base Qty])
)`

    const rows = await executeQuery(dax, config.warehouse.datasetId, {
      bulk: true,
      workspace: config.warehouse.workspaceId,
    }).catch((err) => {
      console.warn(`  [site-outbound] ${month}: ${String(err.message).slice(0, 90)}`)
      return null
    })
    // One bad month is skipped rather than failing the whole history: five
    // months of training beats none, and the gap is visible in the coverage.
    if (!rows) continue

    for (const r of rows) {
      const article = String(r['Article No.'] ?? r['[Article No.]'] ?? '').trim()
      const brand = String(r['Mapped Transfer To'] ?? r['[Mapped Transfer To]'] ?? '').trim()
      const qty = Number(r.Site_Outbound_Qty ?? r['[Site_Outbound_Qty]']) || 0
      if (!article || !brand) continue
      out.push({ brand, month, article, qty })
    }
  }
  return out
}
