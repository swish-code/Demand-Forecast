import { config } from '../config.js'
import { executeQuery } from './client.js'

/**
 * What actually left a warehouse and arrived at a brand's shops.
 *
 * The Ingredients page has until now answered one question — what the recipes
 * imply the forecast needs — and shown its "actual" from the same place: recipe
 * quantities multiplied by sales that really happened. That is still a
 * theoretical figure. It says what should have been used if every recipe is
 * exact and nothing is wasted, spilled, over-portioned or thrown away.
 *
 * Warehouse Analytics knows what was actually issued. Every line is one article
 * moving from a source cost centre to a destination, in that article's own base
 * unit, and the two sides share the ERP's nine-digit article number — 89% of
 * the raw materials the recipes call for, and 91% of the produced articles,
 * turn up in it.
 *
 * So this replaces a modelled actual with a measured one.
 */

/*
 * Moving stock between our own buildings is not consumption.
 *
 * A transfer into the central warehouse or into a kitchen is replenishment: the
 * same goods leave again later, on their way to a shop. Counting both legs
 * would be the same double count the recipe explosion makes by listing a
 * prepared item and its own ingredients.
 *
 * The model already classifies both ends of every movement — Mapped Transfer To
 * carries the receiving brand's code, and it matches ours exactly — so a
 * destination that is a brand is consumption and anything else is internal.
 */
const isConfigured = () => Boolean(config.warehouse.workspaceId && config.warehouse.datasetId)

/** The bucket everything that is not a forecast brand is counted under. */
export const OTHER_BUCKET = '__other'

/**
 * The place stock is issued from.
 *
 * Everything this file calls "outbound" means goods leaving *here* for
 * somewhere else. Today that is the central warehouse, and the whole page is
 * built on that meaning — Outbound, Outbound MTD, the six-month constants and
 * every accuracy derived from them.
 *
 * Named once, and overridable, because it will not always be the only source:
 * a second issuing point (a CPU, a regional depot) changes what outbound means
 * without changing any of the arithmetic around it. Anything that needs to know
 * should read this rather than write the string again.
 */
export const SUPPLY_SOURCE = process.env.WH_SUPPLY_SOURCE || 'Central Warehouse'

/** The old name, kept so nothing that imports it has to change at once. */
export const WAREHOUSE = SUPPLY_SOURCE

const literal = (values) => values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(', ')

const asDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return `DATE(${y}, ${m}, ${d})`
}

/**
 * Consumption by article for one brand over one window.
 *
 * Returns a Map of article number to base-unit quantity, or null when there is
 * nothing to ask — no warehouse configured, or a question this cannot answer
 * truthfully. Null is not zero: the caller shows nothing rather than claiming
 * that nothing moved.
 */
export async function consumptionByArticle(brandCode, { dateFrom, dateTo, locations } = {}, { byDate = false } = {}) {
  if (!isConfigured() || !brandCode || !dateFrom || !dateTo) return null

  /*
   * A branch filter cannot be honoured yet, and guessing is worse than saying
   * so. Outbound names its destinations — "BBT Adailiya", "BBT Vibes" — while
   * the forecast uses codes, and the two lists do not correspond one to one:
   * four BBT destinations have no obvious code and six codes received nothing.
   * Until that mapping is agreed, a branch-filtered view gets no consumption
   * rather than a figure quietly covering the wrong shops.
   */
  if (locations?.length) return null

  /*
   * By day when the table is split by day.
   *
   * Transfers are lumpy — a shop is delivered every few days, not continuously —
   * so a daily column will be spiky against a smooth daily forecast. That is
   * what actually happened, though, and showing the day it arrived is more use
   * than showing nothing at all.
   */
  const dax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],${byDate ? '\n  dim_date[Date],' : ''}
  TREATAS({${literal([WAREHOUSE])}}, fact_outbound_line[Mapped Cost Center/Store]),
  TREATAS({${literal([brandCode])}}, fact_outbound_line[Mapped Transfer To]),
  DATESBETWEEN(dim_date[Date], ${asDate(dateFrom)}, ${asDate(dateTo)}),
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${literal(config.warehouse.statuses)}}
  ),
  "Consumed_Qty", SUM(fact_outbound_line[Action Base Qty])
)`

  const rows = await executeQuery(dax, config.warehouse.datasetId, {
    bulk: true,
    workspace: config.warehouse.workspaceId,
  })

  const out = new Map()
  for (const r of rows) {
    const article = String(r['Article No.'] ?? '').trim()
    const qty = Number(r.Consumed_Qty)
    if (!article || !Number.isFinite(qty)) continue
    // Keyed by day as well when the caller asked for it, so a dated row can
    // find its own day rather than the whole window's total.
    const key = byDate ? `${article}|${String(r.Date ?? '').slice(0, 10)}` : article
    out.set(key, (out.get(key) ?? 0) + qty)
  }
  return out
}

/**
 * Everything the central warehouse issued, by destination and article.
 *
 * The rule, and why each half of it matters:
 *
 *   source      = Central Warehouse    what the warehouse had to have on hand
 *   destination ≠ Central Warehouse    minus anything that came straight back
 *
 * Filtering on the source is what makes this correct, and it was the piece
 * missing before. Counting by destination alone swept in movements the
 * warehouse never made: SS to SS is twenty million units that never left the
 * brand, and the central kitchen shipping a prepared item onward to a shop
 * would have been counted a second time after its raw material was counted
 * going in. Neither has the warehouse as its source, so both fall away without
 * needing a rule of their own.
 *
 * Measured over the last thirty days: 15,681,880 units issued, of which
 * 13,180,314 went to a forecast brand and 2,501,566 went to the central
 * kitchen, FM, the bakery, head office and R&D. That last figure is what the
 * old rule threw away, and it is why raw beef and sauce containers read blank
 * beside a requirement of thousands.
 */
export async function outboundFromWarehouse({ dateFrom, dateTo, byDate = false } = {}) {
  if (!isConfigured() || !dateFrom || !dateTo) return null

  const dax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Mapped Transfer To],
  fact_outbound_line[Article No.],${byDate ? '\n  dim_date[Date],' : ''}
  TREATAS({${literal([WAREHOUSE])}}, fact_outbound_line[Mapped Cost Center/Store]),
  DATESBETWEEN(dim_date[Date], ${asDate(dateFrom)}, ${asDate(dateTo)}),
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${literal(config.warehouse.statuses)}}
  ),
  "Qty", SUM(fact_outbound_line[Action Base Qty])
)`

  const rows = await executeQuery(dax, config.warehouse.datasetId, {
    bulk: true,
    workspace: config.warehouse.workspaceId,
  })

  const brands = new Set(config.brands.map((b) => b.code))
  const out = []
  for (const r of rows) {
    const destination = String(r['Mapped Transfer To'] ?? '').trim()
    const article = String(r['Article No.'] ?? '').trim()
    const qty = Number(r.Qty)
    if (!destination || !article || !Number.isFinite(qty)) continue
    // Straight back into the warehouse is not an issue of stock.
    if (destination === WAREHOUSE) continue
    out.push({
      // Anything that is not a forecast brand is real consumption with nobody
      // to attribute it to, so it is kept together rather than discarded.
      bucket: brands.has(destination) ? destination : OTHER_BUCKET,
      destination,
      article,
      date: byDate ? String(r.Date ?? '').slice(0, 10) : null,
      qty,
    })
  }
  return out
}

/**
 * The same question, asked once for several brands.
 *
 * `Mapped Transfer To` is in the grouping as well as the filter, so one query
 * answers for every brand selected and the rows come back labelled. Nine brands
 * used to mean nine queries fired together, which is the burst the capacity
 * refuses — measured at 6.6 seconds of query time on one page load.
 *
 * Returns a Map of brand code to that brand's article map.
 */
export async function consumptionByBrands(brandCodes, { dateFrom, dateTo } = {}) {
  if (!isConfigured() || !brandCodes?.length || !dateFrom || !dateTo) return null

  const dax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Mapped Transfer To],
  fact_outbound_line[Article No.],
  TREATAS({${literal([WAREHOUSE])}}, fact_outbound_line[Mapped Cost Center/Store]),
  TREATAS({${literal(brandCodes)}}, fact_outbound_line[Mapped Transfer To]),
  DATESBETWEEN(dim_date[Date], ${asDate(dateFrom)}, ${asDate(dateTo)}),
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${literal(config.warehouse.statuses)}}
  ),
  "Consumed_Qty", SUM(fact_outbound_line[Action Base Qty])
)`

  const rows = await executeQuery(dax, config.warehouse.datasetId, {
    bulk: true,
    workspace: config.warehouse.workspaceId,
  })

  const out = new Map()
  for (const code of brandCodes) out.set(code, new Map())
  for (const r of rows) {
    const brand = String(r['Mapped Transfer To'] ?? '').trim()
    const article = String(r['Article No.'] ?? '').trim()
    const qty = Number(r.Consumed_Qty)
    if (!brand || !article || !Number.isFinite(qty)) continue
    const held = out.get(brand)
    if (held) held.set(article, (held.get(article) ?? 0) + qty)
  }
  return out
}

/**
 * Every article, and every destination it was ever shipped to.
 *
 * One query for the lot — destination crossed with article is a few thousand
 * rows for the whole history, small enough not to need chunking. The caller
 * keeps only the destinations that are not brands.
 */
export async function outboundByDestination({ dateFrom, dateTo } = {}) {
  if (!isConfigured()) return []
  const window = dateFrom && dateTo
    ? `
  DATESBETWEEN(dim_date[Date], ${asDate(dateFrom)}, ${asDate(dateTo)}),`
    : ''

  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Mapped Transfer To],
  fact_outbound_line[Article No.],${window}
  FILTER(
    ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${literal(config.warehouse.statuses)}}
  ),
  "Qty", SUM(fact_outbound_line[Action Base Qty])
)`,
    config.warehouse.datasetId,
    { bulk: true, workspace: config.warehouse.workspaceId }
  )

  return rows
    .map((r) => ({
      destination: String(r['Mapped Transfer To'] ?? '').trim(),
      article: String(r['Article No.'] ?? '').trim(),
      qty: Number(r.Qty) || 0,
    }))
    .filter((r) => r.destination && r.article && Number.isFinite(r.qty))
}

/**
 * Article number to the name the warehouse knows it by.
 *
 * A nine-digit code identifies a thing without describing it, and nobody
 * ordering gloves recognises 104900015. One query for the lot, because the list
 * is a few thousand rows and does not change between requests.
 */
export async function articleNames() {
  if (!isConfigured()) return new Map()
  const rows = await executeQuery(
    `EVALUATE SUMMARIZECOLUMNS(fact_outbound_line[Article No.], fact_outbound_line[Article], fact_outbound_line[Base Unit])`,
    config.warehouse.datasetId,
    { bulk: true, workspace: config.warehouse.workspaceId }
  )
  const out = new Map()
  for (const r of rows) {
    const no = String(r['Article No.'] ?? '').trim()
    if (!no || out.has(no)) continue
    out.set(no, { name: String(r.Article ?? '').trim(), unit: String(r['Base Unit'] ?? '').trim() })
  }
  return out
}

/** Whether the page should offer consumption at all. */
export const warehouseReady = isConfigured
