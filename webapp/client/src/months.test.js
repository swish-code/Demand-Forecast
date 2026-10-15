import test from 'node:test'
import assert from 'node:assert/strict'
import { monthsIn } from './months.js'

/**
 * The month boundary the Procurement view lays its columns out on.
 *
 * Worth pinning rather than eyeballing: a wrong last day asks the API for a
 * window that does not exist, and a dropped month disappears from a plan with
 * nothing on screen to say it is missing.
 */

const keys = (from, to) => monthsIn(from, to).map((m) => m.key)

test('a single whole month is one month', () => {
  const [m, ...rest] = monthsIn('2026-10-01', '2026-10-31')
  assert.equal(rest.length, 0)
  assert.deepEqual(
    { key: m.key, from: m.from, to: m.to },
    { key: '2026-10', from: '2026-10-01', to: '2026-10-31' }
  )
})

test('a part month is EXPANDED to the whole month, not clipped', () => {
  // A reader who picks the 15th is asking about that month, and a part month
  // beside whole ones would put numbers of different lengths under one heading.
  const [m] = monthsIn('2026-10-15', '2026-10-20')
  assert.equal(m.from, '2026-10-01')
  assert.equal(m.to, '2026-10-31')
})

test('each month gets its own last day', () => {
  const got = monthsIn('2026-01-01', '2026-04-30')
  assert.deepEqual(
    got.map((m) => m.to),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']
  )
})

test('February in a leap year is the 29th', () => {
  const [m] = monthsIn('2028-02-01', '2028-02-29')
  assert.equal(m.to, '2028-02-29')
})

test('a range crossing a year end keeps going', () => {
  assert.deepEqual(keys('2026-11-15', '2027-02-02'), [
    '2026-11',
    '2026-12',
    '2027-01',
    '2027-02',
  ])
})

test('the plan year Procurement asked for', () => {
  const got = keys('2027-01-01', '2027-06-30')
  assert.deepEqual(got, ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06'])
})

test('a whole year is twelve months', () => {
  assert.equal(monthsIn('2027-01-01', '2027-12-31').length, 12)
})

test('a careless range is capped rather than becoming a hundred requests', () => {
  assert.equal(monthsIn('2020-01-01', '2030-12-31').length, 24)
})

test('nothing sensible in, nothing out', () => {
  assert.deepEqual(monthsIn(null, null), [])
  assert.deepEqual(monthsIn('2026-10-01', null), [])
  assert.deepEqual(monthsIn('', ''), [])
  // Backwards: a range that ends before it starts is not a range.
  assert.deepEqual(monthsIn('2026-10-01', '2026-09-01'), [])
})

test('labels name the month and the year', () => {
  const [m] = monthsIn('2027-01-01', '2027-01-31')
  assert.equal(m.label, 'January 2027')
  assert.equal(m.short, 'JAN 2027')
})
