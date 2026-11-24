import test from 'node:test'
import assert from 'node:assert/strict'

import { carryForward } from './storeStock.js'

/**
 * The warehouse balance is each article's own LATEST reading, not the readings
 * stamped on the feed's newest day.
 *
 * The feed stops writing a row for an article at a location once its balance
 * reaches nil, so an article that has run out simply stops appearing. Asking
 * for one single day therefore returned nothing for it, and the planning table
 * printed a dash where the truthful answer was the zero it last recorded - and
 * then blanked DTL, the out-of-stock date, target cover, the requested quantity
 * and every delivery date with it, because all of them divide SOH.
 *
 * `carryForward` is the rule, lifted out of the query so it can be checked
 * without Power BI. The cases below are the contract: newest eligible day wins,
 * nothing after the as-of day is eligible, locations on one day are summed,
 * recorded quantities are returned exactly, and an article with no reading is
 * absent rather than zero.
 *
 * Rows are written in the shape `executeQuery` returns after `normalizeRows`
 * strips the table and measure brackets - `Article No.`, `LastDay`, `SOH`.
 */
const row = (article, day, soh) => ({ 'Article No.': article, LastDay: day, SOH: soh })

const AS_OF = '2026-11-24'

test('an article read on the as-of day returns that reading', () => {
  const { soh, readOn, asOf } = carryForward([row('104200004', AS_OF, 1200)], { asOf: AS_OF })
  assert.equal(soh.get('104200004'), 1200)
  assert.equal(readOn.get('104200004'), AS_OF)
  assert.equal(asOf, AS_OF)
})

test('an article with no current-day row returns its latest earlier reading', () => {
  const { soh, readOn } = carryForward([row('105900006', '2026-11-11', 340)], { asOf: AS_OF })
  assert.equal(soh.get('105900006'), 340)
  assert.equal(readOn.get('105900006'), '2026-11-11')
})

/*
 * The article the whole change came from. It ran 90 -> 60 -> 30 -> 0 at MAIN
 * WAREHOUSE over 18-21 Nov 2026 and has had no row since, so a single-day read
 * on the 24th found nothing and the planning row went blank from SOH rightward.
 */
test('Kinza Orange reads zero, as at the day it emptied', () => {
  const rows = [
    row('100900053', '2026-11-18', 90),
    row('100900053', '2026-11-19', 60),
    row('100900053', '2026-11-20', 30),
    row('100900053', '2026-11-21', 0),
  ]
  const { soh, readOn } = carryForward(rows, { asOf: AS_OF })
  assert.equal(soh.get('100900053'), 0)
  assert.equal(readOn.get('100900053'), '2026-11-21')
})

/*
 * A negative book balance is a data fault worth seeing, and this function's job
 * is to report the latest recorded balance rather than to improve it. Ten of the
 * 645 carried-forward articles were negative on 24 Nov 2026, from -5 to -14,000
 * units; flooring them would hide a fault behind a plausible-looking zero.
 */
test('a negative historical balance stays negative', () => {
  const { soh, readOn } = carryForward([row('104200072', '2026-11-19', -17)], { asOf: AS_OF })
  assert.equal(soh.get('104200072'), -17)
  assert.equal(readOn.get('104200072'), '2026-11-19')
})

test('a positive historical balance is unchanged', () => {
  const { soh } = carryForward([row('107400083', '2026-07-17', 78_000)], { asOf: AS_OF })
  assert.equal(soh.get('107400083'), 78_000)
})

/*
 * Never stocked and stocked-then-emptied are different facts, and only the
 * second has a balance. Absent, not zero - a zero here would invent a shortage.
 */
test('an article with no warehouse reading is absent, not zero', () => {
  const { soh, readOn } = carryForward([row('104200004', AS_OF, 1200)], { asOf: AS_OF })
  assert.equal(soh.has('999999999'), false)
  assert.equal(soh.get('999999999'), undefined)
  assert.equal(readOn.has('999999999'), false)
})

test('a row dated after the as-of day is not eligible', () => {
  const rows = [row('106300002', '2026-11-20', 500), row('106300002', '2026-12-05', 999)]
  const { soh, readOn } = carryForward(rows, { asOf: AS_OF })
  assert.equal(soh.get('106300002'), 500)
  assert.equal(readOn.get('106300002'), '2026-11-20')
})

test('an article whose only row is after the as-of day has no reading at all', () => {
  const { soh } = carryForward([row('106300002', '2026-12-05', 999)], { asOf: AS_OF })
  assert.equal(soh.has('106300002'), false)
})

test('many historical rows collapse to the latest eligible one', () => {
  const rows = [
    row('105900021', '2026-03-02', 10_000),
    row('105900021', '2026-09-27', 5_000),
    row('105900021', '2026-06-15', 7_500),
    row('105900021', '2026-10-14', 250),
  ]
  const { soh, readOn } = carryForward(rows, { asOf: AS_OF })
  assert.equal(soh.get('105900021'), 250)
  assert.equal(readOn.get('105900021'), '2026-10-14')
  assert.equal(soh.size, 1)
})

/*
 * Rows sharing the newest day are the article's separate warehouse locations on
 * one date, so they add. Rows on an older day are the same stock counted again,
 * so they must not.
 */
test('rows sharing the latest day are summed, earlier days discarded', () => {
  const rows = [
    row('102500001', '2026-11-20', 9_999),
    row('102500001', AS_OF, 300),
    row('102500001', AS_OF, 120),
  ]
  const { soh, readOn } = carryForward(rows, { asOf: AS_OF })
  assert.equal(soh.get('102500001'), 420)
  assert.equal(readOn.get('102500001'), AS_OF)
})

test('zero on the latest day beats a positive balance on an earlier one', () => {
  const rows = [row('103200001', '2026-11-19', 480), row('103200001', '2026-11-20', 0)]
  const { soh, readOn } = carryForward(rows, { asOf: AS_OF })
  assert.equal(soh.get('103200001'), 0)
  assert.equal(readOn.get('103200001'), '2026-11-20')
})

/*
 * A row with no numeric balance is not a reading. `Number(x) || 0` would turn
 * one into a zero, reporting "empty" for an article the feed said nothing about.
 */
test('a row with no usable balance or date is not a reading', () => {
  const rows = [
    { 'Article No.': '100100001', LastDay: AS_OF, SOH: null },
    { 'Article No.': '100100002', LastDay: AS_OF, SOH: '' },
    { 'Article No.': '100100003', LastDay: '', SOH: 50 },
    { 'Article No.': '', LastDay: AS_OF, SOH: 50 },
    { 'Article No.': '100100004', LastDay: 'not-a-date', SOH: 50 },
  ]
  const { soh } = carryForward(rows, { asOf: AS_OF })
  assert.equal(soh.size, 0)
})

test('a numeric string balance is read as a number', () => {
  const { soh } = carryForward([row('100100005', AS_OF, '1500')], { asOf: AS_OF })
  assert.equal(soh.get('100100005'), 1500)
})

test('no rows, or no as-of day, is handled rather than thrown', () => {
  assert.equal(carryForward([], { asOf: AS_OF }).soh.size, 0)
  assert.equal(carryForward(null, { asOf: AS_OF }).soh.size, 0)
  assert.equal(carryForward(undefined).soh.size, 0)
  // Without an as-of day every dated row is eligible - the caller has vouched
  // for nothing, so nothing is excluded on that basis.
  const { soh } = carryForward([row('100100006', '2026-12-05', 42)], {})
  assert.equal(soh.get('100100006'), 42)
})

/*
 * The whole point, in one case: the mixed set the live model returns. Articles
 * read on the as-of day keep exactly the figures the old single-day query gave
 * them, and the ones read earlier - which that query dropped entirely - arrive
 * beside them with their own dates.
 */
test('live and carried-forward articles come back together, each with its own date', () => {
  const rows = [
    row('104200004', AS_OF, 1200),
    row('100900053', '2026-11-21', 0),
    row('104200072', '2026-11-19', -17),
    row('107400083', '2026-07-17', 78_000),
  ]
  const { soh, readOn } = carryForward(rows, { asOf: AS_OF })
  assert.deepEqual(
    [...soh.entries()].sort(),
    [['100900053', 0], ['104200004', 1200], ['104200072', -17], ['107400083', 78_000]]
  )
  assert.equal(readOn.get('104200004'), AS_OF)
  assert.equal(readOn.get('100900053'), '2026-11-21')
  assert.equal(readOn.get('104200072'), '2026-11-19')
  assert.equal(readOn.get('107400083'), '2026-07-17')
})
