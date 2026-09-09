/**
 * How hard the warehouse's own stock is working, over time.
 *
 * One question, asked week by week: of what the warehouse was holding, how much
 * went out? Ten units on the shelf and two issued is 20% — comfortable. Ten on
 * the shelf and twenty issued is 200% — the shelf turned over twice and was
 * refilled mid-week to manage it, which is a warehouse running hot.
 *
 * The line to watch is 100%. Below it the warehouse is holding more than a
 * period's demand; above it, it is shipping more than it holds and depends on
 * replenishment landing on time.
 *
 * WHY THIS MATTERS RATHER THAN BEING MERELY INTERESTING
 *
 * Measured on 9 Sep 2026 across roughly 47,000 article-weeks: in weeks where
 * the warehouse held under a quarter of a week of cover, the following week
 * shipped 0.60x that article's average; where it held more, 1.10x. And 35.7% of
 * all zero-shipment weeks followed an empty warehouse.
 *
 * So a large part of what currently reads as forecast error is not a forecast
 * error at all — it is the warehouse being unable to ship what it did not have.
 * This chart is the visible half of that finding.
 *
 * AGGREGATED PER ARTICLE, NOT ACROSS THEM
 *
 * Each article's ratio is computed on its own and the median is taken. Adding
 * every article's stock together would sum kilograms to pieces to litres and
 * call the result a quantity, and the ratio of two meaningless totals is not
 * more meaningful. A median over per-article ratios is dimensionless and says
 * what the typical article did.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import * as cube from '../cube/query.js'
import { cached } from '../cache.js'

const DAY = 86_400_000
const iso = (d) => new Date(d).toISOString().slice(0, 10)
const daxDate = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split('-')
  return `DATE(${Number(y)},${Number(m)},${Number(d)})`
}

/** Which locations count as the warehouse itself. */
const WAREHOUSE_MATCH = process.env.INV_WAREHOUSE_MATCH || 'WAREHOUSE'

const isConfigured = () => Boolean(config.inventory.workspaceId && config.inventory.datasetId)

/**
 * The window cut into buckets that each hold enough to compare.
 *
 * Weekly, because outbound is lumpy — a shop is delivered every few days, not
 * continuously — and a daily ratio would be a sawtooth that says more about the
 * delivery calendar than about stock. Under three weeks there is nothing to
 * trend, so the caller is told so rather than shown two points.
 */
function buckets(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []

  const out = []
  for (let s = start; s <= end; s += 7 * DAY) {
    const e = Math.min(s + 6 * DAY, end)
    // A trailing part-week is dropped: its outbound covers fewer days than its
    // stock reading implies, which reads as a sudden fall that did not happen.
    if (e - s < 6 * DAY && out.length) break
    out.push({ from: iso(s), to: iso(e) })
  }
  return out
}

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Stock on hand at each bucket's end, per article.
 *
 * Sampled at the boundaries rather than averaged across the week: one query for
 * ten week-ends returns about fifteen thousand rows, where a daily pull of the
 * same period would be ten times that for a number that barely moves within a
 * day.
 */
async function stockAt(dates) {
  if (!dates.length) return new Map()
  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(cc_daily_inventory[Article No.], cc_daily_inventory[Movement Date],
  FILTER(ALL(cc_daily_inventory[Movement Date]),
    cc_daily_inventory[Movement Date] IN {${dates.map(daxDate).join(',')}}),
  FILTER(ALL(cc_daily_inventory[Location]),
    CONTAINSSTRING(cc_daily_inventory[Location], "${WAREHOUSE_MATCH}")),
  "SOH", SUM(cc_daily_inventory[Closing Stock Qty]))`,
    config.inventory.datasetId,
    { bulk: true, workspace: config.inventory.workspaceId }
  )

  const out = new Map()
  for (const r of rows) {
    const k = Object.keys(r)
    const article = String(r[k[0]] ?? '').trim()
    const date = String(r[k[1]] ?? '').slice(0, 10)
    if (!article || !date) continue
    if (!out.has(date)) out.set(date, new Map())
    out.get(date).set(article, Number(r.SOH) || 0)
  }
  return out
}

/**
 * The trend, one point per week.
 *
 * Returns null when there is no inventory model configured — the caller shows
 * nothing rather than an empty chart implying the warehouse holds no stock.
 */
export async function sohTrend({ dateFrom, dateTo } = {}) {
  if (!isConfigured() || !dateFrom || !dateTo) return null

  const weeks = buckets(dateFrom, dateTo)
  if (weeks.length < 3) return { weeks: [], tooShort: true }

  return cached(`soh-trend:${dateFrom}:${dateTo}`, async () => {
    const [stock, shipped] = await Promise.all([
      stockAt(weeks.map((w) => w.to)),
      cube.outboundByArticleDates(dateFrom, dateTo),
    ])

    // Outbound into the same weekly buckets.
    const perWeek = weeks.map(() => new Map())
    const index = new Map(weeks.map((w, i) => [i, w]))
    for (const r of shipped) {
      const date = String(r.date).slice(0, 10)
      const i = weeks.findIndex((w) => date >= w.from && date <= w.to)
      if (i === -1) continue
      const article = String(r.article)
      const m = perWeek[i]
      m.set(article, (m.get(article) ?? 0) + (Number(r.qty) || 0))
    }

    const points = weeks.map((w, i) => {
      const soh = stock.get(w.to) ?? new Map()
      const out = perWeek[i]

      const ratios = []
      let short = 0
      let dry = 0
      let moved = 0
      let stockedArticles = 0
      let stockedNotMoved = 0

      for (const [article, qty] of out) {
        if (qty <= 0) continue
        moved++
        const held = soh.get(article)
        /*
         * No stock reading is not the same as no stock. An article the
         * inventory model has never heard of tells us nothing, and counting it
         * as empty would invent a shortage.
         */
        if (held === undefined) continue
        if (held <= 0) {
          dry++
          continue
        }
        stockedArticles++
        const ratio = qty / held
        ratios.push(ratio)
        if (ratio > 1) short++
      }

      for (const [article, held] of soh) {
        if (held > 0 && !(out.get(article) > 0)) stockedNotMoved++
      }

      return {
        week: w.to,
        from: w.from,
        // The headline: the typical article's outbound as a share of its stock.
        cover: ratios.length ? median(ratios) : null,
        // Where it ran past what was held — the warehouse turned over more than
        // a week's stock and relied on replenishment inside the week.
        shortShare: stockedArticles ? short / stockedArticles : null,
        short,
        // Shipped with nothing recorded on the shelf: a stockout, or stock that
        // arrived and left inside the same week.
        dry,
        moved,
        stocked: stockedArticles,
        idleStock: stockedNotMoved,
      }
    })

    const scored = points.filter((p) => p.cover !== null)
    return {
      weeks: points,
      summary: {
        points: points.length,
        latest: scored.length ? scored[scored.length - 1] : null,
        median: median(scored.map((p) => p.cover)),
        /*
         * Direction, from the first half against the second.
         *
         * A slope over two halves rather than first-against-last: the last week
         * of any window is the one most likely to be part-counted, and reading
         * a trend off it would report a fall every time.
         */
        trend: (() => {
          if (scored.length < 4) return null
          const half = Math.floor(scored.length / 2)
          const early = median(scored.slice(0, half).map((p) => p.cover))
          const late = median(scored.slice(half).map((p) => p.cover))
          if (!(early > 0) || late === null) return null
          return late / early - 1
        })(),
        dryTotal: points.reduce((s, p) => s + p.dry, 0),
      },
    }
  })
}
