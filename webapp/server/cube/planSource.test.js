import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { forecastAnnual, usableMonths } from './planSource.js'

/*
 * `forecastAnnual` decides HOW BIG a forecast year is, and every 2027 quantity
 * the app produces is that number multiplied by something - the month's share
 * of the year, then the product mix, then the recipe tree. A mistake here is
 * not a display bug, it scales the whole year.
 *
 * The property these exist to protect is the one that was broken: the figure
 * must come from the model and from nothing else. The Sales Plan page is a
 * separate feature for recording a target, and a target must never reach a
 * forecast.
 */

const twelve = (v) => new Array(12).fill(v)

/* ------------------------------------------------- the figure it returns --- */

test('the annual figure is the sum of the twelve months, not an average', () => {
  assert.equal(forecastAnnual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).value, 78)
})

test('a complete year is accepted', () => {
  const out = forecastAnnual(twelve(500_000))
  assert.equal(out.value, 6_000_000)
})

test('the twelve months are carried through for reconciliation', () => {
  const months = twelve(100)
  assert.deepEqual(forecastAnnual(months).months, months)
})

test('what comes back is a size, not a set of weights', () => {
  const out = forecastAnnual(twelve(1000))
  assert.equal(out.value, 12_000)
  assert.ok(!('weights' in out), 'forecastAnnual must not return a shape')
})

/* ------------------------------------------ refusing an incomplete year --- */

test('eleven months are refused, not scaled up to twelve', () => {
  const months = twelve(100)
  months[5] = 0
  assert.equal(forecastAnnual(months), null)
})

test('a short array is refused', () => {
  assert.equal(forecastAnnual([1, 2, 3]), null)
})

test('a negative month is refused rather than netted off', () => {
  const months = twelve(100)
  months[0] = -50
  assert.equal(forecastAnnual(months), null)
})

test('a non-numeric month is refused', () => {
  const months = twelve(100)
  months[3] = null
  assert.equal(usableMonths(months), null)
  assert.equal(forecastAnnual(months), null)
})

test('no source at all yields null, never a zero', () => {
  // A zero is not an absence - it is a forecast that nothing will be sold, and
  // `planMix` would divide by it and report a confident nothing.
  assert.equal(forecastAnnual(null), null)
  assert.equal(forecastAnnual(undefined), null)
  assert.equal(forecastAnnual([]), null)
})

test('a year of zeroes is refused rather than summed to zero', () => {
  assert.equal(forecastAnnual(twelve(0)), null)
})

/* ----------------------------------- the independence guarantee, as code --- */

/*
 * These are the tests the brief actually asks for: that no unintended
 * dependency on a manually entered Sales Plan value can exist.
 *
 * They are asserted structurally rather than behaviourally, because a
 * behavioural test can only show that one particular call did not consult a
 * typed figure. Showing that the function has no parameter for one, and that
 * the forecast path never reads the typed field, rules the whole class out.
 */

test('forecastAnnual takes exactly one argument - there is no typed input', () => {
  assert.equal(forecastAnnual.length, 1)
})

test('planSource.js never mentions the typed sales-plan table', () => {
  const src = readFileSync(new URL('./planSource.js', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!code.includes('cube_sales_plan'), 'the forecast size must not read cube_sales_plan')
})

test('the forecast path reads forecastValue, never the typed value', () => {
  const src = readFileSync(new URL('../insights/salesPlan.js', import.meta.url), 'utf8')
  // `planWindow` is the one door every forecast surface goes through. Whatever
  // it multiplies is what the warehouse, product, mix and article forecasts
  // run on, so this pins the one line that matters.
  const body = src.slice(src.indexOf('export function planWindow'))
  const window = body.slice(0, body.indexOf('\n}\n'))
  assert.ok(
    window.includes('plan.forecastValue * share'),
    'planWindow must size the window from the model figure'
  )
  assert.ok(
    !/plannedValue:\s*plan\.value\b/.test(window),
    'planWindow must not size the window from the typed target'
  )
  assert.ok(
    window.includes('!plan?.forecastUsable'),
    'planWindow must gate on forecastUsable, not on the typed target'
  )
})

test('planUnitsFor - the product path - reads the model figure', () => {
  const src = readFileSync(new URL('../insights/planForecast.js', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export function planUnitsFor'))
  const fn = body.slice(0, body.indexOf('\n}\n'))
  assert.ok(fn.includes('forecastMonthlyValues'), 'planUnitsFor must use the forecast values')
  assert.ok(
    !/\bplanMonthlyValues\s*\(/.test(fn),
    'planUnitsFor must not use the typed monthly values'
  )
})

test('planMonthlyValues - the page feature - is not imported by the forecast path', () => {
  const src = readFileSync(new URL('../insights/planForecast.js', import.meta.url), 'utf8')
  const imports = src.slice(0, src.indexOf('\n\n'))
  assert.ok(
    !/\bplanMonthlyValues\b/.test(imports),
    'the forecast module must not import the typed-target accessor'
  )
})
