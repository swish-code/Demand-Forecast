import test from 'node:test'
import assert from 'node:assert/strict'
import { averageScore, weightedScore } from './scores.js'
import { whAccuracy, plainWhScore, stockRuleFor, stockRuleDecision } from './whAccuracy.js'

/*
 * Stock Article's own row scorer, copied verbatim from ComponentLevel.jsx so
 * the two can be compared directly. If that page ever changes, this copy stops
 * matching and the parity tests below fail, which is the point of having it.
 */
const stockArticleRescore = (consumed) => (target) => {
  const known = consumed !== null && consumed !== undefined
  if (!known || target === null || target === undefined) return null
  const outbound = Number(consumed)
  const bigger = Math.max(outbound, Number(target))
  return bigger > 0 ? 1 - Math.abs(Number(target) - outbound) / bigger : null
}

/*
 * The two shared accuracy helpers, and the rounding rule that sits on top of
 * them.
 *
 * Written on 15 Oct 2026 alongside three fixes to the Procurement cards: the
 * missing `count`, and the discovery that Procurement scored the pack-rounded
 * forecast where Stock Article scores the unrounded one.
 */

const row = (article, score, weight) => ({
  'Item No.': article,
  WH_Accuracy: score,
  Consumed_Qty: weight,
})

test('weightedScore reports how many articles it scored', () => {
  const got = weightedScore([row('A', 1, 100), row('B', 0.5, 100)], 'WH_Accuracy', 'Consumed_Qty')
  /*
   * The caption on the Procurement card asked for this and it did not exist,
   * so a real percentage was printed under the words "0 scored".
   */
  assert.equal(got.count, 2)
  assert.equal(got.value, 0.75)
  assert.equal(got.weight, 200)
})

test('count matches averageScore over the same rows', () => {
  const rows = [row('A', 1, 10), row('B', 0.4, 0), row('C', null, 50), row('A', 0.1, 999)]
  const weighted = weightedScore(rows, 'WH_Accuracy', 'Consumed_Qty')
  const plain = averageScore(rows, 'WH_Accuracy')
  /*
   * "N scored" has to mean the same thing on both cards. An article with no
   * volume still counts as scored, and a repeated article counts once.
   */
  assert.equal(weighted.count, plain.count)
  assert.equal(weighted.count, 2, 'A and B; C has no score, and A is not counted twice')
})

test('an article is counted once however many recipe rows carry it', () => {
  const got = weightedScore(
    [row('A', 1, 100), row('A', 0, 100), row('A', 0, 100)],
    'WH_Accuracy',
    'Consumed_Qty'
  )
  assert.equal(got.count, 1)
  assert.equal(got.value, 1, 'the first row for an article wins, as it always has')
})

test('no volume is no answer, not a zero', () => {
  assert.equal(weightedScore([row('A', 0.9, 0)], 'WH_Accuracy', 'Consumed_Qty'), null)
})

test('rounding a forecast up to a pack lowers the score it would earn', () => {
  // An article forecast at 950, bought in packs of 500, so the order is 1,000.
  const unrounded = 950
  const rounded = 1000
  const shipped = 900

  const scoredOnUnrounded = plainWhScore(unrounded, shipped)
  const scoredOnRounded = plainWhScore(rounded, shipped)

  assert.ok(
    scoredOnRounded < scoredOnUnrounded,
    'rounding only ever lifts the forecast, so it only ever widens the gap'
  )
  /*
   * This is the whole of the 86.3% against 88.1%: the same formula over the
   * same outbound, differing only in which forecast it was given.
   */
  assert.equal(Number(scoredOnUnrounded.toFixed(4)), 0.9474)
  assert.equal(Number(scoredOnRounded.toFixed(4)), 0.9)
})

test('the unrounded figure falls back to the rounded one when there is no rounding', () => {
  /*
   * `WH_Forecast_Unrounded` is only sent when the server actually rounded
   * something, and is absent for accounts that may not see pack sizes. The
   * `??` fallback is what keeps those accounts scoring exactly as before.
   */
  const r = { WH_Constant_Forecast_Qty: 500, WH_Forecast_Unrounded: undefined }
  assert.equal(r.WH_Forecast_Unrounded ?? r.WH_Constant_Forecast_Qty, 500)

  const rounded = { WH_Constant_Forecast_Qty: 1000, WH_Forecast_Unrounded: 950 }
  assert.equal(rounded.WH_Forecast_Unrounded ?? rounded.WH_Constant_Forecast_Qty, 950)
})

test('the stock rule still wins outright, whichever forecast is scored', () => {
  /*
   * 2 x forecast <= Store SOH scores 100%, and that must not change because
   * the forecast being scored changed. Tested on the unrounded figure, which
   * is the one now passed in.
   */
  assert.equal(whAccuracy(0.3, 950, 5000, undefined), 1)
  assert.equal(whAccuracy(0.3, 950, 100, undefined), 0.3, 'not covered, so the plain score stands')
  assert.equal(whAccuracy(null, 950, 5000, undefined), null, 'nothing to lift stays nothing')
})

/*
 * Parity with Stock Article.
 *
 * Three separate things made the two pages disagree, and each gets its own
 * test: a missing outbound, the stock rule's argument, and the forecast that
 * is scored.
 */

test('a missing outbound scores nothing on BOTH pages', () => {
  /*
   * The 64-article gap: 1,153 scored on Procurement against 1,089 on Stock
   * Article, for the same September data. `Number(null)` is 0 and 0 is
   * finite, so these articles used to score 0% here and be excluded there.
   */
  assert.equal(stockArticleRescore(null)(500), null, 'Stock Article: excluded')
  assert.equal(plainWhScore(500, null), null, 'Procurement: now also excluded')
  assert.equal(plainWhScore(500, undefined), null)
})

test('plainWhScore agrees with Stock Article wherever both have an answer', () => {
  const cases = [
    [500, 500],
    [500, 400],
    [400, 500],
    [950, 900],
    [0, 100],
    [100, 0],
    [0, 0],
  ]
  for (const [forecast, outbound] of cases) {
    assert.equal(
      plainWhScore(forecast, outbound),
      stockArticleRescore(outbound)(forecast),
      `forecast ${forecast} against outbound ${outbound}`
    )
  }
})

test('the stock rule is asked the same way it is asked on Stock Article', () => {
  /*
   * Stock Article re-derives from the row's own Store SOH when it has one and
   * trusts the server's flag only when it does not. Procurement always passed
   * the flag, so the rule fired on a different set of rows.
   */
  assert.equal(stockRuleFor(5000, false), undefined, 'SOH known: re-derive, ignore the flag')
  assert.equal(stockRuleFor(0, true), undefined, 'a zero balance is still a reading')
  assert.equal(stockRuleFor(null, true), true, 'no SOH: fall back to the server flag')
  assert.equal(stockRuleFor(undefined, false), false)
  assert.equal(stockRuleFor(null, undefined), undefined, 'neither: let whAccuracy decide')
})

test('with a known SOH the rule is re-derived, not taken from the flag', () => {
  /*
   * The case that mattered. 2 x 950 <= 5000, so the article is covered and
   * scores 100% - even though the server flag says otherwise. Procurement
   * previously handed the flag straight through and scored 30%.
   */
  const plain = 0.3
  assert.equal(whAccuracy(plain, 950, 5000, stockRuleFor(5000, false)), 1)
  // And the reverse: not covered, so the plain score stands.
  assert.equal(whAccuracy(plain, 950, 100, stockRuleFor(100, true)), plain)
})

test('a total row with no Store SOH cannot apply the rule at all', () => {
  /*
   * What was actually happening on the all-months row: the fold wrote
   * Store_SOH per month and never onto the row the card reads, so this is the
   * call that was being made for every article. The rule could only ever
   * answer "not covered".
   */
  assert.equal(whAccuracy(0.3, 950, undefined, stockRuleFor(undefined, undefined)), 0.3)
  // With the balance now carried onto that row, the same article is covered.
  assert.equal(whAccuracy(0.3, 950, 5000, stockRuleFor(5000, undefined)), 1)
})

test('which stock-rule branch applies depends on how many rows folded', () => {
  /*
   * Stock Article uses two different rules here and picks between them on
   * `r.__n > 1`. Procurement applying only the folded one is what left it
   * reading 89.0% against 88.1%.
   */
  // One recipe line: the server's flag is passed straight through, even
  // though a Store SOH is present.
  assert.equal(stockRuleDecision(1, 5000, false), false)
  assert.equal(stockRuleDecision(1, 5000, true), true)

  // Several: re-derive from the folded row's own summed Store SOH instead.
  assert.equal(stockRuleDecision(3, 5000, false), undefined)
  assert.equal(stockRuleDecision(3, null, true), true, 'no SOH to re-derive from')
})

test('the two branches can disagree, which is the whole point of matching them', () => {
  /*
   * An article the server marked uncovered, with a Store SOH that satisfies
   * the rule. On one recipe line Stock Article scores it on the flag; on
   * several it re-derives and scores 100%.
   */
  const plain = 0.3
  const single = whAccuracy(plain, 950, 5000, stockRuleDecision(1, 5000, false))
  const folded = whAccuracy(plain, 950, 5000, stockRuleDecision(4, 5000, false))
  assert.equal(single, plain, 'one line: the flag says not covered')
  assert.equal(folded, 1, 'several lines: re-derived, and 2 x 950 <= 5000')
  assert.notEqual(single, folded)
})

test('a volume-weighted footer is not the same figure as an unweighted one', () => {
  /*
   * The Procurement WH ACC% footer read 77.2% under a card reading 89.0%.
   * Both were correct arithmetic on the same rows - they were simply two
   * different measurements, because the footer took a plain mean where Stock
   * Article weights by outbound.
   *
   * A big article scoring well beside a tiny one scoring badly is all it takes
   * for the two to diverge sharply.
   */
  const rows = [
    { 'Item No.': 'BIG', WH_Accuracy: 0.95, Consumed_Qty: 600_000 },
    { 'Item No.': 'TINY', WH_Accuracy: 0.1, Consumed_Qty: 40 },
  ]
  const unweighted = averageScore(rows, 'WH_Accuracy').value
  const weighted = weightedScore(rows, 'WH_Accuracy', 'Consumed_Qty').value

  assert.equal(Number(unweighted.toFixed(3)), 0.525, 'the plain mean is dragged down by the tiny line')
  assert.ok(weighted > 0.949, 'weighted by volume, the big line is what the number is about')
})
