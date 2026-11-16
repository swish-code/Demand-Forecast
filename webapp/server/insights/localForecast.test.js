import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  weekday,
  aovFrom,
  ordersFrom,
  forecastQty,
  datesBetween,
} from './localForecast.js'

/*
 * The arithmetic the locally built forecast rests on, tested without a
 * database or a Power BI token.
 *
 * These are not incidental helpers. Each one reproduces a specific piece of
 * DAX read out of the brands' semantic models, and the whole table is only
 * trustworthy for as long as they keep matching it:
 *
 *   weekday     WEEKDAY(date, 2)
 *   aovFrom     Forecast_Product_Table[AOV]
 *   ordersFrom  DIVIDE([Total_Sales], [AOV], 0)
 *   forecastQty ROUND([Incidence Rate Final] * [Forecast_Orders], 0)
 */

test('WEEKDAY(date, 2) runs Monday = 1 through Sunday = 7', () => {
  // 16 Nov 2026 is a Monday.
  assert.equal(weekday('2026-11-16'), 1)
  assert.equal(weekday('2026-11-17'), 2)
  assert.equal(weekday('2026-11-21'), 6)
  // Sunday is 7, not 0 — the DAX's mode 2, not JavaScript's getUTCDay.
  assert.equal(weekday('2026-11-22'), 7)
})

test('a date that is not one returns null rather than NaN', () => {
  assert.equal(weekday('not a date'), null)
  assert.equal(weekday(''), null)
})

test('the weekday is read in UTC, so a timestamp cannot shift it a day', () => {
  assert.equal(weekday('2026-11-22T23:30:00'), weekday('2026-11-22'))
})

/* ------------------------------------------------------------------- AOV */

const HISTORY = [
  { date: '2026-11-04', aov: 4.0 }, // Wednesday
  { date: '2026-11-11', aov: 5.0 }, // Wednesday
  { date: '2026-11-18', aov: 6.0 }, // Wednesday
  { date: '2026-11-19', aov: 99.0 }, // Thursday — must never be picked
  { date: '2026-10-28', aov: 1.0 }, // Wednesday, older than the three
]

test('AOV averages the three most recent dates sharing the weekday', () => {
  // A future Wednesday: the three most recent Wednesdays are 18, 11 and 4 Nov.
  assert.equal(aovFrom(HISTORY, '2027-03-10'), 5)
})

test('AOV ignores other weekdays entirely', () => {
  // If Thursday's 99 leaked in, the mean would be far higher.
  assert.ok(aovFrom(HISTORY, '2027-03-10') < 7)
})

test('AOV takes the three most recent, not the first three found', () => {
  // 28 Oct is a Wednesday too, but it is fourth in line and must be dropped.
  assert.equal(aovFrom(HISTORY, '2027-03-10'), (6 + 5 + 4) / 3)
})

test('AOV is strictly before the date, matching the DAX', () => {
  // Asking ON 18 Nov must exclude 18 Nov itself, leaving the three Wednesdays
  // before it: 11 Nov, 4 Nov and 28 Oct.
  assert.equal(aovFrom(HISTORY, '2026-11-18'), (5 + 4 + 1) / 3)
})

test('fewer than three same-weekday dates averages what there is', () => {
  // Before 11 Nov only two Wednesdays exist, so the mean is over two.
  assert.equal(aovFrom(HISTORY, '2026-11-11'), (4 + 1) / 2)
})

test('no same-weekday history at all is null, not zero', () => {
  // Null propagates into a refusal; zero would become a division by zero and
  // then an infinite quantity.
  assert.equal(aovFrom(HISTORY, '2026-11-16'), null)
  assert.equal(aovFrom([], '2027-03-10'), null)
})

/* ---------------------------------------------------------------- orders */

test('orders divide sales by AOV', () => {
  assert.equal(ordersFrom(1000, 4), 250)
})

test('DIVIDE semantics: a zero or missing AOV yields 0, never an infinity', () => {
  assert.equal(ordersFrom(1000, 0), 0)
  assert.equal(ordersFrom(1000, null), 0)
  assert.equal(ordersFrom(1000, undefined), 0)
  assert.ok(Number.isFinite(ordersFrom(1000, 0)))
})

/* ------------------------------------------------------------------- qty */

test('quantity is the rate times the orders, rounded', () => {
  assert.equal(forecastQty(0.1, 2504), 250)
})

test('rounding is half away from zero, as DAX ROUND is', () => {
  assert.equal(forecastQty(0.5, 1), 1)
  assert.equal(forecastQty(1.5, 1), 2)
  assert.equal(forecastQty(2.5, 1), 3) // not 2 — this is not banker's rounding
  assert.equal(forecastQty(-0.5, 1), -1) // not 0 — JavaScript's Math.round gives 0
})

test('a missing rate is null, not a zero quantity', () => {
  // The distinction the whole horizon rests on: past the spine there is no
  // rate, and that must not read as a forecast of nothing.
  assert.equal(forecastQty(null, 2504), null)
  assert.equal(forecastQty(undefined, 2504), null)
})

/* ----------------------------------------------------------------- dates */

test('a date range includes both ends', () => {
  assert.deepEqual(datesBetween('2027-01-01', '2027-01-03'), [
    '2027-01-01',
    '2027-01-02',
    '2027-01-03',
  ])
})

test('a range crosses a month and a leap-free February without drifting', () => {
  const days = datesBetween('2027-02-26', '2027-03-02')
  assert.deepEqual(days, ['2027-02-26', '2027-02-27', '2027-02-28', '2027-03-01', '2027-03-02'])
})

test('a backwards range is empty, not infinite', () => {
  assert.deepEqual(datesBetween('2027-03-02', '2027-03-01'), [])
})

/* -------------------------------------------------- the chain, end to end */

test('the whole chain reproduces a Power BI row', () => {
  /*
   * BBT KWT, 10 March 2027 — one of the 3,348 rows verified exact against the
   * model. Total_Sales 11,803.84, AOV 4.7124 (the mean of the three preceding
   * Wednesdays), rate 0.0075187.
   */
  const aov = 4.7124
  const orders = ordersFrom(11803.84, aov)
  assert.ok(Math.abs(orders - 2504.84) < 0.5, `orders was ${orders}`)
  assert.equal(forecastQty(0.0075187, orders), 19)
})
