/**
 * What is still outstanding with suppliers, per article — quantity and value.
 *
 * The Inventory Control dashboard shows a "pending PO" figure, and this is the
 * per-article version of it. It answers the question the warehouse stock
 * columns raise but cannot settle: WH closing says what is on the shelf, and
 * this says how much more has been bought and not yet arrived.
 *
 * WHY THIS READS COLUMNS AND NOT THE DASHBOARD'S MEASURE
 *
 * The dashboard's figure is `cc_daily_inventory[CC Open PO Pending Value]`, and
 * it cannot be used here. Measured on 14 Sep 2026, every one of the `CC Open PO`
 * measures returns the same number whatever is asked of it:
 *
 *   grouped by article   6,902,808 on all 3,552 articles
 *   grouped by location  6,902,808 on all 158 locations
 *   filtered to August   6,902,808
 *   grouped through 'CC Open PO Core'[Article No.] instead  6,902,808 on all 608
 *
 * They are written to produce one company-wide figure for a card and ignore
 * filter context to do it. In a table row that becomes the same number on every
 * line, and a column total becomes the row count multiplied by it.
 *
 * GROSS, NOT NET — THE TRAP THIS MODULE EXISTS TO AVOID
 *
 * `'CC Open PO Core'[Open PO Base Qty]` is the quantity ORDERED, not the
 * quantity outstanding. Proved on 15 Sep 2026: it equals
 * `SUM(PO Qty x PO Unit Multiplier)` to the unit — 141,654,008 both ways — and
 * of the 376 POs that have receipts, 376 match gross and none match net.
 *
 * So receipts have to be taken off, and they cannot be taken off with a plain
 * sum: `CC Open PO Core` and `CC PO Receipt Core` have NO relationship, so
 * grouping by article and summing `Received Base Qty` returns the grand total
 * 5,992,782 against every article. They are joined here on
 * `PO Article Location Key`, which both tables carry — 1,637 of 6,317 open PO
 * lines have a matching receipt key.
 *
 * Getting this wrong would have double-counted stock twice over: once as still
 * on order, and again as stock on hand, since a received quantity is already
 * sitting in SOH.
 *
 * `Open PO Value` carries the same fault, because it is simply the gross
 * quantity priced: value / qty equals `PO Unit Price / PO Unit Multiplier`
 * exactly on every line, which is also the proof that it is money and not
 * units. It is netted the same way, at each line's own price per base unit.
 *
 * SCOPE
 *
 *   Locations   Warehouse only, resolved through the warehouse model's own
 *               `Transfer To -> Mapped Transfer To` mapping — the same rule the
 *               WH opening and WH closing columns use, so all of them agree
 *               about what "the warehouse" means. That is 416 articles and
 *               74,385,555 units pending, of the 7,818,336-value book.
 *   Grain       One figure per article, summed over its open PO lines.
 *   Date        None. This is the book as it stands, not a window — there is no
 *               "as at" dimension on an open PO. It therefore does not move
 *               with the date slicer, exactly as Outbound MTD does not.
 *   Clamping    Per article at zero: 15 articles have received more than was
 *               ordered, and a negative pending quantity is not a thing.
 *
 * WHAT THIS STILL DOES NOT RECONCILE TO
 *
 * The dashboard's 6,902,808. The gross book is 7,818,336 across all locations
 * and none of the obvious restrictions explains the difference — warehouse only
 * 1,872,055, future delivery dates 1,455,126, overdue 6,363,210, PO date in
 * 2026 7,643,880. The measure's DAX cannot be read over the REST endpoint
 * (`INFO.MEASURES()` answers 400, `INFO.VIEW.MEASURES()` returns an empty
 * Expression), so what it filters is unknown. Somebody with the model open in
 * Desktop or Tabular Editor needs to say.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { destinationBuckets, SUPPLY_SOURCE } from '../powerbi/warehouse.js'
import { cached } from '../cache.js'

const isConfigured = () => Boolean(config.inventory.workspaceId && config.inventory.datasetId)
const literal = (v) => v.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')

/**
 * Article number to `{ qty, value }` outstanding, both net of receipts.
 *
 * Null when there is no inventory model to ask, so the caller leaves the
 * columns off rather than showing a page of blanks that look like missing data.
 */
export async function openPoByArticle() {
  if (!isConfigured()) return null

  /*
   * Cached on nothing but itself.
   *
   * It takes no window and no brand, so one entry serves every caller. The
   * open-PO book changes when a PO is raised or received, which is nothing like
   * per-request, and this sits on a page that already pays for several queries.
   */
  return cached('open-po:warehouse:net', async () => {
    const map = await destinationBuckets()
    if (!map?.size) return null

    const warehouses = new Set()
    for (const [location, bucket] of map) {
      if (bucket === SUPPLY_SOURCE) warehouses.add(location)
    }
    if (!warehouses.size) return null

    /*
     * Two reads, joined here rather than in DAX.
     *
     * The two tables are unrelated in the model, so a measure spanning them
     * returns the receipt grand total against every row. The composite key both
     * of them carry is the join.
     */
    const [openRows, receiptRows] = await Promise.all([
      executeQuery(
        `EVALUATE
SUMMARIZECOLUMNS(
  'CC Open PO Core'[PO Article Location Key],
  'CC Open PO Core'[Article No.],
  'CC Open PO Core'[Location],
  "Ordered", SUM('CC Open PO Core'[Open PO Base Qty]),
  "Value", SUM('CC Open PO Core'[Open PO Value])
)`,
        config.inventory.datasetId,
        { bulk: true, workspace: config.inventory.workspaceId }
      ),
      executeQuery(
        `EVALUATE
SUMMARIZECOLUMNS(
  'CC PO Receipt Core'[PO Article Location Key],
  "Received", SUM('CC PO Receipt Core'[Received Base Qty])
)`,
        config.inventory.datasetId,
        { bulk: true, workspace: config.inventory.workspaceId }
      ),
    ])

    const received = new Map()
    for (const r of receiptRows) {
      const key = String(r['PO Article Location Key'] ?? '')
      if (key) received.set(key, (received.get(key) ?? 0) + (Number(r.Received) || 0))
    }

    const out = new Map()
    for (const r of openRows) {
      const article = String(r['Article No.'] ?? '').trim()
      const location = String(r.Location ?? '')
      if (!article || !warehouses.has(location)) continue

      const ordered = Number(r.Ordered) || 0
      const value = Number(r.Value) || 0
      const got = received.get(String(r['PO Article Location Key'] ?? '')) ?? 0
      const pending = ordered - got
      if (!Number.isFinite(pending)) continue

      const held = out.get(article) ?? { qty: 0, value: 0 }
      held.qty += pending
      /*
       * Value netted at this line's own price per base unit.
       *
       * `Open PO Value` is the gross quantity priced, so scaling it by the
       * share still outstanding gives the outstanding value. Taking the ratio
       * from this line rather than a blended price keeps a cheap article's
       * receipts from discounting an expensive one's order.
       */
      held.value += ordered > 0 ? value * (pending / ordered) : 0
      out.set(article, held)
    }

    // Clamped per article: 15 of them have received more than was ordered, and
    // a negative amount outstanding is not a quantity.
    for (const held of out.values()) {
      held.qty = Math.max(0, held.qty)
      held.value = Math.max(0, held.value)
    }
    return out
  })
}
