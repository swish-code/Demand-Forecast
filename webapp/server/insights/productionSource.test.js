import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SOURCE,
  SOURCES,
  UNCLASSIFIED,
  PREP_SOURCES,
  isPrepRow,
  prepSurvives,
} from './productionSource.js'

/*
 * The PREP exemption, added 3 Nov 2026.
 *
 * A prep step carries no `Item No.` in any of the nine models, so it always
 * resolves to `Unclassified` and the per-site pin dropped every one of them.
 * These pin the rule that lets it back onto the two pages where prep work
 * actually happens - and, just as importantly, the three cases where it must
 * NOT come back.
 */

/* ------------------------------------------------- the constants ------- */

test('the source names are the ones the pages pin themselves to', () => {
  // A typo here would silently stop exempting rather than fail, so the exact
  // strings are pinned - they must match `lockProdSource` in App.jsx.
  assert.equal(SOURCE.CK, 'Central Kitchen / CPU')
  assert.equal(SOURCE.BAKERY, 'Bakery')
  assert.equal(SOURCE.FACTORY, 'YELO Factory')
  assert.deepEqual(SOURCES, [SOURCE.CK, SOURCE.BAKERY, SOURCE.FACTORY, UNCLASSIFIED])
})

test('only the kitchen and the bakery show prep work', () => {
  assert.deepEqual([...PREP_SOURCES], [SOURCE.CK, SOURCE.BAKERY])
})

/* ------------------------------------------------- isPrepRow ----------- */

test('a prep step is recognised by Node Type, not by a blank article', () => {
  assert.equal(isPrepRow({ 'Node Type': 'PREP' }), true)
  assert.equal(isPrepRow({ 'Node Type': ' prep ' }), true)
})

test('a PA row with no article number is NOT a prep step', () => {
  /*
   * The whole reason the test is on Node Type. A PA row missing its number is
   * a data fault and must keep being dropped; rescuing it with the same rule
   * would hide the fault behind a row that looks fine.
   */
  assert.equal(isPrepRow({ 'Node Type': 'PA', 'Item No.': '' }), false)
  assert.equal(isPrepRow({ 'Node Type': 'RAW' }), false)
  assert.equal(isPrepRow({}), false)
  assert.equal(isPrepRow(null), false)
})

/* ------------------------------------------------- prepSurvives -------- */

test('PREP survives the pin on Production and on Swish Bakery', () => {
  assert.equal(prepSurvives(new Set([SOURCE.CK])), true)
  assert.equal(prepSurvives(new Set([SOURCE.BAKERY])), true)
  // An account granted both pages and no page pin sees it on either.
  assert.equal(prepSurvives(new Set([SOURCE.CK, SOURCE.BAKERY])), true)
})

test('PREP does NOT survive on the YELO Factory page', () => {
  assert.equal(prepSurvives(new Set([SOURCE.FACTORY])), false)
})

test('asking for the factory alongside the kitchen keeps the stricter answer', () => {
  // Otherwise the factory's exclusion could be widened by asking for it next
  // to something that does show prep.
  assert.equal(prepSurvives(new Set([SOURCE.CK, SOURCE.FACTORY])), false)
})

test('the Unclassified page is unchanged - it never needed the exemption', () => {
  /*
   * PREP resolves to `Unclassified`, so on that page `wanted.has(source)` is
   * already true and the exemption is never consulted. False here is therefore
   * the correct answer AND harmless.
   */
  assert.equal(prepSurvives(new Set([UNCLASSIFIED])), false)
})

test('an unpinned page is untouched', () => {
  // Stock Article resolves to no sources at all, so the filter never runs.
  assert.equal(prepSurvives(new Set()), false)
  assert.equal(prepSurvives(null), false)
  assert.equal(prepSurvives(undefined), false)
})
