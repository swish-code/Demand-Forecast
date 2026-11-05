import { config } from '../config.js'
import { cached } from '../cache.js'
import { timed } from '../perf.js'
import { pg } from '../db/accounts.js'
import { executeQuery } from './client.js'
import { SITE_COST_CENTRES } from '../insights/productionSource.js'

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
export const SITE_NAMES = [...SITE_COST_CENTRES.values()].flat()

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
/*
 * THE SAME FIGURE, OUT OF THE LOCAL COPY, WHEN THE WINDOW IS WHOLE MONTHS.
 *
 * `cube_site_outbound_monthly` is filled by `siteOutboundByMonth` further down
 * this same file, and the two queries are the same query: the same
 * `SITE_NAMES` on Cost Center/Store, the same Status Group filter, the same
 * `SUM(Action Base Qty)`, grouped by article and by the brand that received
 * it. The only difference is that the extract asks a month at a time and this
 * asks a window. So for a window that is EXACTLY whole months, adding those
 * months up gives the identical answer - not an approximation of it.
 *
 * Worth doing because this is the most frequent Power BI query in the
 * application. It runs once per brand per window, which is nine on a
 * nine-brand request, and the Procurement page makes a request per month: a
 * six-month range was fifty-four of these. Measured 15 Oct 2026, the capacity
 * refused 29.2% of all attempts with a 429, and Power BI answers each of those
 * with Retry-After: 60 - so a single throttled query costs a minute. Cutting
 * the volume is the only thing that helps.
 *
 * TWO GUARDS, because being slow is recoverable and being wrong is not:
 *
 *   whole months  A window that starts mid-month or ends mid-month is not the
 *                 sum of any set of months, so it goes to Power BI.
 *   every month   Each month in the range must be present in the copy. The
 *                 extract replaces a month wholesale, so a month that is there
 *                 is complete; a month that is missing - never fetched, or
 *                 skipped because its own query failed - falls back rather
 *                 than silently reporting a short total.
 *
 * A month in which nothing moved anywhere holds no rows and therefore reads as
 * missing, which costs a fallback query and cannot cost a wrong figure.
 */
const MONTH_FIRST = /^\d{4}-\d{2}-01$/

function wholeMonths(dateFrom, dateTo) {
  if (!MONTH_FIRST.test(String(dateFrom))) return null
  const last = String(dateTo).slice(0, 7)
  if (String(dateTo) !== `${last}-${lastDayOf(last)}`) return null

  const out = []
  let [y, m] = String(dateFrom).slice(0, 7).split('-').map(Number)
  // Bounded rather than `while (true)`: a nonsensical range must not spin.
  for (let i = 0; i < 48; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    out.push(key)
    if (key === last) return out
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return null
}

async function copyHoldsEvery(months) {
  const rows = await timed('copy', () =>
    pg.all(
      `SELECT DISTINCT month FROM cube_site_outbound_monthly
        WHERE month IN (${months.map(() => '?').join(', ')})`,
      months
    )
  )
  const held = new Set(rows.map((r) => String(r.month)))
  return months.every((m) => held.has(m))
}

async function siteOutboundFromCopy(brandCode, months) {
  const rows = await timed('copy', () =>
    pg.all(
      `SELECT article, SUM(qty) AS qty
         FROM cube_site_outbound_monthly
        WHERE brand = ? AND month IN (${months.map(() => '?').join(', ')})
        GROUP BY article`,
      [brandCode, ...months]
    )
  )
  const out = new Map()
  for (const r of rows) {
    const article = String(r.article ?? '').trim()
    if (!article) continue
    out.set(article, (out.get(article) ?? 0) + (Number(r.qty) || 0))
  }
  return out
}

export async function siteOutboundByArticle(brandCode, { dateFrom, dateTo } = {}) {
  if (!isConfigured() || !brandCode || !dateFrom || !dateTo) return null

  return cached(`site-outbound:${brandCode}:${dateFrom}:${dateTo}`, async () => {
    const months = wholeMonths(dateFrom, dateTo)
    if (months) {
      const local = await copyHoldsEvery(months)
        .then((ok) => (ok ? siteOutboundFromCopy(brandCode, months) : null))
        .catch((err) => {
          // The copy is an optimisation; a fault in it must cost a round trip,
          // never a figure. Exactly how `salesFor` treats the same choice.
          console.warn(`  [site-outbound] copy unusable for ${brandCode}: ${err.message}`)
          return null
        })
      if (local) return local
    }

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

/**
 * When each article was LAST ISSUED BY A GIVEN SITE, and how much it has moved.
 *
 * The site twin of `cube.shipHistory`, and the same shape, so `classifyOne` can
 * read either without knowing which it was given. That matters: the Status
 * ladder is pure arithmetic over a last-issued date, and the only thing that
 * should differ between Stock Article and the production pages is WHOSE issuing
 * is being dated.
 *
 * ASKED FOR ON 5 NOV 2026. The warehouse ladder is the wrong question on a page
 * of articles the warehouse never handles - a prepared article is made at the
 * kitchen and issued from there, so the warehouse has no line for it and every
 * row read "Never shipped". `sites` is the page's OWN site, not production in
 * general: "production" on the Production page means CK/CPU.
 *
 * WHY A DAILY DATE AND NOT `cube_site_outbound_monthly`
 *
 * That copy is keyed by month and carries no source site, and the ladder's rungs
 * are thirty days apart - so a month-grained answer can place an article a whole
 * rung wrong, on a status that proposes deactivation. This reads the fact table
 * for a real date instead.
 *
 * THE LOOKBACK IS TWO YEARS, and that is a trade.
 *
 * The warehouse twin reads its whole copied history; this reads the fact table
 * live, so it is bounded to keep the query honest in size. An article last
 * issued more than two years ago therefore reads "Never shipped" rather than
 * "To Be Deactivated". Both mean stop forecasting it, so nothing downstream acts
 * differently - but the two are not the same sentence, and a reader comparing
 * this page with Stock Article should know which one they are being told.
 */
const LOOKBACK_DAYS = 730
const DAY_MS = 86_400_000
const minus = (isoDate, days) =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10)

export async function siteShipHistory({ asAt, recentFrom, sites }) {
  const names = (sites ?? []).filter(Boolean)
  if (!isConfigured() || !asAt || !names.length) return null

  return cached(`site-ship-history:${names.join('|')}:${asAt}:${recentFrom ?? ''}`, async () => {
    const from = minus(asAt, LOOKBACK_DAYS)
    /*
     * `LastDate` and the counts all ignore zero-quantity lines, exactly as the
     * warehouse copy does with `WHERE qty > 0`. A cancelled line dated later
     * than the real one would otherwise become the article's last issue and
     * make a moving article look idle.
     */
    const dax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
  TREATAS({${lit(names)}}, fact_outbound_line[Cost Center/Store]),
  DATESBETWEEN(dim_date[Date], ${asDate(from)}, ${asDate(asAt)}),
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${lit(config.warehouse.statuses)}}
  ),
  "LastDate", CALCULATE(MAX(dim_date[Date]),
    FILTER(fact_outbound_line, fact_outbound_line[Action Base Qty] > 0)),
  "FirstDate", CALCULATE(MIN(dim_date[Date]),
    FILTER(fact_outbound_line, fact_outbound_line[Action Base Qty] > 0)),
  "TotalQty", CALCULATE(SUM(fact_outbound_line[Action Base Qty]),
    FILTER(fact_outbound_line, fact_outbound_line[Action Base Qty] > 0)),
  "RecentDays", CALCULATE(DISTINCTCOUNT(dim_date[Date]),
    FILTER(fact_outbound_line, fact_outbound_line[Action Base Qty] > 0),
    DATESBETWEEN(dim_date[Date], ${asDate(recentFrom ?? from)}, ${asDate(asAt)}))
)`

    const rows = await executeQuery(dax, config.warehouse.datasetId, {
      bulk: true,
      workspace: config.warehouse.workspaceId,
    }).catch((err) => {
      console.warn(`  [site-status] ${names[0]}: ${String(err.message).slice(0, 90)}`)
      return null
    })
    // Null, not empty: "we could not ask" must not read as "nothing ever moved",
    // which would mark the whole page Never shipped.
    if (!rows) return null

    const day = (v) => {
      const s = String(v ?? '').slice(0, 10)
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
    }
    const val = (r, k) => r[k] ?? r[`[${k}]`]
    const out = new Map()
    for (const r of rows) {
      const article = String(val(r, 'Article No.') ?? '').trim()
      if (!article) continue
      const lastShipped = day(val(r, 'LastDate'))
      // No dated line in the lookback is no history to classify from.
      if (!lastShipped) continue
      out.set(article, {
        lastShipped,
        firstShipped: day(val(r, 'FirstDate')),
        totalQty: Number(val(r, 'TotalQty')) || 0,
        recentDays: Number(val(r, 'RecentDays')) || 0,
      })
    }
    return out
  })
}
