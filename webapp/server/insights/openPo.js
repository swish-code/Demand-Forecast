/**
 * What is still outstanding with suppliers, per article — quantity and value.
 *
 * Read from the Inventory Control model's OWN measures, so this column and that
 * dashboard cannot disagree about what "pending PO" means:
 *
 *   [CC Open PO Qty]           units still to arrive
 *   [CC Open PO Pending Value] the money behind them
 *
 * HOW THEY ARE ASKED, AND WHY IT MATTERS
 *
 * Both measures read their filter context from `CC Item Location`, not from
 * `cc_daily_inventory`:
 *
 *   VAR SelectedLocationKeys = VALUES ( 'CC Item Location'[Location Key] )
 *   VAR SelectedArticleKeys  = VALUES ( 'CC Item Location'[Article Key] )
 *
 * so they must be grouped on `'CC Item Location'[Article No.]` and filtered on
 * `'CC Item Location'[Location]`. Grouped on anything else they answer with the
 * company-wide total on every row, because `VALUES()` then sees every article.
 *
 * That is worth spelling out because this module previously did exactly that
 * and drew the wrong conclusion from it. Until 17 Sep 2026 the header here
 * claimed these measures "return the same number whatever is asked of it", on
 * the evidence of a test that grouped by `cc_daily_inventory[Article No.]`. The
 * measures were fine; the grouping was wrong. Grouped correctly they give 574
 * rows with 350 distinct values.
 *
 * WHAT THE MEASURE DOES THAT THE PREVIOUS HAND-ROLLED VERSION DID NOT
 *
 * It nets receipts through `fact_po_period_lifecycle` where
 * `[Inbound Match Status] = "Matched"`, taking MAXX of `[PO Base Qty]` against
 * SUMX of `[Allocated GRN Base Qty]` per PO / PO date / location / article, and
 * flooring each at zero. This module used to join `CC Open PO Core` to
 * `CC PO Receipt Core` on `[PO Article Location Key]` in JavaScript and net
 * there - a reimplementation of the model's matching logic rather than the
 * logic itself.
 *
 * The two agreed closely, which is the reassuring part: measured on 17 Sep 2026
 * over the warehouse locations, 399 of 411 shared articles agreed to the unit
 * and the totals were 73,851,777 against 73,879,128, a difference of 0.04%. The
 * twelve that differed are where the hand-rolled join and the model's own
 * allocation disagree, and the model's is the one the business reconciles to.
 *
 * THE DATE, AND THE ONE COLUMN THAT CARRIES IT
 *
 * `[CC Open PO Qty]` filters `'CC Open PO Core'[PO Date] <= [CC End Date]`, and
 *
 *   CC End Date = MAXX ( ALLSELECTED ( 'CC Date'[Movement Date] ), ... )
 *   CC Date     = DISTINCT ( cc_daily_inventory[Movement Date] )
 *
 * so the window has to be filtered onto `'CC Date'[Movement Date]`. Filtering
 * `cc_daily_inventory[Movement Date]` does nothing: `CC Date` is a calculated
 * DISTINCT table, so a filter on the base column never reaches it. That was the
 * second thing this module had wrong - the header used to say the measure
 * ignored dates altogether, on the strength of a test that filtered the base
 * table. Proved on the beef article, whose only PO was raised 13 Sep:
 *
 *   cut-off      filter 'CC Date'    filter cc_daily_inventory
 *   5 Sep        blank               2,250
 *   12 Sep       blank               2,250
 *   13 Sep       2,250               2,250
 *
 * So the column DOES move with the date slicer now: it is the open PO book as
 * at the end of the selected range, counting POs raised on or before it.
 *
 * One property that follows from `CC Date` holding only days the inventory feed
 * has: a window ending after the feed does clamps to the feed's last day. Ask
 * for 5 Nov and `[CC End Date]` answers 17 Sep, which is the honest reading -
 * there is no PO book for a future date.
 *
 * `ALLSELECTED` is why the filter goes in as a SUMMARIZECOLUMNS filter argument
 * rather than through TREATAS of a single date: TREATAS of a date the table
 * does not hold leaves `[CC End Date]` blank, and the measure's own
 * `IF(ISBLANK(EndDate), 0, ...)` branch then returns nought for everything.
 *
 * SCOPE
 *
 *   Locations   Warehouse only, resolved through the warehouse model's own
 *               `Transfer To -> Mapped Transfer To` mapping - the same rule the
 *               WH opening and WH closing columns use, so all of them agree
 *               about what "the warehouse" means.
 *   Grain       One figure per article, summed over its warehouse locations.
 *   Date        POs raised on or before the end of the selected range, clamped
 *               to the last day the inventory feed holds.
 *   Clamping    At zero per article. The measure already floors each PO line,
 *               so this is belt and braces rather than load-bearing.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { destinationBuckets, SUPPLY_SOURCE } from '../powerbi/warehouse.js'
import { cached } from '../cache.js'

const isConfigured = () => Boolean(config.inventory.workspaceId && config.inventory.datasetId)
const literal = (v) => v.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')

/**
 * Article number to `{ qty, value }` outstanding.
 *
 * Null when there is no inventory model to ask, so the caller leaves the
 * columns off rather than showing a page of blanks that look like missing data.
 */
export async function openPoByArticle(dateTo = null) {
  if (!isConfigured()) return null

  // A day, or nothing. Anything unparseable is dropped rather than sent into
  // DAX, where it would be a syntax error rather than a missing filter.
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(String(dateTo ?? '').slice(0, 10))
    ? String(dateTo).slice(0, 10)
    : null

  /*
   * Cached per cut-off date, and on nothing else.
   *
   * No brand and no other filter, so one entry serves every caller asking about
   * the same day. The open-PO book changes when a PO is raised or received,
   * which is nothing like per-request.
   *
   * The key names the measure rather than the method: an entry cached by the
   * previous hand-rolled version must not be served against this one, and the
   * two would otherwise share a name. The cut-off is part of the key now that
   * the answer depends on it.
   */
  return cached(`open-po:warehouse:measure:${cutoff ?? 'all'}`, async () => {
    const map = await destinationBuckets()
    if (!map?.size) return null

    const warehouses = []
    for (const [location, bucket] of map) {
      if (bucket === SUPPLY_SOURCE) warehouses.push(location)
    }
    if (!warehouses.length) return null

    /*
     * One query for both figures, at the grain the measures listen to.
     *
     * Two reads and a JavaScript join were what this needed while it was
     * summing columns itself. The measures do the matching internally, so the
     * article number and a location filter are the whole of the request.
     */
    const [y, m, d] = cutoff ? cutoff.split('-').map(Number) : []
    const window = cutoff
      ? `
  FILTER(ALL('CC Date'[Movement Date]), 'CC Date'[Movement Date] <= DATE(${y},${m},${d})),`
      : ''

    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS(
  'CC Item Location'[Article No.],${window}
  FILTER(ALL('CC Item Location'[Location]),
         'CC Item Location'[Location] IN {${literal(warehouses)}}),
  "Qty", [CC Open PO Qty],
  "Value", [CC Open PO Pending Value]
)`,
      config.inventory.datasetId,
      { bulk: true, workspace: config.inventory.workspaceId }
    )

    const out = new Map()
    for (const r of rows) {
      const article = String(r['Article No.'] ?? '').trim()
      if (!article) continue

      const qty = Number(r.Qty ?? r['[Qty]']) || 0
      const value = Number(r.Value ?? r['[Value]']) || 0
      /*
       * Nothing outstanding is not an entry.
       *
       * The measure returns 0 for an article with no open PO, and the caller
       * turns a missing entry into a dash and a present one into a number. An
       * entry of zero would print a column of noughts and bury the articles
       * that do have something on order.
       */
      if (qty <= 0 && value <= 0) continue

      const held = out.get(article) ?? { qty: 0, value: 0 }
      held.qty += qty
      held.value += value
      out.set(article, held)
    }

    for (const held of out.values()) {
      held.qty = Math.max(0, held.qty)
      held.value = Math.max(0, held.value)
    }
    return out
  })
}

