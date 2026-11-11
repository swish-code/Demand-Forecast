import assert from 'node:assert/strict'
import { test } from 'node:test'
import { windowFor, daysOf, largestRemainder, val, coverageOf, foldDaily } from './newStore.js'

/*
 * The guarantees the new-store forecast rests on, tested without a database or
 * a Power BI token.
 *
 * The one that matters most is reconciliation: the daily quantities must add
 * up to the monthly quantity exactly. That is the brief's own rule, and it is
 * the thing a reader cannot check by eye over ninety days.
 */

test('the window is three thirty-day periods from the opening day', () => {
  const w = windowFor('2027-01-01')
  assert.equal(w.from, '2027-01-01')
  assert.equal(w.to, '2027-03-31', '90 days from 1 Jan in a non-leap year')
  assert.equal(w.days, 90)
  assert.deepEqual(
    w.periods.map((p) => [p.from, p.to]),
    [
      ['2027-01-01', '2027-01-30'],
      ['2027-01-31', '2027-03-01'],
      ['2027-03-02', '2027-03-31'],
    ]
  )
})

test('a mid-month opening gets three FULL periods, not a short first one', () => {
  // The whole point of the change from calendar months: a branch opening on
  // the 28th used to get a three-day "month 1" sized by a month's sales.
  const w = windowFor('2027-01-28')
  assert.equal(w.from, '2027-01-28')
  assert.deepEqual(w.periods.map((p) => p.days), [30, 30, 30])
  assert.equal(w.periods[0].to, '2027-02-26')
  assert.equal(w.to, '2027-04-27')
})

test('every period is thirty days whatever month it straddles', () => {
  for (const d of ['2027-01-01', '2027-02-14', '2027-06-30', '2027-12-25']) {
    const w = windowFor(d)
    assert.deepEqual(w.periods.map((p) => p.days), [30, 30, 30], `opening ${d}`)
    assert.equal(daysOf(w).length, 90, `opening ${d}`)
  }
})

test('the window crosses a year end without special-casing it', () => {
  const w = windowFor('2027-12-15')
  assert.equal(w.from, '2027-12-15')
  assert.equal(w.to, '2028-03-13')
  assert.equal(daysOf(w).length, 90)
})

test('a leap day is one of the ninety, not an extra', () => {
  // 2028 is a leap year; 29 Feb must be counted and must not lengthen a period.
  const w = windowFor('2028-02-01')
  assert.equal(daysOf(w).length, 90)
  assert.ok(daysOf(w).some((d) => d.date === '2028-02-29'), '29 Feb is in the window')
  assert.equal(w.periods[0].to, '2028-03-01', 'Feb 1 + 29 days, with the leap day')
})

test('day numbers run from 1 at the opening date and carry their period', () => {
  const w = windowFor('2027-01-15')
  const days = daysOf(w)
  assert.equal(days[0].date, '2027-01-15')
  assert.equal(days[0].day, 1)
  assert.equal(days[0].period, 1)
  assert.equal(days[29].day, 30)
  assert.equal(days[29].period, 1, 'day 30 is the last of period 1')
  assert.equal(days[30].day, 31)
  assert.equal(days[30].period, 2, 'day 31 opens period 2')
  assert.equal(days[89].day, 90)
  assert.equal(days[89].period, 3)
  assert.equal(days.length, 90)
})

test('each period holds exactly thirty of the ninety days', () => {
  const days = daysOf(windowFor('2027-05-17'))
  for (const p of [1, 2, 3]) {
    assert.equal(days.filter((d) => d.period === p).length, 30, `period ${p}`)
  }
})

/* ------------------------------------------------ largest remainder ------ */

test('daily quantities add up to the monthly quantity exactly', () => {
  const exact = [3.4, 2.6, 1.5, 0.5]
  const got = largestRemainder(exact, 8)
  assert.equal(got.reduce((a, b) => a + b, 0), 8)
})

test('the spare units land on the busiest days', () => {
  //  floors are 3,2,1,0 = 6, so two units are left for the largest fractions
  const got = largestRemainder([3.4, 2.6, 1.5, 0.5], 8)
  assert.deepEqual(got, [3, 3, 2, 0])
})

test('a product selling a fraction a day is not rounded away to nothing', () => {
  // 90 days at 0.4 is 36 units. Rounding each day on its own gives zero.
  const exact = new Array(90).fill(0.4)
  const got = largestRemainder(exact, 36)
  assert.equal(got.reduce((a, b) => a + b, 0), 36)
  assert.ok(
    got.some((v) => v > 0),
    'the month is 36 units and they have to be on some day'
  )
})

test('more units than days still reconciles', () => {
  const got = largestRemainder([1.2, 1.2], 10)
  assert.equal(got.reduce((a, b) => a + b, 0), 10)
})

test('a month of nothing stays nothing', () => {
  const got = largestRemainder([0, 0, 0], 0)
  assert.deepEqual(got, [0, 0, 0])
})

test('every day already whole is left alone', () => {
  assert.deepEqual(largestRemainder([2, 3, 5], 10), [2, 3, 5])
})

/* ---------------------------------------------- the weighting identity --- */

/*
 * The property the whole method rests on, reproduced here as arithmetic:
 * weights normalised within a month sum to 1, so distributing a monthly
 * quantity by them returns the monthly quantity. It is what makes the Ramadan
 * question moot and what makes a short first month safe - whatever days are in
 * the month, and whatever shape they have, the total is preserved.
 */
test('weights over the open days always sum to one', () => {
  for (const shape of [[5, 3, 2], [1, 1, 1, 1], [0.1, 99.9], [7]]) {
    const total = shape.reduce((a, b) => a + b, 0)
    const weights = shape.map((q) => q / total)
    const sum = weights.reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-12, `weights summed to ${sum}`)
  }
})

/* ------------------------------------------- historical coverage --------- */

/*
 * The rule that stops a part-covered month being forecast.
 *
 * The defect these exist for: `Forecast_Product_Table` ends 31 Dec 2026, and
 * an opening on 1 Dec 2026 gave M2 one covered day of thirty. The page
 * reported `available: true` and 5,223 units - a number roughly a thirtieth of
 * the truth, because one day of product quantity was divided by thirty days of
 * brand sales, and entirely plausible on screen.
 */

const datesOf = (w, period) =>
  daysOf(w)
    .filter((d) => d.period === period)
    .map((d) => d.date)

test('a month with every day covered is complete and may be forecast', () => {
  const w = windowFor('2026-12-01')
  const m1 = datesOf(w, 1)
  const got = coverageOf(m1, new Set(m1))
  assert.deepEqual(got, { days: 30, covered: 30, status: 'complete', available: true })
})

test('a month with one covered day of thirty is partial and is refused', () => {
  // The 1 Dec 2026 case exactly: M2 is 31 Dec - 29 Jan, and the data stops on
  // 31 Dec, so precisely one day is covered.
  const w = windowFor('2026-12-01')
  const m2 = datesOf(w, 2)
  assert.equal(m2[0], '2026-12-31')
  const got = coverageOf(m2, new Set(['2026-12-31']))
  assert.deepEqual(got, { days: 30, covered: 1, status: 'partial', available: false })
})

test('a month with no covered day is "none" and is refused', () => {
  const w = windowFor('2026-12-01')
  const m3 = datesOf(w, 3)
  const got = coverageOf(m3, new Set(['2026-12-31']))
  assert.deepEqual(got, { days: 30, covered: 0, status: 'none', available: false })
})

test('29 of 30 is refused exactly as 1 of 30 is - there is no tolerance', () => {
  const w = windowFor('2027-01-01')
  const m1 = datesOf(w, 1)
  const got = coverageOf(m1, new Set(m1.slice(0, 29)))
  assert.equal(got.covered, 29)
  assert.equal(got.status, 'partial')
  assert.equal(got.available, false, 'a missing day understates the rate by that day’s share')
})

test('coverage counts the period’s OWN dates, not any date that exists', () => {
  // Dates from a different month must not make a period look covered.
  const w = windowFor('2026-12-01')
  const m3 = datesOf(w, 3)
  const elsewhere = new Set(datesOf(w, 1))
  assert.equal(coverageOf(m3, elsewhere).covered, 0)
  assert.equal(coverageOf(m3, elsewhere).status, 'none')
})

test('an opening that runs into 2027 splits into covered and uncovered months', () => {
  const w = windowFor('2026-12-01')
  // Everything the source holds: up to and including 31 Dec 2026.
  const source = new Set(daysOf(w).map((d) => d.date).filter((d) => d <= '2026-12-31'))
  const got = [1, 2, 3].map((n) => coverageOf(datesOf(w, n), source))
  assert.deepEqual(
    got.map((g) => [g.covered, g.status]),
    [
      [30, 'complete'],
      [1, 'partial'],
      [0, 'none'],
    ]
  )
  assert.equal(got.filter((g) => g.available).length, 1, 'only M1 may be calculated')
})

/* --------------------------------------------- folding the source rows ---- */

/*
 * Rows in the shape the Power BI client returns them - table prefixes already
 * stripped, which is the shape that caused an earlier defect.
 */
const row = (date, product, plu, qty) => ({
  Date: `${date}T00:00:00`,
  ProductName_Fixed_Option: product,
  Clean_ItemID: plu,
  Qty: qty,
})

const PERIOD_OF = new Map([
  ['2026-12-01', 1],
  ['2026-12-02', 1],
  ['2026-12-31', 2],
])

test('the fold is at PLU grain: one item per product-PLU pair', () => {
  const got = foldDaily(
    [
      row('2026-12-01', 'Sprite', '3002016', 10),
      row('2026-12-01', 'Sprite', '3003010', 4),
      row('2026-12-01', 'Fries', '8300110', 7),
    ],
    PERIOD_OF
  )
  assert.equal(got.items.size, 3, 'Sprite under two codes is two items')
  assert.equal(got.products.size, 2, 'but still two products')
  assert.deepEqual([...got.items.keys()].sort(), ['Fries|8300110', 'Sprite|3002016', 'Sprite|3003010'])
})

test('two PLUs of one product keep their own quantities', () => {
  const got = foldDaily(
    [row('2026-12-01', 'Sprite', '3002016', 10), row('2026-12-01', 'Sprite', '3003010', 4)],
    PERIOD_OF
  )
  assert.equal(got.perDay.get('Sprite|3002016|2026-12-01'), 10)
  assert.equal(got.perDay.get('Sprite|3003010|2026-12-01'), 4)
  // And they sum back to the product - the additivity the regrain rests on.
  assert.equal(got.perPeriod.get('Sprite|3002016|1') + got.perPeriod.get('Sprite|3003010|1'), 14)
})

test('a product’s PLUs are listed busiest first', () => {
  const got = foldDaily(
    [
      row('2026-12-01', 'Sprite', '3002016', 4),
      row('2026-12-01', 'Sprite', '3003010', 11),
      row('2026-12-02', 'Sprite', '3002016', 2),
    ],
    PERIOD_OF
  )
  assert.deepEqual(got.plusOf.get('Sprite').map((x) => x.plu), ['3003010', '3002016'])
})

test('a row with no PLU keeps its quantity under an explicit marker', () => {
  const got = foldDaily([row('2026-12-01', 'Mystery Item', '', 9)], PERIOD_OF)
  assert.equal(got.items.size, 1)
  assert.equal([...got.items.values()][0].plu, '(no PLU)', 'not dropped, not blank')
  assert.equal(got.perDay.get('Mystery Item|(no PLU)|2026-12-01'), 9)
})

test('coverage is brand x date: one PLU selling that day covers the day', () => {
  const got = foldDaily([row('2026-12-01', 'Sprite', '3002016', 10)], PERIOD_OF)
  assert.ok(got.coveredDates.has('2026-12-01'))
  assert.equal(got.coveredDates.has('2026-12-02'), false, 'no row, no coverage')
})

test('excluding a product removes it without changing what the source covers', () => {
  const rows = [row('2026-12-01', 'Sprite', '3002016', 10), row('2026-12-01', 'Fries', '8300110', 7)]
  const got = foldDaily(rows, PERIOD_OF, ['Sprite'])
  assert.equal(got.items.size, 1, 'only Fries survives')
  assert.equal(got.excludedQty.get(1), 10, 'and the dropped quantity is reported')
  assert.ok(
    got.coveredDates.has('2026-12-01'),
    'what the reader excluded says nothing about what the source holds'
  )
})

test('a date outside the window is ignored entirely', () => {
  const got = foldDaily([row('2025-01-01', 'Sprite', '3002016', 10)], PERIOD_OF)
  assert.equal(got.items.size, 0)
  assert.equal(got.coveredDates.size, 0)
})

test('zero and negative quantities never create an item or cover a date', () => {
  const got = foldDaily(
    [row('2026-12-01', 'Sprite', '3002016', 0), row('2026-12-02', 'Fries', '8300110', -5)],
    PERIOD_OF
  )
  assert.equal(got.items.size, 0)
  assert.equal(got.coveredDates.size, 0)
})

/* -------------------------------------------------- reading a Power BI row --- */

/*
 * The defect these exist for, 11 Nov 2026.
 *
 * Every test above passed while this module returned "no forecast for this
 * window yet" for a window holding 885,960 rows and 3,847,080 forecast units.
 * None of them touched a Power BI row, and that is where all three bugs were:
 * the keys were asked for as the DAX spells them, and the client had already
 * stripped the table prefix off.
 *
 * The rows below are copied verbatim from a live probe of the BBT model, keys
 * and capitalisation exactly as the client returned them. That is the whole
 * point - a row shape invented here would have agreed with the broken code.
 */

const PRODUCT_ROW = { Date: '2026-07-01T00:00:00', ProductName_Fixed_Option: 'Sprite', Qty: 30 }
const SALES_ROW = { DATE: '2026-07-01T00:00:00', Value: 22534.56 }

test('a grouped column is found though the client stripped its table prefix', () => {
  assert.equal(val(PRODUCT_ROW, 'Forecast_Product_Table[ProductName_Fixed_Option]'), 'Sprite')
  assert.equal(val(PRODUCT_ROW, 'DateTable[Date]'), '2026-07-01T00:00:00')
})

test('a column the client returned in capitals is still found', () => {
  // 'FORECAST (2)'[Date] comes back as DATE, while the product model's own
  // Date column comes back as Date. Two spellings, one module.
  assert.equal(val(SALES_ROW, "'FORECAST (2)'[Date]"), '2026-07-01T00:00:00')
})

test('a measure alias is found unchanged', () => {
  assert.equal(val(PRODUCT_ROW, 'Qty'), 30)
  assert.equal(val(SALES_ROW, 'Value'), 22534.56)
})

test('a bracketed key is found when the client did NOT strip it', () => {
  // The other shape the client can return, so the fix cannot depend on which.
  assert.equal(val({ '[Qty]': 7 }, 'Qty'), 7)
  assert.equal(val({ 'Forecast_Product_Table[ProductName_Fixed_Option]': 'Fries' },
    'Forecast_Product_Table[ProductName_Fixed_Option]'), 'Fries')
})

test('a column that genuinely is not there reads as undefined, not as a wrong one', () => {
  assert.equal(val(PRODUCT_ROW, 'Forecast_Product_Table[LocationID]'), undefined)
  assert.equal(val(null, 'Qty'), undefined)
})

test('the product row survives the filter that used to discard every row', () => {
  // Line for line as `newStoreForecast` reads a row.
  const date = String(val(PRODUCT_ROW, 'DateTable[Date]') ?? '').slice(0, 10)
  const product = String(val(PRODUCT_ROW, 'Forecast_Product_Table[ProductName_Fixed_Option]') ?? '').trim()
  const qty = Number(val(PRODUCT_ROW, 'Qty')) || 0
  assert.ok(date && product && qty > 0, 'this row must not be skipped')
  assert.equal(date, '2026-07-01')
  assert.equal(product, 'Sprite')
})

test('the sales row yields a month rather than the empty-string marker', () => {
  const m = `${String(val(SALES_ROW, "'FORECAST (2)'[Date]") ?? '').slice(0, 7)}-01`
  assert.notEqual(m, '-01', 'the month key the module skips on')
  assert.equal(m, '2026-07-01')
})

test('distributing by weights preserves the monthly quantity', () => {
  const monthly = 1234.5
  const shape = [5, 3, 2, 8, 1]
  const total = shape.reduce((a, b) => a + b, 0)
  const daily = shape.map((q) => monthly * (q / total))
  const sum = daily.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - monthly) < 1e-9)
  // and after rounding
  assert.equal(largestRemainder(daily, monthly).reduce((a, b) => a + b, 0), Math.round(monthly))
})
