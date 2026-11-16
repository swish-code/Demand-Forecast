import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  completeMonths,
  monthlyVariance,
  monthlyVarianceByArticle,
  engineVarianceByArticle,
  engineMonthlyTotals,
  mcMonthlyTotals,
  persistentVarianceArticles,
  topVarianceArticles,
} from './varianceFolds.js'

/*
 * The Consumption page's period view, checked against the thing that actually
 * went wrong rather than against the happy path.
 *
 * Two real faults are guarded here, both found on 9 Nov 2026:
 *
 *   - May 2026 arrived in the FM Sales Dashboard carrying 1% of a month and no
 *     theoretical. Drawn as a month it reads as consumption collapsing and
 *     every article's variance vanishing.
 *   - The page ranked by the window on screen, usually October alone, so a
 *     steady six-month gap lost to one bad October. That is the request these
 *     folds answer, so the ranking is asserted, not assumed.
 */

const APR = '2026-04-01'
const MAY = '2026-05-01'
const JUN = '2026-06-01'
const JUL = '2026-07-01'
const AUG = '2026-08-01'
const SEP = '2026-09-01'
const OCT = '2026-10-01'

const FULL = [APR, JUN, JUL, AUG, SEP, OCT]

/** One article-brand row as the server stamps it. */
const row = (article, points, { brand = 'YP', name = null } = {}) => ({
  'Item No.': article,
  CHAINID: brand,
  Item: name ?? `Article ${article}`,
  Variance_Trend: points,
})

/**
 * A month's point. `pct` null means Oracle has no theoretical at all.
 *
 * `theoretical` arrived 12 Nov 2026 with the percentage reading. It defaults
 * so that it agrees with the default `pct` - variance ÷ 0.5 - because a
 * fixture whose two sides contradict each other proves nothing about a fold
 * that reads both.
 */
const at = (month, variance, pct = 0.5, theoretical = pct ? variance / pct : 0) => ({
  month,
  variance,
  pct,
  theoretical,
})

/* A table where every full month has 10 articles reporting and May has 1 - the
 * shape the republish actually produced, in miniature. */
const tableWithMayStub = () => {
  const out = []
  for (let i = 0; i < 10; i += 1) {
    out.push(row(String(100 + i), FULL.map((m) => at(m, 1000))))
  }
  out.push(row('999', [at(MAY, 12)]))
  return out
}

test('completeMonths keeps the months that are a month of data', () => {
  const { months } = completeMonths(tableWithMayStub())
  assert.deepEqual(months, FULL)
})

test('completeMonths reports the partial month rather than dropping it silently', () => {
  const { partial } = completeMonths(tableWithMayStub())
  assert.equal(partial.length, 1)
  assert.equal(partial[0].month, MAY)
  assert.equal(partial[0].articles, 1)
  // One article against a median of ten.
  assert.ok(partial[0].share < 0.5, `share was ${partial[0].share}`)
})

test('a month present for most articles is NOT called partial', () => {
  const rows = tableWithMayStub()
  // Give May eight of the ten articles: a real month, thinner than the rest.
  for (let i = 0; i < 8; i += 1) rows[i].Variance_Trend.push(at(MAY, 500))
  const { months, partial } = completeMonths(rows)
  assert.ok(months.includes(MAY))
  assert.deepEqual(partial, [])
})

test('completeMonths survives a table with no trend at all', () => {
  assert.deepEqual(completeMonths([]), { months: [], partial: [] })
  assert.deepEqual(completeMonths([{ 'Item No.': '1' }]), { months: [], partial: [] })
})

test('monthlyVariance draws only the months it is given', () => {
  const only = new Set(FULL)
  const got = monthlyVariance(tableWithMayStub(), only)
  assert.deepEqual(got.map((m) => m.month), FULL)
  // The stub's 12 units must not appear anywhere in the series.
  assert.ok(got.every((m) => m.variance === 10000))
})

test('monthlyVariance without a filter still returns every month', () => {
  const got = monthlyVariance(tableWithMayStub())
  assert.equal(got.length, 7)
  assert.deepEqual(got.map((m) => m.month).sort(), [...FULL, MAY].sort())
})

/* ---------------------------------------------------- the period ranking -- */

test('ranking by size is over the PERIOD, not the latest month', () => {
  const steady = row('STEADY', FULL.map((m) => at(m, 1000))) // 6,000 over six months
  const spike = row('SPIKE', [
    at(APR, 0),
    at(JUN, 0),
    at(JUL, 0),
    at(AUG, 0),
    at(SEP, 0),
    at(OCT, 2500),
  ])
  const got = persistentVarianceArticles([spike, steady], FULL, { rank: 'size' })
  assert.equal(got[0].article, 'STEADY', 'the six-month total must win, not October')
  assert.equal(got[0].variance, 6000)
})

test('ranking by persistence puts the every-month article first', () => {
  const steady = row('STEADY', FULL.map((m) => at(m, 100))) // high 6 months, small
  const big = row('BIG', [at(OCT, 900000)]) // high 1 month, enormous
  const got = persistentVarianceArticles([big, steady], FULL, { rank: 'persistence' })
  assert.equal(got[0].article, 'STEADY')
  assert.equal(got[0].monthsHigh, 6)
  assert.equal(got[1].article, 'BIG')
})

test('months high counts against months SEEN, not against the window', () => {
  // Oracle only started recording this article in August.
  const late = row('LATE', [at(AUG, 900), at(SEP, 900), at(OCT, 900)])
  const [got] = persistentVarianceArticles([late], FULL, { rank: 'size' })
  assert.equal(got.monthsHigh, 3)
  assert.equal(got.monthsSeen, 3, 'a month with no row is not a month seen')
  assert.equal(got.monthsWindow, 6, 'the window is still reported, for the "of 6"')
  assert.equal(got.everyMonth, true, 'high in every month it appears in')
})

test('a month inside the window but absent from the article is not agreement', () => {
  const gappy = row('GAPPY', [at(APR, 900), at(OCT, 900)])
  const [got] = persistentVarianceArticles([gappy], FULL, { rank: 'size' })
  assert.equal(got.monthsSeen, 2)
  assert.equal(got.monthsHigh, 2)
  assert.equal(got.everyMonth, true)
})

test('points outside the window are excluded from the totals', () => {
  const r = row('X', [at(MAY, 500000), ...FULL.map((m) => at(m, 100))])
  const [got] = persistentVarianceArticles([r], FULL, { rank: 'size' })
  assert.equal(got.monthsSeen, 6, 'May must not be counted')
  assert.equal(got.variance, 600)
})

/* ------------------------------------------------------- the high rule ---- */

test('within 1% is not high, however many months it runs for', () => {
  const r = row('TINY', FULL.map((m) => at(m, 900, 0.005)))
  assert.deepEqual(persistentVarianceArticles([r], FULL), [])
})

test('half a unit or less is not high, however large the percentage', () => {
  const r = row('HALF', FULL.map((m) => at(m, 0.4, 5)))
  assert.deepEqual(persistentVarianceArticles([r], FULL), [])
})

test('no theoretical at all is NOT high, and is flagged as unscorable', () => {
  /*
   * REVERSED 12 Nov 2026. This asserted `monthsHigh === 6`.
   *
   * The old reasoning was that "MC says nothing and 4,000 was consumed" is not
   * agreement, so it should count. True, but it is not disagreement either -
   * it is an unmeasured month. `mcStatus` stopped calling this a variance on
   * 11 Nov and this rule was missed, so the Status column said "No
   * theoretical" while Months high said "6 of 6" about the same article.
   *
   * Measured on the live data: YP's packaging lines - stickers, gloves, bags,
   * napkins - carry no MC theoretical in any month, and every one of them was
   * sitting in the "High all 6" worklist.
   */
  const r = row('NAPKIN', FULL.map((m) => at(m, 4000, null, 0)))
  const got = persistentVarianceArticles([r], FULL)
  assert.deepEqual(got, [], 'nothing to rank: not one of its months can be judged')

  const [fold] = monthlyVarianceByArticle([r], FULL)
  assert.equal(fold.monthsHigh, 0)
  assert.equal(fold.monthsScored, 0)
  assert.equal(
    fold.hasTheoretical,
    false,
    'the heatmap keys off this: a share of nothing has no place on a scale of shares'
  )
})

test('an article with one theoretical month among none still scores', () => {
  const r = row('MIXED', [at(APR, 4000, null), at(JUN, 4000, 0.4), at(JUL, 4000, null)])
  const [got] = persistentVarianceArticles([r], FULL)
  assert.equal(got.hasTheoretical, true)
})

test('direction separates steady over-use from a swing', () => {
  const over = row('OVER', FULL.map((m) => at(m, 900)))
  const under = row('UNDER', FULL.map((m) => at(m, -900)))
  const mixed = row('MIXED', [
    at(APR, 900),
    at(JUN, 900),
    at(JUL, 900),
    at(AUG, -900),
    at(SEP, -900),
    at(OCT, -900),
  ])
  const got = Object.fromEntries(
    persistentVarianceArticles([over, under, mixed], FULL).map((d) => [d.article, d.direction])
  )
  assert.deepEqual(got, { OVER: 'Used more', UNDER: 'Used less', MIXED: 'Mixed' })
})

test('mixed months cancel in the total but not in the count', () => {
  const r = row('CANCEL', [at(APR, 1000), at(JUN, -1000)])
  const [got] = persistentVarianceArticles([r], FULL)
  assert.equal(got.variance, 0, 'the quantities net off')
  assert.equal(got.monthsHigh, 2, 'both months were still a disagreement')
})

test('latest is the last month in the window the article appears in', () => {
  const r = row('L', [at(APR, 100), at(JUL, 700), at(SEP, 300)])
  const [got] = persistentVarianceArticles([r], FULL)
  assert.equal(got.latest, 300)
})

test('the key separates one article across two brands', () => {
  const yp = row('500', FULL.map((m) => at(m, 900)), { brand: 'YP' })
  const bbt = row('500', FULL.map((m) => at(m, 900)), { brand: 'BBT' })
  const got = persistentVarianceArticles([yp, bbt], FULL)
  assert.equal(got.length, 2)
  assert.equal(new Set(got.map((d) => d.key)).size, 2, 'one key each, or picking one picks both')
})

test('an unmapped brand still produces a usable key', () => {
  const r = row('600', FULL.map((m) => at(m, 900)), { brand: '' })
  const [got] = persistentVarianceArticles([r], FULL)
  assert.equal(got.key, '600|')
  assert.equal(got.brand, '')
})

test('no months means nothing is claimed', () => {
  const r = row('X', FULL.map((m) => at(m, 900)))
  assert.deepEqual(persistentVarianceArticles([r], []), [])
  assert.deepEqual(persistentVarianceArticles([r], null), [])
})

test('the limit is applied after the ranking, not before', () => {
  const rows = []
  for (let i = 1; i <= 10; i += 1) {
    rows.push(row(String(i), FULL.map((m) => at(m, i * 100))))
  }
  const got = persistentVarianceArticles(rows, FULL, { rank: 'size', limit: 3 })
  assert.deepEqual(got.map((d) => d.article), ['10', '9', '8'])
})

/* ------------------------------------------- every article, by month ------ */

test('a month the article has no row for stays UNDEFINED, never zero', () => {
  const r = row('GAP', [at(APR, 900), at(OCT, 900)])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got[APR], 900)
  assert.equal(got[OCT], 900)
  assert.equal(
    JUN in got,
    false,
    'a zero would say the outlets matched the recipe exactly that month'
  )
  assert.equal(got.monthsSeen, 2)
})

test('every article is kept, including ones in agreement all six months', () => {
  const quiet = row('QUIET', FULL.map((m) => at(m, 900, 0.004)))
  const loud = row('LOUD', FULL.map((m) => at(m, 900)))
  const got = monthlyVarianceByArticle([quiet, loud], FULL)
  assert.equal(got.length, 2, 'this fold lists everything - the toggle narrows it')
  assert.equal(got.find((d) => d.article === 'QUIET').monthsHigh, 0)
})

test('the toggle demands all six months of the WINDOW, not of what it appears in', () => {
  const partial = row('PARTIAL', [at(AUG, 900), at(SEP, 900), at(OCT, 900)])
  const [got] = monthlyVarianceByArticle([partial], FULL)
  assert.equal(got.monthsHigh, 3)
  assert.equal(got.monthsSeen, 3)
  assert.equal(
    got.everyMonth,
    false,
    'high in three months it appears in is not high in all six'
  )
})

test('an article high in all six months passes the toggle', () => {
  const r = row('ALL', FULL.map((m) => at(m, 900)))
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got.everyMonth, true)
  assert.equal(got.monthsHigh, 6)
})

test('the total sums the months and lets the directions cancel', () => {
  const r = row('SWING', [at(APR, 1000), at(JUN, -1000), at(JUL, 400)])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got.total, 400)
  assert.equal(got.monthsHigh, 3, 'cancelling in the total is not agreeing in the months')
})

test('an unmapped brand becomes a group heading rather than a blank', () => {
  const r = row('U', FULL.map((m) => at(m, 900)), { brand: '' })
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got.brand, '(unmapped)')
})

test('months outside the window never become columns', () => {
  const r = row('X', [at(MAY, 500000), ...FULL.map((m) => at(m, 100))])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(MAY in got, false)
  assert.equal(got.total, 600)
})

test('rows are grouped by brand then ordered by size within the brand', () => {
  const rows = [
    row('SMALL', FULL.map((m) => at(m, 100)), { brand: 'ZZ' }),
    row('BIG', FULL.map((m) => at(m, 9000)), { brand: 'ZZ' }),
    row('OTHER', FULL.map((m) => at(m, 500)), { brand: 'AA' }),
  ]
  const got = monthlyVarianceByArticle(rows, FULL)
  assert.deepEqual(got.map((d) => d.article), ['OTHER', 'BIG', 'SMALL'])
})

test('no months means no table', () => {
  const r = row('X', FULL.map((m) => at(m, 900)))
  assert.deepEqual(monthlyVarianceByArticle([r], []), [])
})

/* --------------------------------------------------- the window ranking --- */

test('topVarianceArticles still ranks on the window figure', () => {
  const rows = [
    { 'Item No.': 'A', Item: 'A', Consumption_Variance: 50, Consumption_Variance_Pct: 0.5 },
    { 'Item No.': 'B', Item: 'B', Consumption_Variance: -900, Consumption_Variance_Pct: -0.9 },
  ]
  const got = topVarianceArticles(rows, 2)
  assert.equal(got[0].article, 'B', 'ranked on the absolute variance, either direction')
})

test('topVarianceArticles drops rows with no variance to rank', () => {
  const rows = [{ 'Item No.': 'A', Item: 'A', Consumption_Variance: null }]
  assert.deepEqual(topVarianceArticles(rows), [])
})

/* ------------------------------------------- the percentage reading ------- */

test('each month carries its own percentage beside its quantity', () => {
  /*
   * Both readings come off ONE fold - 12 Nov 2026. Two passes would be two
   * chances for the quantity table and the percentage table to disagree about
   * which articles are in them.
   */
  const r = row('PCT', [at(APR, 900, 0.25), at(OCT, -300, -0.1)])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got[APR], 900)
  assert.equal(got[`${APR}__pct`], 0.25)
  assert.equal(got[OCT], -300)
  assert.equal(got[`${OCT}__pct`], -0.1)
})

test('the percentage key cannot collide with the quantity key', () => {
  /*
   * DataTable keys its hidden set, its colgroup and its React children on the
   * column key. Two columns sharing one would fight over all three, which is
   * the bug the New Store page hit when two columns were both keyed `Period`.
   */
  const r = row('K', [at(APR, 100)])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.notEqual(APR, `${APR}__pct`)
  assert.equal(got[APR], 100)
  assert.ok(`${APR}__pct` in got)
})

test('the six-month percentage is the MEAN of the monthly percentages', () => {
  /*
   * CHANGED 15 Nov 2026, on request. This asserted the opposite until today:
   * summed variance over summed theoretical, which weighted each month by what
   * it held.
   *
   * The business asked for the plain average, so that a month running 30% out
   * counts the same whether it was a large month or a small one. The fixture
   * is deliberately the extreme case - one tiny month 100% out and one large
   * month 1% out:
   *
   *   weighted (old)   104 / 10,004  =   1.0%
   *   mean     (new)   (100 + 1) / 2 =  50.5%
   *
   * Both are defensible readings of "how far out was this article"; they
   * answer different questions, and the second is the one asked for.
   */
  const r = row('W', [at(APR, 4, 1, 4), at(OCT, 100, 0.01, 10000)])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got.total, 104, 'the quantity reading is untouched')
  assert.equal(got.totalTheoretical, 10004)
  assert.equal(got.monthsInPct, 2)
  assert.ok(Math.abs(got.totalPct - (1 + 0.01) / 2) < 1e-12, 'the mean of 100% and 1%')
})

test('the example from the request computes as stated', () => {
  /*
   * "April +20, June -10, September -5, October +30  ->  +8.75%".
   * Written as a test so the figure in the request and the figure on screen
   * cannot drift apart.
   */
  const r = row('EX', [
    at(APR, 200, 0.2, 1000),
    at(JUN, -100, -0.1, 1000),
    at(SEP, -50, -0.05, 1000),
    at(OCT, 300, 0.3, 1000),
  ])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got.monthsInPct, 4)
  assert.ok(Math.abs(got.totalPct - 0.0875) < 1e-12, '(20 - 10 - 5 + 30) / 4')
})

test('a month with no theoretical contributes to neither side of the percentage', () => {
  /*
   * `pct` null is MC holding no theoretical for that month. It must not become
   * a zero in the numerator or the denominator: a month with nothing to divide
   * by is unmeasured, not a month in agreement.
   */
  const r = row('N', [at(APR, 900, null, 0), at(OCT, 100, 0.05, 2000)])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got[`${APR}__pct`], null)
  assert.equal(got.totalTheoretical, 2000, 'the empty month added no denominator')
})

test('an article with no theoretical in any month has no six-month percentage', () => {
  const r = row('Z', [at(APR, 900, null, 0), at(OCT, 300, null, 0)])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got.totalPct, null, 'null, never zero - zero would read as agreement')
  assert.equal(got.total, 1200, 'the quantity reading is unaffected')
})

/* ------------------------------------------- unmeasurable months ---------- */

test('a month with no theoretical is NOT counted high', () => {
  /*
   * CORRECTED 12 Nov 2026, and this contradicted the Status column.
   *
   * `monthIsHigh` returned true whenever MC held no theoretical and something
   * was consumed. On 11 Nov `mcStatus` stopped treating that as a variance -
   * it is an unmeasured month, not a disagreement - and this function was
   * missed, so the Status column read "No theoretical" while the Months high
   * column beside it read "6 of 6" for the same article.
   *
   * YP's packaging lines are the case that exposed it: stickers, gloves, bags
   * and napkins carry no MC theoretical in ANY month, so every one of them
   * filled the "High all 6" worklist with articles nobody can act on.
   */
  const noTheoretical = row('PKG', FULL.map((m) => at(m, 500_000, null, 0)))
  const [got] = monthlyVarianceByArticle([noTheoretical], FULL)
  assert.equal(got.monthsHigh, 0, 'nothing here can be judged')
  assert.equal(got.monthsScored, 0)
  assert.equal(got.everyMonth, false, 'and it can never reach the High all 6 list')
  assert.equal(got.total, 3_000_000, 'the quantity reading is untouched')
})

test('months high is counted out of the months that could be judged', () => {
  /*
   * "3 of 6" used to mean "high in 3 of the window's 6", which read as though
   * the other three were in agreement. Three of them could not be judged at
   * all, and the column now says so.
   */
  const mixed = row('MIX', [
    at(APR, 900, 0.5, 1800),
    at(JUN, 900, null, 0),
    at(JUL, 900, 0.5, 1800),
    at(AUG, 900, null, 0),
    at(SEP, 4, 0.0005, 8000),
    at(OCT, 900, null, 0),
  ])
  const [got] = monthlyVarianceByArticle([mixed], FULL)
  assert.equal(got.monthsScored, 3, 'April, July and September have a theoretical')
  assert.equal(got.monthsHigh, 2, 'September is inside the 1% tolerance')
})

test('a month MC never priced is excluded from the percentage, not counted as 0%', () => {
  /*
   * THE FAULT THIS GUARDS, measured on live data 12 Nov 2026.
   *
   * YP's sticker line carries no MC theoretical in five of the six months and
   * 892 in August. Taking all six months into the percentage - whether by
   * summing the variance over that single 892, or by averaging five zeroes
   * against one real figure - reports something about months that cannot be
   * measured. The first version produced +424,518%; counting the empty months
   * as 0% would produce the opposite distortion, dividing by six.
   *
   * Only August can be judged, so August is the answer.
   */
  const r = row('STICKER', [
    at(APR, 534297, null, 0),
    at(JUN, 716758, null, 0),
    at(JUL, 684679, null, 0),
    at(AUG, 673693, 755.26, 892),
    at(SEP, 595720, null, 0),
    at(OCT, 582446, null, 0),
  ])
  const [got] = monthlyVarianceByArticle([r], FULL)

  assert.equal(got.total, 3787593, 'the QUANTITY reading still covers every month')
  assert.equal(got.monthsInPct, 1, 'one month carries a percentage')
  assert.ok(Math.abs(got.totalPct - 755.26) < 1e-9, "August's own figure, undiluted")
  assert.ok(
    Math.abs(got.totalPct - 755.26 / 6) > 1,
    'the five unpriced months are not averaged in as zeroes'
  )
})

/* ------------------------------------------- PM against MC, by month ------ */

const engineRow = (article, points, { brand = 'YP', name = null, unit = 'KG' } = {}) => ({
  'Item No.': article,
  CHAINID: brand,
  Item: name ?? `Article ${article}`,
  Unit: unit,
  Engine_Trend: points,
})

/** A paired month. `mc` of 0 means MC priced nothing that month. */
const pair = (month, pm, mc) => ({
  month,
  pm,
  mc,
  diff: pm === null || mc === null ? null : pm - mc,
  pct: pm === null || !(mc > 0) ? null : (pm - mc) / mc,
})

test('the engine fold carries both readings off one pass', () => {
  const r = engineRow('X', [pair(APR, 1200, 1000), pair(OCT, 900, 1000)])
  const [got] = engineVarianceByArticle([r], FULL)
  assert.equal(got[APR], 200)
  assert.ok(Math.abs(got[`${APR}__pct`] - 0.2) < 1e-12)
  assert.equal(got[OCT], -100)
  assert.ok(Math.abs(got[`${OCT}__pct`] - -0.1) < 1e-12)
  assert.equal(got.total, 100)
  assert.equal(got.monthsPaired, 2)
})

test('the engine six-month percentage divides matched months only', () => {
  /*
   * The same trap as the MC fold, guarded the same way. One month MC priced at
   * 1,000 and five it priced at nothing. Dividing the whole six months of
   * difference by that 1,000 would restate a modest gap as several thousand
   * per cent.
   */
  const r = engineRow('W', [
    pair(APR, 5000, 0),
    pair(JUN, 5000, 0),
    pair(JUL, 1200, 1000),
    pair(AUG, 5000, 0),
    pair(SEP, 5000, 0),
    pair(OCT, 5000, 0),
  ])
  const [got] = engineVarianceByArticle([r], FULL)
  // Five unpriced months at 5,000 each, plus July's 200.
  assert.equal(got.total, 25200, 'the quantity reading covers every paired month')
  assert.equal(got.totalTheoretical, 1000)
  assert.ok(Math.abs(got.totalPct - 0.2) < 1e-12, 'July against July, not six months against one')
})

test('an article MC never priced has no engine percentage', () => {
  const r = engineRow('Z', [pair(APR, 500, 0), pair(OCT, 400, 0)])
  const [got] = engineVarianceByArticle([r], FULL)
  assert.equal(got.totalPct, null, 'null, never zero')
  assert.equal(got.total, 900, 'the quantity reading is unaffected')
})

test('a month present on only one side is not folded in', () => {
  const r = engineRow('P', [pair(APR, 1200, 1000), { month: OCT, pm: 900, mc: null, diff: null, pct: null }])
  const [got] = engineVarianceByArticle([r], FULL)
  assert.equal(got.monthsPaired, 1)
  assert.equal(OCT in got, false, 'a zero would claim the two engines agreed that month')
})

test('an article with no engine trend is absent, not an empty row', () => {
  assert.deepEqual(engineVarianceByArticle([{ 'Item No.': 'A', CHAINID: 'YP' }], FULL), [])
  assert.deepEqual(engineVarianceByArticle([engineRow('A', [])], FULL), [])
})

/* ------------------------------------------- the monthly summary ---------- */

test('the monthly summary sums matched pairs only', () => {
  /*
   * The second article has a PM figure in April and no MC figure. Adding its
   * 9,000 to the PM side alone would turn a +20% month into a +920% one and
   * report a coverage difference as a disagreement.
   */
  const paired = engineRow('A', [pair(APR, 1200, 1000), pair(OCT, 900, 1000)])
  const halfOnly = engineRow('B', [
    { month: APR, pm: 9000, mc: null, diff: null, pct: null },
    pair(OCT, 500, 500),
  ])
  const got = engineMonthlyTotals([paired, halfOnly], FULL)

  const apr = got.find((d) => d.month === APR)
  assert.equal(apr.pm, 1200, 'the unmatched 9,000 is excluded from BOTH sides')
  assert.equal(apr.mc, 1000)
  assert.equal(apr.articles, 1)
  assert.ok(Math.abs(apr.pct - 0.2) < 1e-12)

  const oct = got.find((d) => d.month === OCT)
  assert.equal(oct.pm, 1400)
  assert.equal(oct.mc, 1500)
  assert.equal(oct.articles, 2)
})

test('a month where MC priced nothing has a quantity but no percentage', () => {
  const r = engineRow('C', [pair(APR, 5000, 0)])
  const [apr] = engineMonthlyTotals([r], FULL)
  assert.equal(apr.variance, 5000)
  assert.equal(apr.pct, null, 'null, never zero - zero would read as agreement')
})

test('a month nothing paired in is absent, not a zero row', () => {
  const r = engineRow('D', [pair(APR, 1200, 1000)])
  const got = engineMonthlyTotals([r], FULL)
  assert.equal(got.length, 1)
  assert.equal(got[0].month, APR)
})

test('each month carries both theoreticals beside its variance', () => {
  /*
   * The table lays each month out as a group - MC theoretical, PM
   * theoretical, variance, variance % - so the fold has to carry both sides,
   * not only their difference. Suffixed keys, because the bare month is the
   * variance and DataTable keys everything on the column key.
   */
  const r = engineRow('G', [pair(APR, 1200, 1000), pair(OCT, 900, 1000)])
  const [got] = engineVarianceByArticle([r], FULL)
  assert.equal(got[`${APR}__mc`], 1000)
  assert.equal(got[`${APR}__pm`], 1200)
  assert.equal(got[APR], 200, 'the bare month stays the variance')
  assert.ok(Math.abs(got[`${APR}__pct`] - 0.2) < 1e-12)
  assert.equal(got.mcTotal, 2000)
  assert.equal(got.pmTotal, 2100)
})

test('a month MC never priced carries a zero theoretical, not a blank', () => {
  /*
   * MC priced nothing, which is a real reading of zero on that side - unlike
   * a month only one engine costed at all, which the server leaves out of the
   * series entirely. The percentage is still blank: there is no denominator.
   */
  const r = engineRow('H', [pair(APR, 5000, 0)])
  const [got] = engineVarianceByArticle([r], FULL)
  assert.equal(got[`${APR}__mc`], 0)
  assert.equal(got[`${APR}__pm`], 5000)
  assert.equal(got[`${APR}__pct`], null)
})

/* ------------------------------------------- MC totals by month ----------- */

test('monthly consumption is rebuilt from variance plus theoretical', () => {
  /*
   * The server sends the variance and the theoretical; consumption is the sum
   * by definition. Carrying a third number per point would be payload for an
   * identity.
   */
  const r = row('A', [at(APR, 200, 0.2, 1000), at(OCT, -100, -0.1, 1000)])
  const got = mcMonthlyTotals([r], FULL)
  const apr = got.find((d) => d.month === APR)
  assert.equal(apr.theoretical, 1000)
  assert.equal(apr.consumption, 1200, '1,000 theoretical + 200 variance')
  assert.equal(apr.variance, 200)
  const oct = got.find((d) => d.month === OCT)
  assert.equal(oct.consumption, 900, 'a negative variance means less was used')
})

test('the two monthly percentages answer different questions', () => {
  /*
   * One article MC priced and one it did not. Over everything the month reads
   * +520% - the unpriced article's whole consumption sits in the numerator
   * with nothing under it. Over the priced article alone it reads +20%, which
   * is the recipe question and the one comparable with MC Match %.
   */
  const priced = row('P', [at(APR, 200, 0.2, 1000)])
  const unpriced = row('U', [at(APR, 5000, null, 0)])
  const [apr] = mcMonthlyTotals([priced, unpriced], FULL)

  assert.equal(apr.consumption, 6200)
  assert.equal(apr.theoretical, 1000)
  assert.equal(apr.articles, 2)
  assert.ok(Math.abs(apr.pct - 5.2) < 1e-12, 'everything: 5,200 over 1,000')

  assert.equal(apr.articlesPriced, 1)
  assert.ok(Math.abs(apr.pctPriced - 0.2) < 1e-12, 'priced only: 200 over 1,000')
})

test('a month nothing reported in is absent, not a row of zeroes', () => {
  const r = row('Z', [at(APR, 200, 0.2, 1000)])
  const got = mcMonthlyTotals([r], FULL)
  assert.equal(got.length, 1)
  assert.equal(got[0].month, APR)
})

test('a month where MC priced nothing has a quantity but no percentage', () => {
  const r = row('N', [at(APR, 5000, null, 0)])
  const [apr] = mcMonthlyTotals([r], FULL)
  assert.equal(apr.consumption, 5000)
  assert.equal(apr.pct, null)
  assert.equal(apr.pctPriced, null)
})

test('each MC month carries the theoretical and consumption beside its variance', () => {
  /*
   * The MC table lays each month out as a group too, so the fold carries both
   * sides. Consumption is variance + theoretical by definition - that is how
   * the server builds the variance in the first place.
   */
  const r = row('M', [at(APR, 200, 0.2, 1000), at(OCT, -100, -0.1, 1000)])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got[`${APR}__theo`], 1000)
  assert.equal(got[`${APR}__cons`], 1200)
  assert.equal(got[APR], 200, 'the bare month stays the variance')
  assert.equal(got[`${OCT}__cons`], 900, 'a negative variance means less was used')
  assert.equal(got.consumptionTotal, 2100)
  assert.equal(got.totalTheoretical, 2000)
})

test('a month MC never priced still carries its consumption', () => {
  /*
   * Theoretical of nothing is a real reading of zero on that side, and the
   * whole quantity consumed is the variance. The PERCENTAGE stays blank -
   * there is no denominator - but the consumption column must still show what
   * moved, or the table would imply nothing did.
   */
  const r = row('U', [at(APR, 5000, null, 0)])
  const [got] = monthlyVarianceByArticle([r], FULL)
  assert.equal(got[`${APR}__theo`], 0)
  assert.equal(got[`${APR}__cons`], 5000)
  assert.equal(got[`${APR}__pct`], null)
  assert.equal(got.consumptionTotal, 5000)
  assert.equal(got.totalPct, null)
})

test('the six-month figure is the average gap per paired month', () => {
  /*
   * Asked for on 15 Nov 2026: the average rather than the sum.
   *
   * Divided by the months that actually have a figure, not by six. The second
   * article here is paired in two months only - dividing its gap by six would
   * scale it down by a third and rank it below articles with less wrong.
   */
  const full = engineRow('F', [
    pair(APR, 1200, 1000),
    pair(JUN, 1200, 1000),
    pair(JUL, 1200, 1000),
    pair(AUG, 1200, 1000),
    pair(SEP, 1200, 1000),
    pair(OCT, 1200, 1000),
  ])
  const [gotFull] = engineVarianceByArticle([full], FULL)
  assert.equal(gotFull.total, 1200, 'six months of +200')
  assert.equal(gotFull.monthsPaired, 6)
  assert.equal(gotFull.avg, 200, 'the average month is +200')

  const partial = engineRow('P', [pair(APR, 1200, 1000), pair(OCT, 1200, 1000)])
  const [gotPartial] = engineVarianceByArticle([partial], FULL)
  assert.equal(gotPartial.total, 400)
  assert.equal(gotPartial.monthsPaired, 2)
  assert.equal(gotPartial.avg, 200, 'two months of +200 averages +200, not +67')
})

test('the sum survives beside the average', () => {
  /*
   * The costing threshold and the column footer both read the sum, so the
   * average is an addition rather than a replacement.
   */
  const r = engineRow('S', [pair(APR, 1500, 1000), pair(OCT, 1100, 1000)])
  const [got] = engineVarianceByArticle([r], FULL)
  assert.equal(got.total, 600)
  assert.equal(got.avg, 300)
})

test('the engine six-month percentage is the mean too, and ignores unpriced months', () => {
  /*
   * The PM table follows the same rule as the MC one - 15 Nov 2026.
   *
   * July is the trap: PM costed 5,000 and MC costed nothing, so there is no
   * percentage for that month and it must not enter the average as a zero.
   * August is only costed by one engine, so it is not in the series at all.
   */
  const r = engineRow('E', [
    pair(APR, 1200, 1000),
    pair(JUN, 900, 1000),
    pair(JUL, 5000, 0),
    pair(SEP, 950, 1000),
    pair(OCT, 1300, 1000),
  ])
  const [got] = engineVarianceByArticle([r], FULL)
  assert.equal(got.monthsInPct, 4, 'July carries no percentage')
  assert.ok(
    Math.abs(got.totalPct - (0.2 - 0.1 - 0.05 + 0.3) / 4) < 1e-12,
    'the mean of the four months MC priced'
  )
  assert.equal(got.total, 5350, 'the quantity reading still covers every paired month')
  assert.equal(got.avg, 1070, 'and Avg variance / month is unchanged')
})

test('no valid month means a blank percentage in both folds', () => {
  const mc = row('Z1', [at(APR, 900, null, 0), at(OCT, 300, null, 0)])
  const [gotMc] = monthlyVarianceByArticle([mc], FULL)
  assert.equal(gotMc.monthsInPct, 0)
  assert.equal(gotMc.totalPct, null, 'blank, never 0%')

  const pm = engineRow('Z2', [pair(APR, 500, 0), pair(OCT, 400, 0)])
  const [gotPm] = engineVarianceByArticle([pm], FULL)
  assert.equal(gotPm.monthsInPct, 0)
  assert.equal(gotPm.totalPct, null, 'blank, never 0%')
})
