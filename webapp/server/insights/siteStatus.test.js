import test from 'node:test'
import assert from 'node:assert/strict'
import { SITE_COST_CENTRES, SOURCE, UNCLASSIFIED } from './productionSource.js'
import { SITE_NAMES } from '../powerbi/siteOutbound.js'
import { classifyOne, THRESHOLDS } from './whClassify.js'

/*
 * The Status ladder dated from a production site, added 5 Nov 2026.
 *
 * On the production pages "Status" asks how long since THAT SITE last issued
 * the article, not the warehouse - the warehouse never handles what the kitchen
 * makes, so the warehouse ladder marked every row Never shipped.
 *
 * `classifyOne` is shared with the warehouse path on purpose, so these tests
 * also pin that the two cannot drift into two definitions of Slow-Moving.
 */

/* ---------------------------------------------- the site name mapping -- */

test('each site names its own cost centres', () => {
  assert.deepEqual(SITE_COST_CENTRES.get(SOURCE.CK), [
    'Central Production Unit',
    'Centeral Kitchen',
  ])
  assert.deepEqual(SITE_COST_CENTRES.get(SOURCE.BAKERY), ['Swish Bakery'])
  assert.deepEqual(SITE_COST_CENTRES.get(SOURCE.FACTORY), ['Yelo Factory'])
})

test('CK/CPU keeps both spellings, because they are one renamed cost centre', () => {
  // Dropping either silently halves the Production page's history, and the
  // rename happened mid-window in early 2026 - so a window spanning it would
  // read half its articles as idle.
  const ck = SITE_COST_CENTRES.get(SOURCE.CK)
  assert.ok(ck.includes('Centeral Kitchen'), 'the source spells it "Centeral"')
  assert.ok(ck.includes('Central Production Unit'))
})

test('only the three real sites have an entry', () => {
  // This is what makes `withStatus` keep the warehouse ladder on Stock Article
  // and on Unclassified without naming either page.
  assert.equal(SITE_COST_CENTRES.size, 3)
  assert.equal(SITE_COST_CENTRES.get(UNCLASSIFIED), undefined)
  assert.equal(SITE_COST_CENTRES.get('Stock Article'), undefined)
})

test('SITE_NAMES is exactly the three sites flattened', () => {
  // `SITE_NAMES` decides what counts as production for the Outbound column.
  // Derived from the same map so the column and the status cannot disagree
  // about which cost centres are production sites.
  assert.deepEqual(SITE_NAMES, [
    'Central Production Unit',
    'Centeral Kitchen',
    'Swish Bakery',
    'Yelo Factory',
  ])
})

/* ---------------------------------------------- the shared ladder ------ */

test('the ladder is the same arithmetic whichever site dated it', () => {
  const at = '2026-10-30'
  const on = (lastShipped) => classifyOne({ lastShipped }, at).status

  assert.equal(on('2026-10-30'), 'active') //   0 days
  assert.equal(on('2026-09-01'), 'active') //  59 days
  assert.equal(on('2026-08-01'), 'slow-moving') //  90 days, the rung exactly
  assert.equal(on('2026-07-15'), 'super-slow-moving') // 107 days
  assert.equal(on('2026-07-01'), 'non-moving') // 121 days
  assert.equal(on('2026-06-01'), 'to-be-deactivated') // 151 days
  assert.equal(on('2026-01-01'), 'to-be-deactivated')
})

test('the rungs sit where the business sheet spaces them', () => {
  assert.equal(THRESHOLDS.active, 60)
  assert.equal(THRESHOLDS.slowMoving, 90)
  assert.equal(THRESHOLDS.superSlowMoving, 120)
  assert.equal(THRESHOLDS.nonMoving, 150)
})

test('no issuing record at all is Never shipped, not Non-Moving', () => {
  /*
   * The distinction the production pages lean on hardest. An article this site
   * has never issued has not "stopped moving" - there was nothing to stop - and
   * calling it Non-Moving would queue it for deactivation on no evidence.
   */
  const c = classifyOne(null, '2026-10-30')
  assert.equal(c.status, 'never-shipped')
  assert.equal(c.daysIdle, null)
  assert.equal(c.lastShipped, null)
})

test('a future window end cannot age an article', () => {
  // `clampAsAt` guards this upstream; this pins that the arithmetic itself
  // never returns a negative idle count if something slips past.
  const c = classifyOne({ lastShipped: '2026-10-30' }, '2026-10-01')
  assert.equal(c.daysIdle, 0)
  assert.equal(c.status, 'active')
})
