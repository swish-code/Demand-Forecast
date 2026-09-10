import * as cube from '../cube/query.js'
import { OTHER_BUCKET } from '../powerbi/warehouse.js'
import { articlesWithFutureDemand, articlesWithAnyFutureDemand } from './futureDemand.js'

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
 *     for every dinar this brand sold last month, how much of this article
 *     did the warehouse have to ship?
 *
 * Sales are measured as value rather than as items — changed on 9 Sep 2026. The
 * models carry both, and the item count was the original choice, but Forevermore
 * has a sales value and no item count at all, and a company total that adds a
 * dinar to an item is not a total of anything. Value is also what the business
 * itself reasons in.
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
/**
 * How fast the weighting forgets. 0 keeps every month equal; 1 keeps only the
 * last one. Swept across five backtested months — every value from 0.4 to 0.8
 * beat the linear scheme it replaces, and 0.6 was the best of them.
 */
export const ALPHA = Number(process.env.WH_FORECAST_ALPHA) || 0.6

/**
 * The old model, kept so the two can be compared on the same screen.
 *
 * Set WH_FORECAST_MODEL=legacy to put the six-month average of ratios back.
 * Nothing else changes — both models are computed from the same history, so
 * switching is a restart, not a rebuild.
 */
export const LEGACY_MODEL = process.env.WH_FORECAST_MODEL === 'legacy'

/** Ships in every one of its months, and there are at least this many. */
const REGULAR_MONTHS = 6

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * What kind of demand this is, which decides how it is forecast.
 *
 * Measured over June to August, and the spread is the reason the split exists —
 * these are not reporting labels:
 *
 *   regular       371 articles  68.8% accuracy   +18% bias   29.5% of volume
 *   intermittent  728 articles  58.2%            +26%        59.9%
 *   new           164 articles  32.7%             +7%        10.1%
 *   rare           75 articles  33.5%          +1,097%        0.3%
 *   stopped        88 articles   9.1%          +2,407%        0.2%
 *
 * The last two are where a rate model does most of its damage, and they are
 * where a different method earns its place.
 */
function behaviourOf(detail, shipMonths) {
  if (detail.length <= 2) return 'new'
  if (shipMonths <= INTERMITTENT_MONTHS) return 'rare'
  if (shipMonths >= REGULAR_MONTHS && detail.length >= REGULAR_MONTHS) return 'regular'
  return 'intermittent'
}

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

      /*
       * Recent months count for more than old ones.
       *
       * Weighted 1, 2, 3 ... oldest to newest, so last month carries as much as
       * the first three together. A flat mean cannot follow a trend in either
       * direction: article 104900012 fell from 0.95 to 0.24 over six months and
       * the flat constant sat at 0.71, forecasting three times the current rate.
       *
       * Backtested on 9 Sep 2026 by training on five months and predicting the
       * sixth, three times over. It won every month on every measure:
       *
       *   predicting   flat -> weighted   volume-weighted   bias
       *     June        69.2% -> 73.1%    65.1% -> 73.8%   +45% -> +26%
       *     July        71.2% -> 74.3%    73.6% -> 78.8%   +29% -> +18%
       *     August      73.2% -> 75.3%    78.4% -> 83.4%   +16% ->  +6%
       *
       * The bias falls by roughly half each month, which says what the +10.5%
       * over-forecast actually was: not a calibration error, but a flat mean
       * lagging a business whose rates were declining.
       *
       * Outlier capping was tested alongside this and is deliberately absent —
       * weighting already discounts an old spike, and capping a recent one would
       * suppress genuine recent growth. It made the weighted result worse.
       */
      const weights = detail.map((_, i) => i + 1)
      const weightTotal = weights.reduce((n, w) => n + w, 0)
      const constant =
        detail.reduce((n, d, i) => n + d.constant * weights[i], 0) / weightTotal
      if (!Number.isFinite(constant) || constant <= 0) continue

      /*
       * Articles that ship in bursts are forecast a different way.
       *
       * An article that shipped in two months of six has no rate worth applying
       * to sales — its demand is not proportional to what the brand sells, it is
       * an order that either happens or does not. The median of the months it
       * did ship describes that better than any average of a series that is
       * mostly zeros.
       *
       * Measured over the same three backtests: 52.4% -> 58.6%, 53.6% -> 56.7%,
       * 52.6% -> 56.9%. Median of quantities, not of rates — scaling by sales
       * cost about three points of that gain, because sales are not what drives
       * these articles.
       */
      const shipped = detail.filter((d) => d.outbound > 0)
      const shipMonths = shipped.length
      const intermittent = shipMonths > 0 && shipMonths <= INTERMITTENT_MONTHS
      const fixedMonthly = median(shipped.map((d) => d.outbound))

      /*
       * The median across EVERY month, zeros included.
       *
       * `fixedMonthly` above takes the median of the months that shipped, which
       * over-forecast these articles by 144% and doubled their error. The reason
       * is arithmetic: with two shipping months a median is the mean of them, so
       * one bulk order and one small one average to something that never
       * happened. Article 106800040 shipped 2,510,000 in January and 2,500 in
       * April; the median of those two is 1,256,250, and the page duly asked for
       * 1.24 million units a month of a sticker that had stopped moving. It was
       * the single largest error on the page.
       *
       * Counting the zeros answers a different and more useful question: in a
       * typical month, how much of this does the warehouse ship? For an article
       * that ships twice in six months the honest answer is usually none, and
       * the month it does ship is a miss we take rather than a miss we spread
       * over the other five. Backtested over five months: bias +56% -> -5%,
       * error per article 7,020 -> 3,340.
       */
      const medianAll = median(detail.map((d) => d.outbound))

      /*
       * The level and the sales behind it, both decayed towards the present.
       *
       * `constant` above averages six monthly *ratios*, which lets one month
       * dominate twice over — once through an unusual quantity and again
       * through an unusually small denominator. January 2026 had both (the
       * sales copy was still filling, so the month reads 1.0m against a normal
       * 3.2m) and article 100400137 came out forecast at 158,333 against a real
       * 1,500, because its January rate of 0.71 is a thousand times its normal
       * one and survived the averaging.
       *
       * Decaying the quantities and the sales separately, then dividing, keeps
       * the sales responsiveness without averaging ratios. ALPHA was swept:
       * 0.4 through 0.8 all beat the current scheme, and 0.6 was the best
       * balance of card accuracy, volume accuracy and error.
       */
      const decay = detail.map((_, i) => (1 - ALPHA) ** (detail.length - 1 - i))
      const decayTotal = decay.reduce((n, w) => n + w, 0)
      const level = detail.reduce((n, d, i) => n + d.outbound * decay[i], 0) / decayTotal
      const salesBase = detail.reduce((n, d, i) => n + d.sales * decay[i], 0) / decayTotal

      out.set(article, {
        constant,
        level,
        salesBase,
        medianAll,
        months: detail.length,
        shipMonths,
        intermittent,
        fixedMonthly,
        behaviour: behaviourOf(detail, shipMonths),
        since: detail[0].month,
        detail,
      })
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
/**
 * How many recent months of shipping keep a non-recipe article alive.
 *
 * An article the warehouse has not issued in three whole months has stopped
 * moving, and its six-month rate is describing a period that has ended. Asked
 * for on 6 Sep 2026.
 */
export const ACTIVE_MONTHS = 3

/**
 * Ships in this many months or fewer, out of six, and it is intermittent.
 *
 * Two is where the backtest separated cleanly: at three or more the weighted
 * rate was still the better method, and below three the median won every time.
 */
export const INTERMITTENT_MONTHS = 2

/** A month, for turning a monthly quantity into a window's worth of it. */
const DAYS_PER_MONTH = 30.44

/**
 * One article's quantity for a window, by how the article behaves.
 *
 *   rare      the typical month's quantity, zeros counted, pro-rated by days.
 *             Sales are not what decides whether the order happens, so scaling
 *             by them was measured and cost about three points.
 *   the rest  a decayed level of recent months, re-scaled by how the window's
 *             sales compare with the sales those months carried. Sell more and
 *             the warehouse ships more; the level says how much more.
 *
 * Backtested on five target months (April to August 2026), against the model it
 * replaces — it won all five on every measure:
 *
 *                        card    by volume   bias    error/article
 *   old (6-month rate)   53.5%      78.2%    +33%      5,553
 *   this                 56.7%      81.3%     +9%      3,399
 *   ... regular only     72.1%      87.8%     +6%      2,042
 */
function quantityFor(held, sales, windowDays) {
  if (held.behaviour === 'rare') return held.medianAll * (windowDays / DAYS_PER_MONTH)

  /*
   * Two months of history is not enough to scale by sales.
   *
   * The ratio between shipments and sales would rest on one or two
   * observations, and re-scaling by it turns any difference between those
   * months and this one into a multiplier. Measured: scaling new articles by
   * sales took their bias to +32% and their error to 6,480 per article; taking
   * the level as it stands gives 0% bias and 4,381 — better than the model this
   * replaces, which managed +5% and 5,019.
   */
  if (held.behaviour === 'new') return held.level * (windowDays / DAYS_PER_MONTH)

  /*
   * No usable sales history behind the level — fall back to the level itself.
   *
   * Only reachable when every training month had zero sales, which means the
   * sales copy is missing rather than the brand being closed. Pro-rating by
   * days is the honest answer; multiplying by a ratio with nothing underneath
   * it is not.
   */
  if (!(held.salesBase > 0)) return held.level * (windowDays / DAYS_PER_MONTH)
  return held.level * (sales / held.salesBase)
}

export async function forecastFromConstants(
  brand,
  filters,
  { today = new Date(), basis = 'forecast' } = {}
) {
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

  /*
   * Two different tests for two different kinds of article.
   *
   * A recipe article's requirement comes from the menu: if no product that uses
   * it is forecast from tomorrow, there is no requirement coming however much
   * the warehouse shipped in the spring. A non-recipe article has no menu to
   * ask, so the question becomes whether it is still moving at all.
   *
   * Both are exclusions from the forecast itself rather than filters on the
   * page, so the quantity, the accuracy, the totals, the exports and everything
   * downstream see the same set.
   *
   * The catch-all bucket is neither: those articles reach no brand, so there is
   * no menu behind them and the activity test is the only one that applies.
   */
  const wide = brand === OTHER_BUCKET
  const [recipeArticles, future, menuDriven] = await Promise.all([
    wide ? new Set() : cube.recipeArticles().catch(() => new Set()),
    wide ? null : articlesWithFutureDemand(brand, { today }),
    wide ? null : articlesWithAnyFutureDemand({ today }),
  ])

  /*
   * Which sales figure the rate is applied to.
   *
   * The constant is a rate — units shipped per unit sold — so multiplying it by
   * the sales forecast gives a forecast requirement, and multiplying it by the
   * sales that actually happened gives the requirement those sales implied.
   * That second one is the counterpart of the recipe explosion's Actual qty,
   * and computing it here rather than in a second function keeps both halves
   * derived from exactly the same constants.
   */
  const read = basis === 'actual' ? cube.actualSales : cube.forecastSales
  const sales = await read(brand, filters, { allBrands: brand === OTHER_BUCKET })
  if (!sales) return new Map()

  /*
   * How much of a month the window on screen is worth.
   *
   * Only the intermittent branch below uses it — a median month spread over
   * ten days is a third of itself, where the rate-based branch gets the same
   * effect for free from the window's own sales.
   */
  const windowDays =
    filters?.dateFrom && filters?.dateTo
      ? Math.max(
          1,
          Math.round(
            (Date.parse(`${filters.dateTo}T00:00:00Z`) -
              Date.parse(`${filters.dateFrom}T00:00:00Z`)) /
              86_400_000
          ) + 1
        )
      : DAYS_PER_MONTH

  const out = new Map()
  for (const [article, held] of constants) {
    /*
     * Is the article still moving? The fallback both branches share.
     */
    const stillMoving = () =>
      (held.detail ?? []).slice(-ACTIVE_MONTHS).some((d) => d.outbound > 0)

    if (recipeArticles.has(article)) {
      /*
       * Recipe article: forecast only while a menu item still wants it.
       *
       * `future` is null when the question could not be asked — a failed query
       * must not read as a menu that has emptied, so the article is left alone.
       */
      if (future && !future.has(article)) {
        /*
         * Being named in a recipe does not make something menu-driven.
         *
         * Gloves, napkins, paper bags and face masks are all in the recipe
         * master, and no menu forecast will ever reach them — nothing on a menu
         * is measured in gloves. Demanding a signal that cannot arrive blanked
         * 1.75 million units of consumables that ship every week.
         *
         * So the menu rule only applies where a menu actually drives the
         * article. Where no brand's menu wants it at all, it is not an
         * ingredient in any meaningful sense, and the question becomes the one
         * asked of every other warehouse-only article: is it still moving?
         *
         * `menuDriven` null means the question could not be answered, and the
         * permissive reading is the right one — a failed query must not delete
         * a forecast. Asked for on 9 Sep 2026.
         */
        if (menuDriven && menuDriven.has(article)) continue
        if (!stillMoving()) continue
      }
    } else if (!stillMoving()) {
      continue
    }

    /*
     * Two ways to reach a quantity, chosen by how the article behaves.
     *
     * A regular article is a rate applied to sales — sell more and the
     * warehouse ships more. An intermittent one is not: its median month is a
     * quantity, and it is pro-rated by the length of the window rather than by
     * sales, because sales are not what decides whether the order happens.
     *
     * Scaling the median by sales instead was measured and cost about three
     * points of accuracy, so the difference is not cosmetic.
     */
    const qty = LEGACY_MODEL
      ? held.intermittent && held.fixedMonthly > 0
        ? held.fixedMonthly * (windowDays / DAYS_PER_MONTH)
        : held.constant * sales
      : quantityFor(held, sales, windowDays)

    /*
     * A forecast of zero is a forecast, and it stays on the page.
     *
     * Dropping it would be the easy way to a better-looking card: an article
     * with nothing forecast and nothing shipped cannot be scored, so it would
     * quietly leave the average. But a zero is the model's actual answer for a
     * rare article in a quiet month, and it has to be held to it — when the
     * article does ship, that zero scores 0% and counts. Only a figure that is
     * not a number at all is skipped.
     */
    if (!Number.isFinite(qty) || qty < 0) continue
    out.set(article, qty)
  }
  return out
}
