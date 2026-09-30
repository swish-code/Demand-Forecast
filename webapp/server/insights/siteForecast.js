import * as cube from '../cube/query.js'
import {
  ALPHA,
  constantsFor,
  pastMonths,
  quantityFor,
  resolveBasis,
  DAYS_PER_MONTH,
} from './whConstant.js'

/**
 * Forecasting a PREPARED article from what the kitchens actually issued.
 *
 * The Production pages forecast every article one way: multiply forecast sales
 * by what the recipes say each sale needs. This is a second opinion that never
 * looks at a recipe, and it asks the warehouse forecast's question of a
 * different source:
 *
 *     for every dinar this brand sold last month, how much of this article
 *     did the PRODUCTION SITES have to issue?
 *
 * WHY THE WAREHOUSE MODEL COULD NOT SIMPLY BE POINTED AT THIS
 *
 * It can, and that is exactly what happens - `constantsFor` takes a `source` and
 * the arithmetic below is `quantityFor`, both unchanged. What could not be
 * reused is `forecastFromConstants`, which carries warehouse-specific machinery:
 * the menu-driven test that keeps gloves and napkins in the forecast, the
 * recipe-article exclusion, and the catch-all bucket. None of those apply to a
 * prepared article - a PA article is menu-driven by definition, and excluding it
 * on a missing menu signal would blank rows the kitchens demonstrably issue.
 *
 * WHAT IT WAS MEASURED AT
 *
 * Backtested 29 Sep 2026 against the recipe explosion on PA articles, four
 * target months, both methods scored on identical rows with
 * 1 - |F-A| / MAX(F,A):
 *
 *               per-article   by volume    bias   error/article
 *   recipe mix       64.8%       70.7%     -24%          1,548
 *   this             85.3%       89.8%      -1%            574
 *
 * It won every month on every measure. The bias is the finding that matters:
 * the recipe explosion under-forecast PA articles by 20-27% in every month
 * tested, which is a standing shortfall rather than noise.
 *
 * On its own terms over six target months it ran 69.7-74.4% per article and
 * 84.5-92.6% by volume, with bias between -1% and +8%.
 *
 * WHAT IT IS NOT
 *
 * It learns BEHAVIOUR, not requirement. If the kitchens habitually issue more
 * than a recipe implies, this asks for that too; the recipe says what should be
 * needed. That is the reason both figures are shown side by side and neither
 * replaces the other - the same arrangement Stock Article already uses for the
 * warehouse forecast.
 */

/**
 * article number -> forecast quantity for the window, from site history.
 *
 * Empty rather than null when there is nothing to say, so a caller can stamp
 * every row it does have without checking.
 */
export async function siteForecastFor(brand, filters, { now = new Date() } = {}) {
  /*
   * Whole brand or nothing - the same rule the warehouse forecast follows.
   *
   * Both halves of the ratio are brand-level facts. Site outbound names a brand
   * and not a branch, and the sales total behind the rate has no product column
   * to narrow by, so under a branch or product filter the numerator would stay
   * whole while the denominator shrank and the column would read several times
   * too high. Blank is the honest answer, and it is the same answer the Site
   * outbound column gives to the same question.
   */
  if (filters?.locations?.length || filters?.products?.length || filters?.articles?.length) {
    return new Map()
  }

  /*
   * The window decides which months this may learn from, not the calendar.
   *
   * `resolveBasis` is reused rather than reimplemented so the leakage rule is
   * defined once: a finished month may not be forecast from its own sales, and
   * `constantsFor` throws if the training months are not strictly before the
   * target month.
   */
  const { anchor, mode } = resolveBasis(filters, { now })

  const constants = await constantsFor(brand, { anchor, source: 'site' }).catch((err) => {
    console.warn(`  [site-forecast] ${brand}: ${String(err.message).slice(0, 90)}`)
    return null
  })
  if (!constants?.size) return new Map()

  const historical = mode === 'historical'
  /*
   * A finished window has no honest sales signal.
   *
   * Its actuals are the answer and may not be used to forecast it. With no
   * retained forecast for that window, each article falls back to its own
   * decayed sales base scaled to the window - the only figure that was knowable
   * before the window opened. The ratio then cancels to the decayed level
   * itself, which looks like a bug and is not; the warehouse forecast documents
   * the same identity at length.
   */
  const windowSales = historical
    ? null
    : await cube.forecastSales(brand, filters).catch(() => null)
  if (!historical && !windowSales) return new Map()

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
    const sales = windowSales ?? held.salesBase * (windowDays / DAYS_PER_MONTH)
    const qty = quantityFor(held, sales, windowDays)
    /*
     * A forecast of zero is a forecast and it stays.
     *
     * Dropping it would be the easy route to a better-looking accuracy: an
     * article with nothing forecast and nothing issued cannot be scored, so it
     * would quietly leave the average. But zero is the model's real answer for a
     * rare article in a quiet month, and it has to be held to it - when the
     * article does move, that zero scores 0% and counts.
     */
    if (!Number.isFinite(qty) || qty < 0) continue
    out.set(article, qty)
  }
  return out
}

/**
 * The same forecast for an article that reaches no brand at all.
 *
 * WHY IT CANNOT USE THE FUNCTION ABOVE
 *
 * `siteForecastFor` is a RATE: outbound per dinar of a brand's sales, applied to
 * that brand's forecast sales. Both halves are brand-scoped, and for a good
 * reason - it is what lets the figure sit beside that brand's forecast and be
 * compared with it.
 *
 * Every Yelo Factory article falls outside that. Audited 30 Sep 2026: all nine
 * of them send 100% of their output - 136,431 units over Mar-Aug - to FM, to
 * CKU/CPU, to SWISH BAKERY and back to the Central Warehouse, and none to a
 * brand's shops. So the history is in the copy but under no brand key the rate
 * model asks for, and the Forecast column read blank beside an Outbound column
 * showing real quantities.
 *
 * WHAT IT DOES INSTEAD
 *
 * The same decayed level, pro-rated by the length of the window rather than
 * scaled by sales:
 *
 *     level  = ALPHA-decayed monthly outbound, oldest to newest
 *     qty    = level x (days in the window / 30.44)
 *
 * Dropping the sales term is a decision, not a simplification. Sales are not
 * what drives these quantities: a batch sent to FM or transferred to the bakery
 * happens because somebody ordered it, and dividing by a brand's sales would
 * scale it by a number with no causal link to it. `quantityFor` already makes
 * exactly this call for its `rare` and `new` classes, where it was measured as
 * the better answer - scaling those by sales cost about three points of
 * accuracy.
 *
 * The trade-off, stated plainly: this cannot respond to a brand selling more.
 * It says "this article has been going out at about this rate lately", which is
 * the strongest claim the evidence supports when the destination is not a brand.
 */
export async function siteForecastAllDestinations(filters, { now = new Date() } = {}) {
  if (filters?.locations?.length || filters?.products?.length || filters?.articles?.length) {
    return new Map()
  }

  const { anchor } = resolveBasis(filters, { now })
  const months = pastMonths(anchor, 6)
  const history = await cube.siteOutboundAllByMonth(months).catch((err) => {
    console.warn(`  [site-forecast-all] ${String(err.message).slice(0, 90)}`)
    return null
  })
  if (!history?.size) return new Map()

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

  const ordered = [...months].sort()
  const out = new Map()
  for (const [article, byMonth] of history) {
    const all = ordered.map((m) => byMonth.get(m) ?? 0)
    /*
     * The average starts at the article's first issue, not six months ago - the
     * same rule the warehouse constant follows, and for the same reason: a zero
     * before anything was ever issued is not evidence of a quiet month, it is
     * evidence the article had not started.
     */
    const first = all.findIndex((q) => q > 0)
    if (first === -1) continue
    const detail = all.slice(first)
    const decay = detail.map((_, i) => (1 - ALPHA) ** (detail.length - 1 - i))
    const total = decay.reduce((n, w) => n + w, 0)
    const level = detail.reduce((n, q, i) => n + q * decay[i], 0) / total
    const qty = level * (windowDays / DAYS_PER_MONTH)
    if (!Number.isFinite(qty) || qty < 0) continue
    out.set(article, qty)
  }
  return out
}
