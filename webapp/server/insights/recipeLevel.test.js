import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wholeMonthsOf } from './recipeLevel.js'

test('a window of whole months lists every month in it', () => {
  assert.deepEqual(wholeMonthsOf('2026-03-01', '2026-10-31'), [
    '2026-03-01',
    '2026-04-01',
    '2026-05-01',
    '2026-06-01',
    '2026-07-01',
    '2026-08-01',
    '2026-09-01',
    '2026-10-01',
  ])
})

test('one month, February and a year boundary', () => {
  assert.deepEqual(wholeMonthsOf('2026-02-01', '2026-02-28'), ['2026-02-01'])
  assert.deepEqual(wholeMonthsOf('2025-12-01', '2026-01-31'), ['2025-12-01', '2026-01-01'])
})

test('a window that starts or ends mid-month is not whole months', () => {
  assert.equal(wholeMonthsOf('2026-03-05', '2026-10-31'), null)
  assert.equal(wholeMonthsOf('2026-03-01', '2026-10-30'), null)
  assert.equal(wholeMonthsOf('2026-02-01', '2026-02-27'), null)
})

test('missing, reversed or very long windows fall back to one query', () => {
  assert.equal(wholeMonthsOf(null, '2026-10-31'), null)
  assert.equal(wholeMonthsOf('2026-10-01', '2026-03-31'), null)
  assert.equal(wholeMonthsOf('2020-01-01', '2026-10-31'), null)
})
