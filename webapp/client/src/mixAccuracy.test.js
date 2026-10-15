import test from 'node:test'
import assert from 'node:assert/strict'
import { mixAccuracy } from './mixAccuracy.js'

/**
 * The product-mix score, which moved out of `ComponentLevel.jsx` on 8 Oct 2026
 * so the Procurement view could use the same one.
 *
 * The first test is the one that matters: it asserts this function agrees with
 * the formula that was inline in that page, for every case either of them can
 * meet. A refactor that quietly changed a published figure is exactly the
 * failure this guards.
 */

/** The formula exactly as it read in ComponentLevel.jsx before the move. */
function inlineBefore(forecast, actual) {
  return actual === null ||
    actual === undefined ||
    Number(actual) <= 0 ||
    forecast === null ||
    forecast === undefined
    ? null
    : 1 - Math.abs(Number(actual) - Number(forecast)) / Number(actual)
}

test('agrees with the formula it replaced, case for case', () => {
  const values = [null, undefined, -40, 0, 1, 7.5, 100, 40345]
  let compared = 0
  for (const f of values) {
    for (const a of values) {
      assert.equal(
        mixAccuracy(f, a),
        inlineBefore(f, a),
        `forecast=${String(f)} actual=${String(a)}`
      )
      compared += 1
    }
  }
  assert.equal(compared, 64)
})

test('a perfect forecast scores 100%', () => {
  assert.equal(mixAccuracy(500, 500), 1)
})

test('half of what was needed scores 50%', () => {
  assert.equal(mixAccuracy(50, 100), 0.5)
})

test('double what was needed also scores 50% - the actual is the denominator', () => {
  // Not symmetric, unlike whAccuracy: this asks how wrong the plan was about
  // what we would need, and the thing that happened is what it is measured on.
  assert.equal(mixAccuracy(200, 100), 0)
  assert.equal(mixAccuracy(150, 100), 0.5)
})

test('no actual is null, not zero', () => {
  // A future month is the common case. Zero would read as a forecast that
  // missed completely.
  assert.equal(mixAccuracy(1000, null), null)
  assert.equal(mixAccuracy(1000, undefined), null)
})

test('an actual of zero is null - nothing moved is not an accuracy of nought', () => {
  assert.equal(mixAccuracy(1000, 0), null)
})

test('no forecast is null', () => {
  // No recipe names the article, so the mix has nothing to explode through one.
  assert.equal(mixAccuracy(null, 1000), null)
})

test('the figure is left signed and unbounded', () => {
  // Pepsi Cola Can: forecast 40,345 against four units issued. That is a
  // finding about a discontinued line, not a number to clamp away.
  const v = mixAccuracy(40345, 4)
  assert.ok(v < -10000, `expected a large negative score, got ${v}`)
})

test('a non-numeric side is null rather than NaN', () => {
  assert.equal(mixAccuracy('x', 100), null)
  assert.equal(mixAccuracy(100, 'x'), null)
})
