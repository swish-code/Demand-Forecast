import * as cube from '../cube/query.js'
import { OTHER_BUCKET } from '../powerbi/warehouse.js'

/**
 * Forecasting an article from what the warehouse actually shipped.
 *
 * The Ingredients page already forecasts every component one way: multiply the
 * forecast sales by what the recipes say each sale needs. That method is only
 * as good as the recipe tree, and we know the tree is not good — it double
 * counts across levels, 39% of forecast volume has no recipe attached at all,
 * and the typical component scores about half on accuracy.
 *
 * This is a second opinion that never looks at a recipe. It asks a simpler
 * question of the warehouse's own history:
 *
 *     for every unit this brand sold last month, how much of this article
 *     did the warehouse have to ship?
 *
 * That ratio is the constant. Measure it over each of the last six whole
 * months, average the six, and multiply by what the brand is forecast to sell —
 * and you have a requirement derived entirely from observed behaviour.
 *
 * Six months rather than one because a single month is one delivery pattern: an
 * article ordered in bulk every eight weeks looks enormous in the month it
 * arrives and absent in the month it does not. Averaging six flattens the
 * ordering cycle without reaching so far back that the menu has changed.
 */

/**
 * The last `count` whole months before the month `today` falls in.
 *
 * Whole months only. September is not over, so September's ratio would be a
 * partial numerator over a partial denominator — the same fraction in theory
 * and much noisier in practice, since deliveries and sales do not land in step
 * within a month.
 */
export function pastMonths(today = new Date(), count = 6) {
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth()
  const out = []
  for (let i = 1; i <= count; i++) {
    out.push(new Date(Date.UTC(y, m - i, 1)).toISOString().slice(0, 7))
  }
  return out
}

const cache = new Map()

/**
 * One brand's average constant per article, over the last six whole months.
 *
 * Returns a Map of article number to { constant, months, detail } where months
 * is how many of the six actually contributed and detail is the individual
 * ratios, so a figure that looks wrong can be taken apart rather than argued
 * about.
 *
 * A month counts when the brand sold something in it. Within those months an
 * article that received nothing contributes a genuine zero — an item ordered
 * every other month really does average out lower than one ordered monthly, and
 * dropping the empty months would quietly turn "every other month" into "every
 * month". An article that received nothing in all six is left out entirely:
 * there is no evidence to average.
 */
export async function constantsFor(brand, { today = new Date(), months = 6 } = {}) {
  const list = pastMonths(today, months)
  const key = `${brand}|${list[0]}|${months}`
  const held = cache.get(key)
  if (held) return held

  // The catch-all bucket is measured against every brand's sales, because it
  // has none of its own — see monthlySales for why.
  const allBrands = brand === OTHER_BUCKET

  const work = (async () => {
    const [sales, outbound] = await Promise.all([
      cube.monthlySales(brand, list, { allBrands }),
      cube.outboundByMonth(brand, list),
    ])

    // Only months the brand actually traded in. A month with no sales has no
    // denominator, and dividing by it would produce an infinity that then
    // poisons the average of the other five.
    const usable = list.filter((m) => (sales.get(m)?.actual ?? 0) > 0)
    if (!usable.length) return new Map()

    // Oldest first, so "before this article existed" is a prefix.
    const ordered = [...usable].sort()

    const out = new Map()
    for (const [article, byMonth] of outbound) {
      const all = ordered.map((m) => {
        const sold = sales.get(m).actual
        const shipped = byMonth.get(m) ?? 0
        return { month: m, outbound: shipped, sales: sold, constant: shipped / sold }
      })

      /*
       * The average starts at the article's first delivery, not six months ago.
       *
       * Zeros mean two completely different things depending on where they sit.
       * A zero between two deliveries is a real ordering cycle — an item bought
       * every other month genuinely averages half of what a monthly one does,
       * and dropping those months would turn "every other month" into "every
       * month". A zero *before* the first delivery means the warehouse was not
       * stocking the article yet, and averaging it in is dividing by months
       * that had nothing to do with it.
       *
       * Ketchup US is the case that showed it: first shipped in June, so March,
       * April and May were three zeros, and the six-month average came out at
       * 0.128 against a June-to-August reality of 0.256 — half the requirement,
       * for an article that has been shipping steadily since it appeared.
       *
       * Trailing zeros stay. An article that stopped arriving in June really is
       * winding down, and the average should say so.
       */
      const first = all.findIndex((d) => d.outbound > 0)
      if (first === -1) continue
      const detail = all.slice(first)

      const total = detail.reduce((n, d) => n + d.constant, 0)
      const constant = total / detail.length
      if (!Number.isFinite(constant) || constant <= 0) continue
      out.set(article, { constant, months: detail.length, since: detail[0].month, detail })
    }
    return out
  })()

  cache.set(key, work)
  return work
}

/** Dropped when the extract rewrites outbound, so new months are picked up. */
export function forgetConstants() {
  cache.clear()
}

/**
 * What the constant implies for one window, per article.
 *
 * The monthly figure is never computed and then divided up. It is built the
 * other way round: the constant is a rate — article units per unit sold — so it
 * is applied to the forecast sales of whatever window is on screen, and the
 * days inside that window carry it in exactly the proportion the sales forecast
 * already has.
 *
 * That is the whole reason for choosing this shape. A month split evenly across
 * its days would put the same requirement on a quiet Monday as on the Friday
 * before a holiday; split by the sales forecast, each day gets the share the
 * forecast says it will actually sell. And because the parts are the rate times
 * each day's sales, they add back up to the rate times the month's sales — the
 * daily figures and the monthly figure agree by construction rather than by
 * rounding.
 */
export async function forecastFromConstants(brand, filters, { today = new Date() } = {}) {
  /*
   * Whole brand or nothing.
   *
   * Both halves of the ratio are brand-level facts. Outbound names a brand, not
   * a branch, and the sales total behind the constant has no product column to
   * narrow by — so under a branch or product filter the numerator would stay
   * whole while the denominator was expected to shrink, and the column would
   * read several times too high. Blank is the honest answer, and it is the same
   * answer Outbound gives to the same question.
   */
  if (filters?.locations?.length || filters?.products?.length || filters?.articles?.length) {
    return new Map()
  }

  const constants = await constantsFor(brand, { today })
  if (!constants.size) return new Map()

  const sales = await cube.forecastSales(brand, filters, { allBrands: brand === OTHER_BUCKET })
  if (!sales) return new Map()

  const out = new Map()
  for (const [article, held] of constants) {
    const qty = held.constant * sales
    if (!Number.isFinite(qty) || qty <= 0) continue
    out.set(article, qty)
  }
  return out
}
