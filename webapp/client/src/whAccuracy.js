/**
 * The stock rule on warehouse forecast accuracy, in one place.
 *
 * Asked for on 26 Sep 2026: where the shops already hold at least twice what
 * was forecast, the warehouse not shipping is the correct outcome, so the
 * forecast is not marked down for it.
 *
 *   2 x WH Forecast Qty  <=  Store SOH   ->  100%
 *
 * Applied BEFORE the ordinary score, so it wins outright rather than being
 * blended with it.
 *
 * WHAT THIS DOES TO THE NUMBER, MEASURED BEFORE IT WAS BUILT
 *
 * Over the 2-24 Sep window, 1,485 scored article-rows:
 *
 *   rows meeting the condition      1,181  (79.5%)
 *   of those, previously under 50%    537
 *   average WH ACC%   49.2%  ->  90.8%   (+41.5 points)
 *
 * So this is not a correction at the margin. Roughly four rows in five now
 * score 100%, and the average moves by more than forty points. Anyone
 * comparing a figure from before this date with one after it is comparing two
 * different measurements.
 *
 * THE CASE AGAINST IT, RECORDED BECAUSE IT IS GOOD
 *
 * The reasoning is sound on its face - a shop that is full does not need a
 * delivery. But the backtest in `server/insights/storeStock.js` found store
 * stock correlates with what the warehouse actually shipped at r = +0.80,
 * POSITIVELY, across 28,147 brand-article-weeks: shops holding more of an
 * article receive more of it, because stock and shipment are both driven by
 * how much that shop sells. High store stock therefore mostly means "busy
 * article" rather than "needs nothing".
 *
 * There is also a direction problem. The test is `2 x forecast <= SOH`, so a
 * SMALLER forecast is more likely to qualify - under-forecasting is what earns
 * the perfect score. Nothing here detects that, and no score above tells the
 * reader it happened.
 *
 * Both points were put to the business on 26 Sep 2026 with these figures and
 * the rule was confirmed. It is recorded here so that whoever reads a 100%
 * later knows which of the two things it can mean.
 */

/** Did the stock rule decide this row, rather than the forecast? */
export function coveredByStock(forecast, storeSoh) {
  const f = Number(forecast)
  const s = Number(storeSoh)
  /*
   * A missing reading is not cover.
   *
   * About 5% of forecast rows have no store SOH at all - the inventory model
   * has never seen the article in these shops - and that says nothing about
   * whether the shops were stocked. Treating unknown as covered would hand a
   * perfect score to the rows we know least about.
   */
  if (!Number.isFinite(f) || !Number.isFinite(s)) return false
  /*
   * A negative book balance is an accounting artefact, not stock on a shelf,
   * and it can never satisfy the condition anyway. Stated rather than left to
   * the arithmetic, because `2 x 0 <= 0` is true and a forecast of zero
   * against no stock is not a covered shop.
   */
  if (s <= 0 || f <= 0) return false
  return 2 * f <= s
}

/**
 * The warehouse forecast score for one row.
 *
 * `plain` is whatever the caller's ordinary formula produced - every caller
 * already has one and they differ slightly in how they treat missing sides, so
 * it is passed in rather than recomputed here.
 */
export function whAccuracy(plain, forecast, storeSoh) {
  // The stock rule only ever LIFTS a score that exists. A row with nothing to
  // compare stays blank: no outbound and no forecast is not a perfect forecast.
  if (plain === null || plain === undefined) return plain
  return coveredByStock(forecast, storeSoh) ? 1 : plain
}
