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
export async function consumptionByArticle(brandCode, { dateFrom, dateTo, locations } = {}) {
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

  const dax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
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
    out.set(article, (out.get(article) ?? 0) + qty)
  }
  return out
}

/** Whether the page should offer consumption at all. */
export const warehouseReady = isConfigured
