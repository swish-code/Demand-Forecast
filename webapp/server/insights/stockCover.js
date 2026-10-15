/**
 * The stock rule, server side.
 *
 * "An article whose shops already hold at least twice the forecast scores
 * 100%, because not shipping was right." The rule was put to the business on
 * 26 Sep 2026 and confirmed.
 *
 * WHY THERE ARE TWO COPIES
 *
 * The authoritative statement of this rule, with the full reasoning behind
 * each guard, is `client/src/whAccuracy.js`. This file exists because the
 * SERVER has to evaluate the rule too, and it cannot import from the client:
 * that directory is a separate package with its own build, and a server
 * deployed without `client/src` would fail to start.
 *
 * Two copies of a business rule is the kind of thing this codebase has been
 * bitten by before, so the duplication is not left to good intentions:
 * `stockCover.test.js` imports BOTH this function and the client's and asserts
 * they agree across a matrix of inputs, including every boundary below. If one
 * is edited and the other is not, that test fails.
 *
 * Added 5 Oct 2026, when the rule had to run for accounts that may not see the
 * stock quantity it reads - see `withStoreStock` in routes/api.js.
 */
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
