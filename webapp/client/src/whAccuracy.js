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
/**
 * Did the stock rule fire for this row?
 *
 * `decided` is the server's own answer, sent as `Stock_Covered`. It is used in
 * preference to re-deriving, because an account that may not see the stock
 * QUANTITY still has to get the same score as one that may - and from 5 Oct
 * 2026 the server evaluates the rule for everyone and withholds only the
 * number. Where no answer was sent, the rule is applied here exactly as before.
 *
 * Only a real boolean is taken as decided. `undefined` means "the server did
 * not say", which is not the same as "no".
 */
function ruleFired(decided, forecast, storeSoh) {
  if (typeof decided === 'boolean') return decided
  return coveredByStock(forecast, storeSoh)
}

export function whAccuracy(plain, forecast, storeSoh, decided) {
  // The stock rule only ever LIFTS a score that exists. A row with nothing to
  // compare stays blank: no outbound and no forecast is not a perfect forecast.
  if (plain === null || plain === undefined) return plain
  return ruleFired(decided, forecast, storeSoh) ? 1 : plain
}

/**
 * The OTHER warehouse score: what shipped as a share of what was forecast.
 *
 *   Actual / Forecast, with the same stock rule applied first.
 *
 * Asked for on 26 Sep 2026 as a column of its own beside WH ACC%, and as the
 * figure the "Outbound vs forecast" card averages.
 *
 * NOT the same measurement as `whAccuracy` above, and the difference matters:
 *
 *   WH ACC%   1 - |f - o| / MAX(f, o)   symmetric, bounded 0-1. Shipping
 *                                       double and shipping half both score 50%.
 *   this one  o / f                     directional and UNBOUNDED. Shipping
 *                                       double scores 200%, shipping half 50%.
 *
 * So a high number here is not necessarily good - it can mean the warehouse
 * issued far more than was predicted. Measured over 1-23 Sep: 461 of 1,467
 * articles are above 100%, 49 are above 300%, and the largest is 2,757%.
 *
 * Left uncapped because that is the formula as specified. It does mean the
 * average is pulled about by a handful of small articles with enormous ratios,
 * and it is why applying the stock rule LOWERS the headline rather than
 * raising it: the rule sets covered rows to exactly 100%, and many of them
 * were above it. Averages measured on the same window:
 *
 *   ratio of totals (what the card did before)   92.9%
 *   average of rows, no stock rule               95.1%
 *   average of rows, with the stock rule         91.7%
 */
export function whRatioAccuracy(outbound, forecast, storeSoh, decided) {
  const f = Number(forecast)
  const o = Number(outbound)
  // No forecast, no ratio - dividing by nothing is not a score of zero.
  if (!Number.isFinite(f) || f <= 0) return null
  if (ruleFired(decided, f, storeSoh)) return 1
  if (!Number.isFinite(o)) return null
  return o / f
}

/*
 * A MISSING side is not a zero side.
 *
 * `Number(null)` is 0, and 0 is finite, so a null outbound used to pass the
 * guard below and score the article at 0% - a forecast judged completely wrong
 * against a warehouse reading that does not exist. Stock Article has always
 * refused that: its `rescore` tests `c !== null && c !== undefined` BEFORE
 * converting, and returns null.
 *
 * It is why the two pages scored different numbers of articles for the same
 * period - 1,153 here against 1,089 there, the 64 difference being exactly the
 * articles with a forecast and no outbound.
 */
export function plainWhScore(forecast, outbound) {
  if (forecast === null || forecast === undefined) return null
  if (outbound === null || outbound === undefined) return null
  const f = Number(forecast)
  const o = Number(outbound)
  if (!Number.isFinite(f) || !Number.isFinite(o)) return null
  const worst = Math.max(f, o)
  if (worst <= 0) return null
  return 1 - Math.abs(f - o) / worst
}

/**
 * Which answer the stock rule should be given, exactly as Stock Article picks it.
 *
 * `whAccuracy` takes a `decided` flag and only falls back to working the rule
 * out itself when that flag is `undefined`. The two pages were passing
 * different things:
 *
 *   Stock Article  re-derives from the row's OWN Store SOH whenever it has
 *                  one, and trusts the server's flag only when it does not -
 *                  see ComponentLevel.jsx, `WH_Accuracy`.
 *   Procurement    always passed the server's flag.
 *
 * The rule sets a row to 100% outright, so disagreeing about it moves the
 * headline a long way. This makes Procurement ask the question the same way.
 */
export const stockRuleFor = (storeSoh, covered) =>
  storeSoh === null || storeSoh === undefined ? covered : undefined

/**
 * The branch Stock Article actually takes, reproduced so Procurement can take
 * the same one.
 *
 * Stock Article does not use one rule here, it uses two, and which one depends
 * on how many recipe lines folded into the article:
 *
 *   one line    `whAccuracy(..., r.Store_SOH, r.Stock_Covered)` - the server's
 *               flag is passed straight through, and only an absent flag falls
 *               back to re-deriving. (ComponentLevel.jsx, the `carriesWarehouse`
 *               branch.)
 *   several     the folded row re-derives from its OWN summed Store SOH, and
 *               consults the flag only when it has no SOH at all - `stockRuleFor`
 *               above. (The `folded` branch, after the `if (!folded) return r`.)
 *
 * That difference is not obviously deliberate, and the two branches can
 * disagree about the same article. It is reproduced rather than tidied because
 * the requirement is that the two pages agree, and Stock Article is the one
 * being matched - a "fix" here would move its figure, which is explicitly out
 * of scope.
 *
 * Procurement applying only the second branch is what left it reading 89.0%
 * against 88.1%: re-deriving marks more articles covered than the flag does,
 * and a covered article scores 100% outright.
 */
export const stockRuleDecision = (rowsFolded, storeSoh, covered) =>
  rowsFolded > 1 ? stockRuleFor(storeSoh, covered) : covered
