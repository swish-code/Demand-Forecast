/**
 * Which channels an article actually moved through, in one window.
 *
 * Two reads against Warehouse Analytics, both aggregated in the model so what
 * comes back is small:
 *
 *   inbound   fact_grn_line           article x receiving location x sign
 *   transfers fact_outbound_line      article x mapped source x mapped destination
 *
 * Shaped like `warehouse.js` - a process cache for the slow-moving mapping, a
 * windowed read for the rest - so there is no new table, no new extract step
 * and nothing for the scheduler to keep in sync. Measured first: the inbound
 * side collapses to ~5,300 article x location pairs over twelve months and the
 * outbound side to ~12,600 article x source x destination triples, so the
 * aggregation does the work rather than the network.
 */
import { config } from '../config.js'
import { executeQuery } from './client.js'
import { cached } from '../cache.js'
import {
  CHANNEL,
  brandOfCostCentre,
  classifyInbound,
  classifyTransfer,
  costCentreKind,
  isWarehouse,
  latestMovement,
  pathLabel,
} from '../insights/orderingChannel.js'

const val = (r, k) => r[k] ?? r[`[${k}]`]
const lit = (values) => values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(', ')
const asDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}
const isConfigured = () => Boolean(config.warehouse?.datasetId && config.warehouse?.workspaceId)
const ask = (dax) =>
  executeQuery(dax, config.warehouse.datasetId, {
    bulk: true,
    workspace: config.warehouse.workspaceId,
  })

/**
 * Receiving location -> cost centre, from the PO lifecycle table.
 *
 * WHY THIS MAPPING EXISTS AT ALL
 *
 * The business rule is written in terms of `fact_po_period_lifecycle[Cost
 * Center]`, which is the rolled-up owner (SS, BBT, MAIN WAREHOUSE, CKU/CPU -
 * 18 values, 0.1% blank). The inbound table does not carry it; it carries
 * `Warehouse`, the shop-level location (137 values). This table holds both, so
 * it is the translation between them.
 *
 * `Final Cost Center` is NOT used, deliberately. It sits in the same table and
 * looks interchangeable, and it is not: measured 21 Oct 2026 it is blank on
 * 81.8% of rows (42,213 of 51,630) and holds raw shop names rather than the
 * rolled-up owner. `Cost Center` is blank on 0.1%.
 *
 * Verified one-to-one the same day: 147 distinct locations, none mapping to two
 * cost centres. So a location has one owner and this cannot be ambiguous.
 *
 * Cached for the process. It changes when a site opens, which is nothing like
 * per request.
 */
let mappingCache = null

export async function warehouseToCostCentre() {
  if (!isConfigured()) return null
  if (mappingCache) return mappingCache

  const work = (async () => {
    const rows = await ask(`EVALUATE
SUMMARIZECOLUMNS(
  fact_po_period_lifecycle[Warehouse],
  fact_po_period_lifecycle[Cost Center]
)`)
    const out = new Map()
    for (const r of rows) {
      const where = String(val(r, 'Warehouse') ?? '').trim()
      const cc = String(val(r, 'Cost Center') ?? '').trim()
      if (!where || !cc) continue
      out.set(where.toLowerCase(), cc)
    }
    return out
  })()

  mappingCache = work
  work.catch(() => {
    mappingCache = null
  })
  return work
}

/** Dropped alongside the other warehouse caches when the extract refreshes. */
export function forgetChannelMapping() {
  mappingCache = null
}

/**
 * Each article's LATEST movement between two dates: its channel(s) and path(s).
 *
 * Not every channel it moved through - that is the 25 Oct 2026 change. The
 * window still decides which movements are eligible; among those, only the
 * most recent one is reported.
 *
 * Returns `Map(article -> { channels: Set, paths: string[] })`, or null when
 * the warehouse model cannot be reached - null meaning "unknown", so the caller
 * leaves the columns blank rather than asserting an article has no channels.
 *
 * NO BRAND SCOPE, from 31 Oct 2026. This used to take the brand codes on screen
 * and discard every movement outside them, which is precisely what made
 * Internal TRF look like a brand-to-brand idea. Under the corrected definition
 * the interesting movements happen BETWEEN SWISH COST CENTRES - warehouse to
 * production - and narrowing to brands threw all of them away. The brand/Swish
 * split now lives in `costCentreKind`, where it is a classification rather than
 * a filter, so nothing has to be excluded in order to be named.
 */
export async function channelsForWindow(from, to) {
  if (!isConfigured() || !from || !to) return null

  return cached(
    // Prefix changed with the shape on 31 Oct 2026, so a cached answer from
    // the brand-scoped version cannot be served against the new rule.
    // Prefix bumped again on 3 Nov 2026 with the shape: an entry cached before
    // `issuedTo` existed would answer Transfer Status with an empty set, which
    // reads as "never reached its brand" on every article it was asked about.
    `transaction-type-issued:${from}:${to}`,
    async () => {
      const mapping = await warehouseToCostCentre()

      /*
       * WHY EACH GROUP CARRIES A DATE
       *
       * The column shows the LATEST movement only (25 Oct 2026). That needs a
       * date per movement, and the obvious way to get one - putting the date
       * in the grouping - multiplies the result by every day an article moved:
       * the outbound side alone goes from ~12,600 rows to six figures over a
       * ninety-day window.
       *
       * So the date is computed INSIDE each group instead. Row counts stay
       * exactly as they were and each row answers "when did this last happen,
       * and what did it look like then".
       *
       * `LastDate` deliberately ignores zero-quantity rows. A cancelled line
       * dated later than the real one would otherwise become the article's
       * latest movement and classify as Needs Review - a data artefact
       * outranking a real receipt.
       */
      const inboundDax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_grn_line[Article No.],
  fact_grn_line[Warehouse],
  FILTER(ALL(fact_grn_line[GRN Delivery Date]),
    fact_grn_line[GRN Delivery Date] >= ${asDate(from)}
      && fact_grn_line[GRN Delivery Date] <= ${asDate(to)}),
  "LastDate", CALCULATE(MAX(fact_grn_line[GRN Delivery Date]),
    FILTER(fact_grn_line, fact_grn_line[GRN Base Qty] <> 0)),
  "LastQty",
    VAR d = CALCULATE(MAX(fact_grn_line[GRN Delivery Date]),
      FILTER(fact_grn_line, fact_grn_line[GRN Base Qty] <> 0))
    RETURN CALCULATE(SUM(fact_grn_line[GRN Base Qty]),
      fact_grn_line[GRN Delivery Date] = d)
)`

      /*
       * Transfers, from the mapped ends only.
       *
       * The same status list the rest of the app treats as "it moved", so a
       * transfer counts here exactly when it counts everywhere else, and the
       * same last-day treatment as inbound above.
       */
      const transferDax = `EVALUATE
SUMMARIZECOLUMNS(
  fact_outbound_line[Article No.],
  fact_outbound_line[Mapped Cost Center/Store],
  fact_outbound_line[Mapped Transfer To],
  DATESBETWEEN(dim_date[Date], ${asDate(from)}, ${asDate(to)}),
  FILTER(ALL(fact_outbound_line[Status Group]),
    fact_outbound_line[Status Group] IN {${lit(config.warehouse.statuses)}}),
  "LastDate", CALCULATE(MAX(dim_date[Date]),
    FILTER(fact_outbound_line, fact_outbound_line[Action Base Qty] > 0)),
  "LastQty",
    VAR d = CALCULATE(MAX(dim_date[Date]),
      FILTER(fact_outbound_line, fact_outbound_line[Action Base Qty] > 0))
    RETURN CALCULATE(SUM(fact_outbound_line[Action Base Qty]), dim_date[Date] = d)
)`

      const [inbound, transfers] = await Promise.all([
        ask(inboundDax).catch((err) => {
          console.warn(`  [channel] inbound read failed: ${String(err.message).slice(0, 90)}`)
          return null
        }),
        ask(transferDax).catch((err) => {
          console.warn(`  [channel] transfer read failed: ${String(err.message).slice(0, 90)}`)
          return null
        }),
      ])
      // Both halves failing is not "no channels", it is "we do not know".
      if (!inbound && !transfers) return null

      /*
       * Every candidate movement, kept with its date and resolved later.
       *
       * The winner cannot be picked while reading, because a later movement
       * may still be in the rows ahead. So each group contributes what it
       * knows and `latestMovement` decides per article at the end.
       */
      const events = new Map()
      const add = (article, date, channel, path = null) => {
        if (!article || !channel || !date) return
        if (!events.has(article)) events.set(article, [])
        events.get(article).push({ date, channel, path })
      }

      /*
       * Which brands each article was ISSUED to, over the WHOLE window.
       *
       * Deliberately not `latestMovement`'s answer. The Transaction Type column
       * asks "how is this moving now" and keeps only the most recent movement;
       * Transfer Status asks "did this ever reach its brand between these
       * dates", which is a different question and a wider one. An article
       * issued to MM on the 3rd and transferred to the bakery on the 28th has a
       * direct transfer, and a latest-movement read would miss it.
       *
       * Costs nothing extra: the transfer rows are already fetched and already
       * classified below, so this is one Set per article off the same pass.
       */
      const issuedTo = new Map()
      const noteIssue = (article, costCentre) => {
        const brand = brandOfCostCentre(costCentre)
        if (!article || !brand) return
        if (!issuedTo.has(article)) issuedTo.set(article, new Set())
        issuedTo.get(article).add(brand)
      }
      const day = (v) => {
        const s = String(v ?? '').slice(0, 10)
        // ISO dates compare correctly as strings; anything else is not a date.
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
      }

      for (const r of inbound ?? []) {
        const article = String(val(r, 'Article No.') ?? '').trim()
        if (!article) continue
        const date = day(val(r, 'LastDate'))
        // No dated movement in the window means this group has nothing to say.
        if (!date) continue
        const where = String(val(r, 'Warehouse') ?? '').trim()
        const cc = mapping?.get(where.toLowerCase()) ?? null
        /*
         * An unmapped receiving location is flagged, not guessed.
         *
         * Six lines of 241,527 are affected - "FM WH Ardiya" and "Shrimpy",
         * measured 21 Oct 2026 - so this is rare, and it stays visible rather
         * than defaulting to Purchase, which is the whole point.
         */
        if (!cc) {
          add(article, date, CHANNEL.REVIEW)
          continue
        }
        /*
         * The sign on the LAST day decides, so a return and a receipt on the
         * same day net out - which is the honest answer when the data gives no
         * order within a day.
         */
        const qty = Number(val(r, 'LastQty')) || 0
        const channel = classifyInbound({ costCentre: cc, qty })
        if (!channel) continue
        /*
         * A GRN carries no originating cost centre - the goods came from
         * outside - so the far end of the path is named "Supplier" rather than
         * left blank, and the arrow points the way the goods travelled.
         */
        const where2 = pathLabel(cc)
        const path =
          channel === CHANNEL.RETURN_IN ? `${where2} → Supplier` : `Supplier → ${where2}`
        add(article, date, channel, channel === CHANNEL.REVIEW ? null : path)
      }

      for (const r of transfers ?? []) {
        const article = String(val(r, 'Article No.') ?? '').trim()
        if (!article) continue
        const date = day(val(r, 'LastDate'))
        if (!date) continue
        if (!((Number(val(r, 'LastQty')) || 0) > 0)) continue
        const moved = classifyTransfer({
          source: val(r, 'Mapped Cost Center/Store'),
          destination: val(r, 'Mapped Transfer To'),
        })
        if (!moved) continue
        /*
         * One stamp for most pairings, two for Swish -> Swish, which names both
         * of its ends. Both land on this one article row, so such a row reads
         * "Internal TRF IN + Internal TRF OUT" - see classifyTransfer.
         */
        for (const stamp of moved) {
          add(article, date, stamp.channel, stamp.path)
          // A Swish cost centre sending stock to a brand IS the direct
          // transfer Transfer Status asks about - same test, named once.
          if (stamp.channel === CHANNEL.ISSUE) noteIssue(article, stamp.costCentre)
        }
      }

      /*
       * Every article that moved, whether or not its latest movement produced a
       * channel.
       *
       * `issuedTo` is carried for ALL of them, including the ones whose latest
       * movement collapsed to nothing, because "did it reach its brand" has an
       * answer even where "how is it moving now" does not.
       */
      const out = new Map()
      const seen = new Set([...events.keys(), ...issuedTo.keys()])
      for (const article of seen) {
        const { channels, paths } = latestMovement(events.get(article) ?? [])
        out.set(article, { channels, paths, issuedTo: issuedTo.get(article) ?? new Set() })
      }
      return out
    },
    { seconds: 600 }
  )
}

/** Exposed for the diagnostics route and the tests. */
export const __internals = { isWarehouse, costCentreKind }
