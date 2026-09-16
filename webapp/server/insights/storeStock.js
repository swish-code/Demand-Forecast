/**
 * What the shops are already holding, and what that means for the next shipment.
 *
 * The warehouse columns answer "how much did we expect to ship, and how much
 * did we ship". They cannot answer the question that follows every argument
 * about them: was the difference a bad forecast, or did the shops simply not
 * need anything because they were already full? These columns answer that, and
 * they answer it without touching the forecast.
 *
 * WHY THE FORECAST IS NOT TOUCHED
 *
 * Backtested on 9 Sep 2026 over five months (April to August), replaying the
 * live engine and scoring the way the card scores:
 *
 *   A  the forecast as it stands                        53.5%
 *   B  MAX(0, forecast − store SOH)                     42.1%
 *   C  MAX(0, target stock − store SOH), best target    44.3%
 *
 * Every SOH-subtracting variant lost, in every month, in every segment. The
 * reason is in the weekly data: across 28,147 brand-article-weeks, store stock
 * on hand correlates with what the warehouse shipped at r = +0.80 — positively.
 * Shops that hold more of an article receive more of it, because stock and
 * shipment are both driven by how much that shop sells. Subtracting stock
 * removes the very thing that predicts the shipment; it would have driven 20%
 * of forecasts to zero, 566 of which then shipped 2.15 million units.
 *
 * So warehouse outbound is a demand flow, not a replenish-to-target behaviour,
 * and the replenishment quantity below is published as its own column rather
 * than as a correction to the forecast.
 *
 * WHERE THE NUMBERS COME FROM
 *
 *   Source        `cc_daily_inventory` in the inventory model (INV_DATASET_ID),
 *                 the same table the SOH trend chart reads.
 *   Article key   `cc_daily_inventory[Article No.]`, the ERP's nine-digit code —
 *                 the same key `fact_outbound_line[Article No.]` uses, so no
 *                 mapping is needed between stock and outbound.
 *   Location key  `cc_daily_inventory[Location]`, resolved to a brand through
 *                 the warehouse model's own `Transfer To -> Mapped Transfer To`
 *                 mapping. That mapping is the warehouse's, not ours: it is
 *                 what decides which brand a shipment counted against, so stock
 *                 and outbound are attributed by one rule rather than two.
 *                 Warehouse locations are excluded from store stock and read
 *                 separately. Measured on 9 Sep 2026, two locations out of 158
 *                 could not be resolved, holding −1,932 units between them.
 *   Grain         Daily. One reading per location per article per day, from
 *                 1 Jan 2026.
 *   Date logic    STORE stock is read on the window's LAST day — closing
 *                 stock for the period selected, changed 15 Sep 2026. The
 *                 WAREHOUSE opening figure still reads the day before the
 *                 window, because that is the balance which explains a
 *                 shipment decided before the window opened.
 *
 *                 The store side used to read that same day-before balance for
 *                 the same reason, and it is the better question for judging a
 *                 zero-outbound row. It is not the question the column was
 *                 being read as: on a 1-31 Aug window it answered with the
 *                 31 July balance. Closing stock is what a reader expects from
 *                 a selected period, and it matches the New Required Qty
 *                 column.
 *   Aggregation   Summed across every shop of every brand in scope, in the
 *                 article's own base unit. Brands not selected are not counted.
 *   Missing       A blank, never a zero. An article the inventory model has
 *                 never seen in these shops (5.2% of forecast rows) tells us
 *                 nothing, and calling that "no stock" would invent a shortage.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { destinationBuckets, SUPPLY_SOURCE } from '../powerbi/warehouse.js'
import { cached } from '../cache.js'

const DAY = 86_400_000
const DAYS_PER_MONTH = 30.44
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const daxDate = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}
const literal = (values) => values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')

const isConfigured = () => Boolean(config.inventory.workspaceId && config.inventory.datasetId)

/**
 * How much cover the replenishment column aims to leave in the shops.
 *
 * Not assumed — swept. Scored against what the warehouse actually shipped over
 * June to August, target stock of 1.00 month scored 42.3%, 1.10 gave 44.2%,
 * 1.20 gave 45.2%, 1.25 gave 45.3%, 1.30 gave 45.3%, 1.50 gave 44.2% and 1.75
 * gave 41.6%. The optimum is flat between 1.2 and 1.3 months, so 1.25 is taken.
 *
 * Read this for what it is: the best of a family of rules that is still nine
 * points behind forecasting the flow directly. It is the right number for a
 * replenishment suggestion, not evidence that replenishment beats the forecast.
 */
export const TARGET_COVER_MONTHS = 1.25

/**
 * Where the bands sit, and why they sit there.
 *
 * Backtested over 6,815 brand-article-months that had both a forecast and a
 * stock reading. Two lines are drawn by the data and the rest are not:
 *
 *   cover        share   never shipped   shipped / forecast
 *   under 0.25m  35.5%        23%              0.81
 *   0.25 - 0.5m  17.1%        10%              0.85
 *   0.5  - 1m    18.1%        16%              0.76
 *   1    - 2m    13.4%        26%              0.75
 *   2    - 4m     9.0%        31%              0.51
 *   4m and over   6.9%        38%              0.57
 *
 * At two months the behaviour breaks: what ships falls from roughly three
 * quarters of the forecast to about half. That is the "already stocked" line.
 *
 * At the bottom the break is at 0.25, not at 0.5 — a quarter-month band where
 * 23% of articles do not ship at all against 10% in the band above it. The 0.5
 * and 1.0 lines proposed for this separate nothing: 0.85, 0.76 and 0.75 are the
 * same number three times. Drawing "low stock" at half a month would also have
 * coloured half the page red for no reason, because this warehouse delivers
 * fast — 741 of 1,450 articles go out every one to three days, and a shop on a
 * two-day cycle holding a week of stock is not short of anything.
 */
export const SOH_BANDS = {
  low: 0.25,
  stocked: 2,
}

/**
 * Store stock on hand for one day, summed to the article, for these brands.
 *
 * Returns a Map of article to units, and the set of articles the model had a
 * reading for at all — the two are different, because an article can legibly
 * hold zero and that is not the same as never having been seen.
 */
async function stockOn(date, buckets) {
  const map = await destinationBuckets()
  if (!map?.size) return null

  const wanted = new Set(buckets)
  const locations = []
  for (const [location, bucket] of map) {
    if (wanted.has(bucket)) locations.push(location)
  }
  if (!locations.length) return { soh: new Map(), known: new Set() }

  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(
  cc_daily_inventory[Article No.],
  FILTER(ALL(cc_daily_inventory[Movement Date]), cc_daily_inventory[Movement Date] = ${daxDate(date)}),
  FILTER(ALL(cc_daily_inventory[Location]), cc_daily_inventory[Location] IN {${literal(locations)}}),
  "SOH", SUM(cc_daily_inventory[Closing Stock Qty]))`,
    config.inventory.datasetId,
    { bulk: true, workspace: config.inventory.workspaceId }
  )

  const soh = new Map()
  const known = new Set()
  for (const r of rows) {
    const article = String(r['Article No.'] ?? '').trim()
    if (!article) continue
    known.add(article)
    soh.set(article, (soh.get(article) ?? 0) + (Number(r.SOH) || 0))
  }
  return { soh, known }
}

/**
 * The warehouse's own stock through the window, read week by week.
 *
 * Weekly rather than monthly because a month-end reading hides the case this
 * exists to find: an article that ran out on the 8th, stayed empty for a
 * fortnight and was replenished on the 25th reads as fully stocked at both ends
 * of the month. Measured over June to August, 151 zero-outbound cases were
 * explained by a shortage that a monthly reading could not see.
 */
async function warehouseStock(from, to, anchor) {
  const map = await destinationBuckets()
  if (!map?.size) return null
  const locations = []
  for (const [location, bucket] of map) if (bucket === SUPPLY_SOURCE) locations.push(location)
  if (!locations.length) return null

  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  const dates = []
  for (let t = start; t <= end; t += 7 * DAY) dates.push(iso(t))
  // A window shorter than a week still gets one reading — the day it opened.
  if (!dates.length) dates.push(from)
  if (dates[dates.length - 1] !== to && dates.length < 8) dates.push(to)

  /*
   * Opening and closing are asked for on top of the weekly scan.
   *
   * `dates` keeps its own meaning - the in-window samples `supplyShort` walks
   * looking for a dry week - so the two readings the columns need are added to
   * the query rather than to that list. The anchor is the day BEFORE the window
   * opens, for the same reason store stock uses it: closing stock cannot
   * explain a shipment that was decided before it existed.
   */
  const asked = [...new Set([anchor, ...dates, to].filter(Boolean))].sort()

  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(
  cc_daily_inventory[Article No.],
  cc_daily_inventory[Movement Date],
  FILTER(ALL(cc_daily_inventory[Movement Date]),
    cc_daily_inventory[Movement Date] IN {${asked.map(daxDate).join(',')}}),
  FILTER(ALL(cc_daily_inventory[Location]), cc_daily_inventory[Location] IN {${literal(locations)}}),
  "SOH", SUM(cc_daily_inventory[Closing Stock Qty]))`,
    config.inventory.datasetId,
    { bulk: true, workspace: config.inventory.workspaceId }
  )

  const held = new Map()
  for (const r of rows) {
    const article = String(r['Article No.'] ?? '').trim()
    const date = String(r['Movement Date'] ?? '').slice(0, 10)
    if (!article || !date) continue
    if (!held.has(article)) held.set(article, new Map())
    const m = held.get(article)
    m.set(date, (m.get(date) ?? 0) + (Number(r.SOH) || 0))
  }
  return { readings: held, dates, opening: anchor, closing: to }
}

/**
 * The warehouse's stock as it stands now, with the day it was read.
 *
 * Separate from `warehouseStock` above, which reads the SELECTED window and is
 * the right source for the opening and closing columns. Replenishment planning
 * asks a different question - "when do I run out from where I am today" - and
 * for that the window's closing balance is the wrong number twice over: on a
 * window that has not finished there is no closing balance at all, and on a
 * window in the past it answers with a balance that has since been overtaken.
 * Asked for on 16 Sep 2026, and the as-of date travels with the figure so the
 * table can say which day it is planning from rather than implying "now".
 *
 * The date is not passed in: it is whatever the feed's last day is, taken from
 * the model in the same round trip as the balances. Hard-coding today's date
 * would return an empty map every time the overnight load was late.
 */
export async function warehouseStockNow() {
  if (!isConfigured()) return null

  const map = await destinationBuckets()
  if (!map?.size) return null
  const locations = []
  for (const [location, bucket] of map) if (bucket === SUPPLY_SOURCE) locations.push(location)
  if (!locations.length) return null

  /*
   * Cached on nothing but itself. There is no window in the question, so every
   * caller wants the same answer, and it changes once a day at most.
   */
  return cached('warehouse-stock-now', async () => {
    const rows = await executeQuery(
      `EVALUATE
VAR AsOf = MAXX(ALL(cc_daily_inventory), cc_daily_inventory[Movement Date])
RETURN
SUMMARIZECOLUMNS(
  cc_daily_inventory[Article No.],
  FILTER(ALL(cc_daily_inventory[Movement Date]), cc_daily_inventory[Movement Date] = AsOf),
  FILTER(ALL(cc_daily_inventory[Location]), cc_daily_inventory[Location] IN {${literal(locations)}}),
  "SOH", SUM(cc_daily_inventory[Closing Stock Qty]),
  "AsOf", AsOf)`,
      config.inventory.datasetId,
      { bulk: true, workspace: config.inventory.workspaceId }
    )

    const soh = new Map()
    let asOf = null
    for (const r of rows) {
      const article = String(r['Article No.'] ?? '').trim()
      if (!asOf && r.AsOf) asOf = String(r.AsOf).slice(0, 10)
      if (!article) continue
      soh.set(article, (soh.get(article) ?? 0) + (Number(r.SOH) || 0))
    }
    return { soh, asOf }
  })
}

/**
 * Everything the store-inventory and replenishment columns need, for one window.
 *
 * Null when there is no inventory model, so the caller leaves the columns off
 * rather than showing a page of blanks that look like missing data.
 */
export async function storeStock({ dateFrom, dateTo, buckets }) {
  if (!isConfigured() || !dateFrom || !dateTo || !buckets?.length) return null

  /*
   * The anchor is the day before the window, and the warehouse side still uses
   * it for its opening reading.
   */
  const anchor = iso(Date.parse(`${dateFrom}T00:00:00Z`) - DAY)
  const key = `store-stock:${anchor}:${dateTo}:${[...buckets].sort().join(',')}`

  return cached(key, async () => {
    /*
     * Store stock is read on the window's LAST day, changed 15 Sep 2026.
     *
     * It used to read the anchor - the day before the window - because that is
     * the stock that explains a shipment decided before the window opened, and
     * for judging a zero-outbound row that is still the better question. But
     * the column is read as "what is on the shelf for the period I selected",
     * and on a 1-31 Aug window it answered with the 31 July balance. Asked for
     * on 15 Sep 2026, and it also puts Store SOH on the same footing as the
     * New Required Qty column, which moved to closing stock the day before.
     *
     * One consequence, the same one the WH closing column has: a window whose
     * last day has not happened has no reading, so Store SOH is blank for a
     * current or future period rather than showing the latest known balance.
     */
    const [store, warehouse] = await Promise.all([
      stockOn(dateTo, buckets).catch(() => null),
      warehouseStock(dateFrom, dateTo, anchor).catch(() => null),
    ])
    /*
     * Either side is enough to be worth returning.
     *
     * This bailed whenever the store read came back empty, which was fine while
     * the store columns were the only thing here. The warehouse opening,
     * closing and cover columns now hang off the same object, so a failure on
     * the store locations would blank three columns fed entirely by the
     * warehouse ones - and with store inventory switched off on 14 Sep 2026
     * that would have taken the only surviving half of this feature with it.
     */
    if (!store && !warehouse) return null

    const days = Math.max(
      1,
      Math.round((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / DAY) + 1
    )
    // `soh` and `known` first so that a missing store side leaves them null
    // rather than absent: `stockColumnsFor` reads both, and null is the
    // truthful answer for "no reading" either way.
    return { soh: null, known: null, ...(store ?? {}), warehouse, anchor, days }
  })
}

/**
 * The five figures for one article, from its warehouse forecast for the window.
 *
 * `forecast` is the window's requirement, so it is put on a monthly footing
 * before anything is compared against a stock level — a nine-day forecast
 * against a month of stock would read as ten months of cover on an article that
 * has barely a week of it.
 */
export function stockColumnsFor(article, forecast, held) {
  const blank = {
    Store_SOH: null,
    Stock_Cover: null,
    SOH_Status: null,
    Required_Shipment: null,
    Shipment_Status: null,
    WH_Opening_SOH: null,
    WH_Closing_SOH: null,
  }
  if (!held || !article) return blank

  const window = Number(forecast)

  /*
   * The warehouse half is worked out first, and on its own terms.
   *
   * It must not sit behind the store `seen` gate below. Plenty of articles the
   * warehouse holds have never been seen in a shop by the inventory model, and
   * returning blank for those would hide the very stock somebody is checking.
   */
  const wh = warehouseColumnsFor(article, held)

  const seen = held.known ? held.known.has(article) : false
  const soh = seen ? (held.soh.get(article) ?? 0) : null
  if (!seen) return { ...blank, ...wh }

  const monthly = Number.isFinite(window) && window > 0 ? (window * DAYS_PER_MONTH) / held.days : null

  /*
   * A balance below zero is an accounting artefact, not stock owed.
   *
   * The ERP lets a shop record consumption against stock the system has already
   * run out of — a delivery booked late, a transfer never posted, a count not
   * yet done — so the book balance goes negative and stays there until somebody
   * counts. Measured across the shops: 2.0% of articles on 30 Jun, 0.6% on
   * 31 Jul, 5.9% on 31 Aug, together −133,701 units, the largest being CPUSH
   * Sunflower Oil at −73,950.
   *
   * Treated as empty rather than as a debt. Subtracting a negative from the
   * target adds it to the requirement, which told the page to ship 66,941 units
   * of an article that needs 15,341 — four times too much, to refill a hole
   * that exists only in the books.
   */
  const onHand = Math.max(0, soh)

  /*
   * No demand, no cover — and no cover from a negative balance either.
   *
   * Dividing by a forecast of zero is infinity, and an article with stock and
   * no forecast is not infinitely well covered — it is an article nobody has
   * asked for. Dividing a negative balance gives "−4.20 months of cover", which
   * is not a length of time. The cell says nothing rather than something absurd.
   */
  const cover = monthly && monthly > 0 && soh >= 0 ? soh / monthly : null

  const short = supplyShort(article, held)
  const status =
    soh <= 0
      ? 'No store stock'
      : cover === null
        ? null
        : cover < SOH_BANDS.low
          ? 'Low stock'
          : cover < SOH_BANDS.stocked
            ? 'Normal'
            : 'Store already stocked'

  const required = monthly === null ? null : Math.max(0, TARGET_COVER_MONTHS * monthly - onHand)

  return {
    ...wh,
    Store_SOH: soh,
    Stock_Cover: cover,
    SOH_Status: status,
    Required_Shipment: required,
    /*
     * The warehouse's ability to ship comes first.
     *
     * A shop that needs stock from a warehouse that has none is not a shipment
     * waiting to be raised — it is a purchase order. Saying "shipment required"
     * about it would send somebody to look for stock that is not there.
     */
    Shipment_Status: short
      ? 'Supply constraint'
      : required === null
        ? null
        : required <= 0
          ? 'No shipment needed'
          : /*
             * Nothing on the shelf is urgent whether the balance reads zero or
             * below it. Testing cover alone missed the negative case, because
             * cover is blank there — so the emptiest shops on the page were the
             * ones not marked urgent.
             */
            soh <= 0 || (cover !== null && cover < SOH_BANDS.low)
            ? 'Low stock — urgent'
            : 'Shipment required',
  }
}

/**
 * What the warehouse itself held at each end of the window, and for how long.
 *
 * Asked for on 14 Sep 2026, beside the store figures. Three things, and they
 * answer a question the store columns cannot: the store columns say whether the
 * shops were already full, and these say whether the warehouse had anything to
 * send them in the first place.
 *
 *   opening  the warehouse balance the day before the window opened
 *   closing  the balance on its last day
 *   cover    how many days the closing balance would last at the rate the
 *            window's own forecast implies
 *
 * Unlike store stock, this data is sound. Measured on 14 Sep 2026 over the
 * previous sixty days, warehouse closing stock rose on 29 days and fell on 31 -
 * real movement in both directions - against store stock's 58 up and 2 down,
 * and no article carried a negative warehouse balance. The posting gap that
 * makes the store figures unreliable does not reach these, so they are
 * published on their own switch rather than behind the store one.
 *
 * One thing to know about cover: the warehouse is a single pool serving every
 * brand, while the forecast it is divided by belongs to the brands currently
 * selected. With everything selected the figure is the real one; with a brand
 * filter applied it is optimistic, because the whole pool is measured against
 * part of the demand. The column says so rather than pretending otherwise.
 */
function warehouseColumnsFor(article, held) {
  const wh = held.warehouse
  if (!wh) return {}
  const readings = wh.readings.get(article)
  // Never seen in the warehouse at all: a blank, not a zero. The model having
  // no row for an article says nothing about whether stock is there.
  if (!readings) return {}

  const at = (date) => {
    const v = date ? readings.get(date) : undefined
    return v === undefined ? null : v
  }
  const opening = at(wh.opening)
  const closing = at(wh.closing)

  /*
   * No demand, no cover - and none from a negative balance either.
   *
   * The same reasoning the store cover figure uses: dividing by a forecast of
   * zero is infinity, and an article with stock nobody has asked for is not
   * infinitely covered. A negative balance would give a negative number of
   * days, which is not a length of time.
   */
  /*
   * Cover in days is gone, removed 14 Sep 2026 on request.
   *
   * It was `closing / (window forecast / days)`. Two things made it awkward to
   * read next to the rest: it was in days while Stock cover beside it was in
   * months, and the warehouse is one pool serving every brand while the
   * forecast it divided by belonged only to the brands selected, so with a
   * brand filter on it always read high. Both numbers it needed are still on
   * the row - WH closing and WH forecast - so anyone who wants it can work it
   * out, and restoring the column is a few lines here and in the table.
   */
  return { WH_Opening_SOH: opening, WH_Closing_SOH: closing }
}

/**
 * Was the warehouse empty of this article at any point in the window?
 *
 * One dry week is enough. A shortage that cleared is still a week nobody could
 * ship in, and it is exactly what a monthly reading loses.
 */
function supplyShort(article, held) {
  const wh = held.warehouse
  if (!wh) return false
  const readings = wh.readings.get(article)
  // Never seen in the warehouse at all is a different fact, and not this one.
  if (!readings) return false
  return wh.dates.some((d) => {
    const v = readings.get(d)
    return v !== undefined && v <= 0
  })
}
