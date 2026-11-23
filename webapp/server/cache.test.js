import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ttlForWindow, SETTLED_TTL } from './cache.js'

/*
 * How long an answer is held, and why it is honest to hold it.
 *
 * Measured over 1-22 Nov 2026 across 4,351 requests: 78.3% of cache lookups
 * missed, and those misses accounted for essentially all of the 100,478
 * seconds spent inside requests. `pbi-wait` - queueing behind the per-minute
 * Power BI pacing, not querying - was 45,713s of it, 45% of all time.
 *
 * The heaviest lookups all ran on the 120-second default, so a reader moving
 * between pages re-asked the same question about the same finished month every
 * two minutes. These tests pin the rule that fixed it AND the limit on it.
 */

const today = () => new Date().toISOString().slice(0, 10)
const shift = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

test('a window that has already ended is held for an hour', () => {
  assert.equal(ttlForWindow('2026-10-31'), SETTLED_TTL)
  assert.equal(ttlForWindow(shift(-1)), SETTLED_TTL, 'yesterday is finished')
  assert.equal(ttlForWindow('2021-01-02'), SETTLED_TTL)
})

test('a window that includes TODAY keeps the short default', () => {
  /*
   * The direction that matters. Month-to-date, "last 7 days" and every live
   * figure end today, and those move while people watch them - which is
   * exactly the case where a stale number is noticed and disbelieved. Holding
   * them for an hour would buy speed with the thing the page is for.
   */
  assert.equal(ttlForWindow(today()), null, 'today is not finished')
  assert.equal(ttlForWindow(shift(1)), null, 'nor is tomorrow')
  assert.equal(ttlForWindow(shift(400)), null, 'nor a planned year')
})

test('no window at all is treated as live, not as settled', () => {
  /*
   * An open-ended question includes today by definition. Being wrong in this
   * direction costs a query; being wrong in the other costs a reader the
   * truth, so the default leans to asking again.
   */
  for (const v of [null, undefined, '', 'not a date', 'All dates', 42, {}]) {
    assert.equal(ttlForWindow(v), null, `${JSON.stringify(v)} must not be read as settled`)
  }
})

test('a date with a time on it is still read by its day', () => {
  assert.equal(ttlForWindow('2026-10-31T23:59:59'), SETTLED_TTL)
})

test('an hour, not a day - a late posting must not wait for a shift', () => {
  /*
   * A finished window is not immutable: a delivery note posted today against
   * last week's date backdates into a month already closed. The cache serves a
   * stale value while refreshing behind the request, so the page self-heals -
   * but the TTL still decides how long a reader can be behind, and a figure
   * that takes a working day to correct itself is not one anybody should plan
   * against.
   */
  assert.ok(SETTLED_TTL <= 3600, 'nothing settled should outlive an hour')
  assert.ok(SETTLED_TTL >= 600, 'and holding it for minutes defeats the point')
})

test('every data lookup goes through the window-aware TTL', () => {
  /*
   * `call` is the one door every figure on every page comes through. It ran on
   * the 120-second default, which is the whole of the miss problem in one
   * line; a future edit that drops the TTL argument would quietly restore it.
   */
  const src = readFileSync(new URL('./data/index.js', import.meta.url), 'utf8')
  const line = src.slice(src.indexOf('const call ='), src.indexOf('export const data'))
  assert.ok(/ttlForWindow\(f\?\.dateTo\)/.test(line), 'call must pass the window it was asked about')
})

test('the stale-while-revalidate window is still in force', () => {
  /*
   * The two halves work together: a longer TTL decides how often the question
   * is re-asked, and this decides whether a reader WAITS for the answer. Lose
   * it and the first reader after an expiry pays the full Power BI round trip
   * again, which is the cost this change exists to remove.
   */
  const src = readFileSync(new URL('./cache.js', import.meta.url), 'utf8')
  assert.ok(/const STALE_WINDOWS = \d+/.test(src))
  assert.ok(/note\('cache-stale', 0\)/.test(src), 'a stale serve must still be counted')
})
