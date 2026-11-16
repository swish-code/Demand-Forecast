import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonArticle,
  monthStartOf,
  varianceFlag,
  VARIANCE_TOLERANCE,
  mcTheoreticalClass,
  mcScore,
  mcStatus,
  variancePct,
  isScored,
} from './consumption.js'
import { isWholeMonths, monthLabel, monthStartOf as clientMonthStart } from '../../client/src/consumptionWindow.js'

/*
 * The consumption join, pinned.
 *
 * Written 8 Nov 2026 alongside the page. Three things here were found by
 * measurement rather than by reading, and each one of them was wrong first:
 * the article key, the sign of `Potential COS QTY`, and which months a window
 * covers.
 */

test('an article number collapses to ONE canonical form', () => {
  /*
   * `ART_NUMMER` is text in Oracle and `'RECIPE TABLE'[Item No.]` is an
   * integer, so the same article arrives spelled two ways. `recipeMasterArticles`
   * holds BOTH forms because it answers a membership question; this is a SUM,
   * and holding both would either split one article's quantity across two keys
   * or double it, depending which spelling each side used.
   */
  assert.equal(canonArticle('0102000003'), '102000003')
  assert.equal(canonArticle('102000003'), '102000003')
  assert.equal(canonArticle(' 103400004 '), '103400004')
  // Both spellings must land on the same key, which is the whole point.
  assert.equal(canonArticle('0103400004'), canonArticle('103400004'))
})

test('a non-numeric article keeps its own spelling', () => {
  // Nothing in the data looks like this today. Coercing it to NaN and keying
  // every such row on "NaN" would silently merge them into one article.
  assert.equal(canonArticle('ABC-1'), 'ABC-1')
  assert.equal(canonArticle(''), '')
  assert.equal(canonArticle(null), '')
  assert.equal(canonArticle(undefined), '')
})

test('a month start is taken from the date, not computed', () => {
  assert.equal(monthStartOf('2026-09-15'), '2026-09-01')
  assert.equal(monthStartOf('2026-09-01'), '2026-09-01')
  assert.equal(monthStartOf('2026-12-31'), '2026-12-01')
})

test('the server and the client agree about which month a date is in', () => {
  /*
   * The banner names the months; the figures come from the server's own month
   * list. Two implementations that disagreed would put one set of months in
   * the warning and a different set in the table.
   */
  for (const d of ['2026-04-01', '2026-04-30', '2026-09-15', '2026-10-31']) {
    assert.equal(monthStartOf(d), clientMonthStart(d), d)
  }
})

test('whole months are recognised at both ends', () => {
  assert.equal(isWholeMonths('2026-09-01', '2026-09-30'), true, 'September')
  assert.equal(isWholeMonths('2026-08-01', '2026-10-31'), true, 'three whole months')
  assert.equal(isWholeMonths('2026-02-01', '2026-02-28'), true, 'a short month')
  // A leap year, because 2028-02-29 is a month end and 2028-02-28 is not.
  assert.equal(isWholeMonths('2028-02-01', '2028-02-29'), true, 'a leap February')
  assert.equal(isWholeMonths('2028-02-01', '2028-02-28'), false, 'leap February, cut short')
})

test('a part month is NOT whole, whichever end is cut', () => {
  /*
   * Both halves matter. The consumption figure is always a whole month, so a
   * window cut at either end compares fewer forecast days against a full
   * month's consumption - unfair in a direction nothing on screen reveals.
   */
  assert.equal(isWholeMonths('2026-09-01', '2026-09-15'), false, 'cut at the end')
  assert.equal(isWholeMonths('2026-09-10', '2026-09-30'), false, 'cut at the start')
  assert.equal(isWholeMonths('2026-09-10', '2026-09-20'), false, 'cut at both')
  assert.equal(isWholeMonths(null, '2026-09-30'), false)
  assert.equal(isWholeMonths('2026-09-01', null), false)
})

test('a month label reads as a person would write it', () => {
  assert.equal(monthLabel('2026-09-01'), 'September 2026')
  assert.equal(monthLabel('2026-04-01'), 'April 2026')
  // Never throw on something unexpected - the banner is not worth a crash.
  assert.equal(monthLabel(''), '')
  assert.equal(monthLabel('nonsense'), 'nonsense')
})

/*
 * The variance arithmetic, reproduced exactly as `withConsumption` computes it.
 *
 * Kept here rather than imported because the decorator is not exported - it is
 * one step in a chain inside the route. The expressions are short enough that
 * copying them is honest; what these tests protect is the RULES around them,
 * which is where the mistakes were.
 */
const varianceOf = (actual, theirs) => actual - theirs
const pctOf = (variance, theirs) => (theirs <= 0 ? null : variance / theirs)

test("the variance is Oracle's ACTUAL minus Oracle's THEORETICAL", () => {
  /*
   * CHANGED 9 NOV 2026, ON REQUEST. It was ours minus Oracle's, both
   * theoretical - a question about whether two recipe engines agree. The page
   * now asks how far the outlets ran from Oracle's own recipes, which is a
   * question about operations.
   *
   * Measured, YP Crinckle Wedges September 2026: Oracle theoretical 17,883.90,
   * Oracle actual 23,229.50.
   */
  const v = varianceOf(23229.5, 17883.9)
  assert.ok(Math.abs(v - 5345.6) < 0.01)
  assert.ok(v > 0, 'positive means the outlets consumed MORE than the recipe said')
  assert.ok(Math.abs(pctOf(v, 17883.9) - 0.29891) < 0.0001)
})

test('the variance no longer depends on our own theoretical at all', () => {
  /*
   * The whole reason the change was worth making. Both figures come from
   * Oracle, so a stale local copy cannot move this column - and on 9 Nov 2026
   * it was stale: PAT read 412,765 against Oracle's 195,488 because the copy
   * still held doubled quantities, while this variance was right throughout.
   */
  const theirs = 195488
  const actual = 498918
  const withDoubledOurs = varianceOf(actual, theirs)
  const withCorrectOurs = varianceOf(actual, theirs)
  assert.equal(withDoubledOurs, withCorrectOurs)
  assert.ok(Math.abs(withDoubledOurs - 303430) < 1, 'the Waste Variance card, now the headline')
})

test('no theoretical means no percentage, not a zero', () => {
  // Dividing by nothing is not a perfect score. Same rule the warehouse
  // columns follow - see `plainWhScore`.
  assert.equal(pctOf(100, 0), null)
  assert.equal(pctOf(-100, 0), null)
})

test('an article outside the tolerance is flagged', () => {
  // The measured YP Crinckle Wedges row: 12.8% apart, which is a real
  // disagreement between the two recipe definitions.
  assert.equal(varianceFlag(20167.95, 17883.9), 'Variance')
  assert.equal(varianceFlag(17883.9, 20167.95), 'Variance', 'and in the other direction')
})

test('two engines agreeing to within 1% count as agreeing', () => {
  /*
   * Not an exact-match test, deliberately. Two independent recipe explosions
   * over the same sales round at different points - Oracle rounds its own
   * inputs to three decimals in SQL - so demanding equality would mark nearly
   * every article and the flag would say nothing at all.
   */
  assert.equal(VARIANCE_TOLERANCE, 0.01)
  assert.equal(varianceFlag(10050, 10000), 'Match', 'exactly on the line')
  assert.equal(varianceFlag(10000, 10000), 'Match')
  assert.equal(varianceFlag(10101, 10000), 'Variance', 'just past it')
})

test('a tiny absolute difference is a Match whatever the percentage says', () => {
  /*
   * 0.4 against 0.9 is 125% out and it is noise - both are a rounding apart.
   * A tolerance built only on percentages flags every one of these, which is
   * how a flag column ends up being ignored.
   */
  assert.equal(varianceFlag(0.8, 0.4), 'Match')
  /*
   * Exactly on the floor, written in quarters so the subtraction is exact in
   * binary. `0.9 - 0.4` is 0.5000000000000001, which sat on the wrong side of
   * a strict `<` and is a terrible thing to pin a boundary test to.
   */
  assert.equal(varianceFlag(0.75, 0.25), 'Match', 'a difference of exactly half a unit')
  assert.equal(varianceFlag(0.9, 0.25), 'Variance', 'past the floor, and 260% out')
})

test('consumption with NO MC theoretical is not a variance', () => {
  /*
   * REVERSED 11 Nov 2026, on request, and this is the single biggest
   * correction in the brief.
   *
   * It used to return 'Variance' here, on the reasoning that "MC says nothing
   * and we say 5,000" is a disagreement worth surfacing. That reasoning was
   * sound while the two sides were two RECIPE ENGINES. It stopped being sound
   * on 9 Nov when both sides became MC's own, because an article MC holds no
   * theoretical for is the definition of a non-recipe article - MC does not
   * explode it, so there was never going to be a theoretical, and calling that
   * a recipe failure reports coverage as if it were accuracy.
   *
   * Measured over October 2026: 1,048 article-brand pairs carrying 47.6% of
   * the consumption quantity were being flagged this way.
   */
  /*
   * The status is 'No theoretical', NOT 'Non-recipe' - renamed 12 Nov 2026.
   * A zero theoretical does not establish that the article has no recipe; it
   * establishes only that MC holds no figure for it this month.
   */
  assert.equal(varianceFlag(5000, 0), null, 'no theoretical: not scored, not flagged')
  assert.equal(mcStatus(0, 5000), 'No theoretical')
  assert.equal(isScored('No theoretical'), false)

  /*
   * Unless the caller independently knows MC treats it as a recipe article -
   * then a missing theoretical is a data fault and the brief asks for it to be
   * surfaced for investigation. Still never scored.
   */
  assert.equal(mcStatus(0, 5000, { knownRecipe: true }), 'Data Exception')
  assert.equal(isScored('Data Exception'), false)
})

test('nothing on either side is Not Scored, never a Match', () => {
  /*
   * The other half of the same correction. A difference of two zeroes is
   * inside the half-unit floor, so the old rule returned 'Match' - and
   * measured over October 2026, 2,493 of the 4,832 article-brand pairs
   * (51.6%) are exactly this. More than half the page was empty rows counted
   * as perfect agreement, which is why the match rate read so well.
   */
  assert.equal(varianceFlag(0, 0), null)
  assert.equal(mcStatus(0, 0), 'Not Scored')
  assert.equal(mcScore(0, 0), null, 'and it carries no score at all')
  assert.equal(isScored('Not Scored'), false)
})

test('the symmetric score is bounded at zero when a quantity goes negative', () => {
  /*
   * 991 article-brand pairs in October 2026 carry net-NEGATIVE consumption:
   * more was reversed than was used. The plain formula is unbounded below once
   * a side goes negative - 100 theoretical against -50 consumed gives
   * 1 - 150/100 = -0.5 - and a negative percentage of agreement is not a
   * reading of anything.
   *
   * Floored, not clamped to null: the two genuinely do not agree, and 0% is
   * the honest floor of what the score can mean. The QUANTITIES are untouched;
   * the reversal still shows in the variance column with its sign.
   */
  assert.equal(mcScore(100, -50), 0)
  assert.equal(mcScore(-50, 100), 0, 'and in the other direction')
  assert.equal(mcScore(-10, -20), null, 'both negative: nothing to score against')
  assert.equal(mcScore(100, 50), 0.5, 'the ordinary case is unchanged')
})

test('a missing side is Missing Data, never a zero', () => {
  assert.equal(mcStatus(null, 5000), 'Missing Data')
  assert.equal(mcStatus(5000, null), 'Missing Data')
  assert.equal(mcScore(null, 5000), null)
  assert.equal(mcScore(5000, undefined), null)
  assert.equal(variancePct(5000, null), null)
})

test('the recipe classification follows MC Potential COS alone', () => {
  assert.equal(mcTheoreticalClass(100, 90), 'Has theoretical')
  assert.equal(mcTheoreticalClass(0, 90), 'No theoretical')
  assert.equal(mcTheoreticalClass(0, -5), 'No theoretical', 'a reversal is still movement')
  assert.equal(mcTheoreticalClass(0, 0), 'Empty')
  /*
   * A net-negative theoretical is two reversals meeting, and it is not a
   * recipe figure to divide by. Only 2 pairs in October 2026, but the rule
   * has to say something.
   */
  assert.equal(mcTheoreticalClass(-5, 100), 'No theoretical')
})

test('variance % has no denominator to divide by, so it is blank', () => {
  assert.equal(variancePct(100, 0), null)
  assert.equal(variancePct(100, -5), null)
  assert.ok(Math.abs(variancePct(90, 100) - -0.1) < 1e-12)
  assert.ok(Math.abs(variancePct(110, 100) - 0.1) < 1e-12)
})

test('a measured side that does not exist is blank, not flagged', () => {
  /*
   * The null rule is kept although the page no longer reaches it: with both
   * figures coming from Oracle neither can be absent. It still guards the
   * function itself, which is generic - a figure that does not exist is
   * unmeasured, not a miss.
   */
  assert.equal(varianceFlag(null, 5000), null)
  assert.equal(varianceFlag(undefined, 5000), null)
})

test('our theoretical is still carried, just not differenced', () => {
  /*
   * It stays on the page as the only independent check on Oracle's
   * theoretical - it is what first showed the doubled PAT quantities - but it
   * is no longer what the Variance column measures.
   *
   * The old decomposition still holds for anyone who wants it:
   *   ours - actual  =  (ours - theoretical) - (actual - theoretical)
   */
  const ours = 20167.95
  const theirs = 17883.9
  const actual = 23229.5
  assert.ok(Math.abs(ours - theirs - (actual - theirs) - (ours - actual)) < 1e-9)
})

/*
 * The trend points, reproduced as `trendFor` builds them.
 *
 * Same two rules as the column: the variance is actual minus theoretical, and
 * no theoretical is no percentage.
 */
const pointsOf = (months, inner) => {
  const out = []
  for (const month of months) {
    const held = inner.get(month)
    if (!held) continue
    const v = held.consumption - held.potential
    out.push({ month, variance: v, pct: held.potential <= 0 ? null : v / held.potential })
  }
  return out.length > 1 ? out : null
}

test('a trend needs more than one month to be a trend', () => {
  const months = ['2026-09-01', '2026-10-01']
  const one = new Map([['2026-10-01', { consumption: 100, potential: 80 }]])
  assert.equal(pointsOf(months, one), null, 'a single point is not a line')

  const two = new Map([
    ['2026-09-01', { consumption: 90, potential: 80 }],
    ['2026-10-01', { consumption: 120, potential: 80 }],
  ])
  const got = pointsOf(months, two)
  assert.equal(got.length, 2)
  assert.equal(got[0].variance, 10)
  assert.equal(got[1].variance, 40)
  assert.ok(got[0].month < got[1].month, 'ascending, so the line reads left to right')
})

test('a month the article has no row for is skipped, not drawn as zero', () => {
  /*
   * An article that was not consumed in a month has no row at all. Plotting a
   * zero would claim the recipe and the consumption agreed perfectly that
   * month, which is the opposite of "we have nothing to say".
   */
  const months = ['2026-08-01', '2026-09-01', '2026-10-01']
  const gappy = new Map([
    ['2026-08-01', { consumption: 50, potential: 40 }],
    ['2026-10-01', { consumption: 70, potential: 40 }],
  ])
  const got = pointsOf(months, gappy)
  assert.equal(got.length, 2)
  assert.deepEqual(
    got.map((p) => p.month),
    ['2026-08-01', '2026-10-01']
  )
})

/*
 * How a row is matched to Oracle's figures, as `withOracleConsumption` keys it.
 *
 * Reproduced rather than imported for the same reason as the arithmetic above -
 * the decorator is one step in a chain inside the route and is not exported.
 */
const keyOf = (row, brandSplit) => {
  const article = canonArticle(row['Item No.'])
  if (!article) return null
  const brand = String(row.CHAINID ?? '').trim().toUpperCase()
  if (brandSplit) return brand ? `${article}|${brand}` : null
  return brand ? `${article}|${brand}` : article
}

test('a brand-split row without a brand matches nothing', () => {
  /*
   * THE 14.3% OVER-COUNT, fixed 9 Nov 2026.
   *
   * `component-level` stamps CHAINID per brand but leaves `__unattributed`
   * rows blank on purpose - the brand column has nothing true to say about an
   * article that went from a production site to another site. Those blank rows
   * used to fall through to the article's total across ALL brands and be added
   * on top of the per-brand rows for the same article.
   *
   * Measured over October 2026, nine brands: the source table holds 7,551,686
   * Potential COS QTY; the page showed 8,631,756.
   */
  assert.equal(keyOf({ 'Item No.': '106400534', CHAINID: '' }, true), null)
  assert.equal(keyOf({ 'Item No.': '106400534', CHAINID: null }, true), null)
  assert.equal(keyOf({ 'Item No.': '106400534', CHAINID: 'TBL' }, true), '106400534|TBL')
})

test('a merged page still reads the article total across its brands', () => {
  /*
   * The fallback is right when the rows are NOT brand-split: the figures are
   * merged across exactly the brands the request asked for, and `byArticle` is
   * narrowed to those same brands. Only the mixture was wrong.
   */
  assert.equal(keyOf({ 'Item No.': '106400534' }, false), '106400534')
  assert.equal(keyOf({ 'Item No.': '106400534', CHAINID: 'TBL' }, false), '106400534|TBL')
})

test('a row with no article number is never matched, split or not', () => {
  // A PREP step has no article number in any model, so Oracle has nothing to
  // say about it - and a blank must not collapse to a key of "".
  assert.equal(keyOf({ 'Item No.': '', CHAINID: 'TBL' }, true), null)
  assert.equal(keyOf({ 'Item No.': null }, false), null)
})

test('every article-brand pair Oracle holds ends up on the page', () => {
  /*
   * The completion step. Measured over October 2026: Oracle holds 4,581
   * article-brand pairs and the recipe explosion carried only 2,772 of them,
   * so 1,809 pairs had nowhere to appear until they were appended.
   */
  const byKey = new Map([
    ['100|BBT', { consumption: 120, potential: 100 }],
    ['100|SS', { consumption: 80, potential: 100 }],
    ['200|BBT', { consumption: 50, potential: 0 }],
  ])
  // Only one of the three pairs came through on a recipe row.
  const already = [{ 'Item No.': '100', CHAINID: 'BBT', Sys_Potential_COS: 100 }]

  const seen = new Set()
  for (const r of already) {
    if (r.Sys_Potential_COS === null || r.Sys_Potential_COS === undefined) continue
    const article = canonArticle(r['Item No.'])
    const brand = String(r.CHAINID ?? '').trim().toUpperCase()
    if (article && brand) seen.add(`${article}|${brand}`)
  }
  const appended = [...byKey.keys()].filter((k) => !seen.has(k))

  assert.deepEqual(appended, ['100|SS', '200|BBT'])

  // And the totals then come to exactly what the source holds.
  let potential = 0
  let consumption = 0
  for (const [, v] of byKey) {
    potential += v.potential
    consumption += v.consumption
  }
  assert.equal(potential, 200)
  assert.equal(consumption, 250)
})

test('a recipe-side slicer suppresses the completion instead of inverting it', () => {
  /*
   * The appended rows are added outermost, so they never see the route's
   * filters. Unguarded, that turned a filter into its opposite: narrowing to
   * one Item left the recipe rows at one, which made 8,653 pairs look missing,
   * which were then all appended - a filter that EXPANDED the page.
   *
   * These rows cannot answer a recipe-side question: Item, Category, Recipe
   * Group and Node Type are all properties of 'RECIPE TABLE', and an article no
   * recipe names has none of them.
   */
  const suppressed = (f) =>
    Boolean(f?.items?.length || f?.categories?.length || f?.recipeGroups?.length || f?.nodeTypes?.length)

  assert.equal(suppressed({ items: ['Fries'] }), true)
  assert.equal(suppressed({ categories: ['Food'] }), true)
  assert.equal(suppressed({ recipeGroups: ['Burgers'] }), true)
  assert.equal(suppressed({ nodeTypes: ['RAW'] }), true)
  // The variance flag and the dates are not recipe-side, so they leave the
  // completion alone - the flag is applied to the finished set afterwards.
  assert.equal(suppressed({ varianceFlags: ['Variance'] }), false)
  assert.equal(suppressed({ dateFrom: '2026-10-01', dateTo: '2026-10-31' }), false)
  assert.equal(suppressed({}), false)
  assert.equal(suppressed(null), false)
})

test('the article NUMBER narrows the appended rows rather than suppressing them', () => {
  // Oracle has the article number too, so it is the one slicer these rows can
  // honestly answer.
  const onlyArticles = new Set(['100', '300'].map((a) => canonArticle(a)))
  const pairs = ['100|BBT', '200|BBT', '300|SS']
  const kept = pairs.filter((k) => onlyArticles.has(k.split('|')[0]))
  assert.deepEqual(kept, ['100|BBT', '300|SS'])
})

test('an appended row carries no theoretical of ours, not a zero', () => {
  /*
   * An article no recipe names has no figure of ours and never will. Zeroing it
   * would assert we computed nought; blank says we have nothing to say. The
   * variance beside it is unaffected - it is Oracle against Oracle.
   */
  const found = { consumption: 50, potential: 40 }
  const row = {
    Our_Theoretical: null,
    Sys_Potential_COS: found.potential,
    Sys_Consumption: found.consumption,
    Consumption_Variance: found.consumption - found.potential,
    Variance_Flag: varianceFlag(found.consumption, found.potential),
    Oracle_Only: true,
  }
  assert.equal(row.Our_Theoretical, null)
  assert.equal(row.Consumption_Variance, 10)
  assert.equal(row.Variance_Flag, 'Variance')
  assert.ok(row.Oracle_Only, 'marked, so the blank cross-check cell can explain itself')
})

test('a trend point with no theoretical has no percentage', () => {
  const months = ['2026-09-01', '2026-10-01']
  const inner = new Map([
    ['2026-09-01', { consumption: 12, potential: 0 }],
    ['2026-10-01', { consumption: 12, potential: 6 }],
  ])
  const got = pointsOf(months, inner)
  assert.equal(got[0].pct, null, 'no denominator')
  assert.equal(got[0].variance, 12, 'but the absolute figure is still real')
  assert.equal(got[1].pct, 1)
})
