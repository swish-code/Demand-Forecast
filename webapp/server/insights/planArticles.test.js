import test from 'node:test'
import assert from 'node:assert/strict'
import { explodeArticles } from './planArticles.js'
import { belongsToBrand, recipeGroupNamesFor } from './recipeBrands.js'

/*
 * The article requirement is
 *
 *   SUM over menu items of ( that item's forecast x the article's qty per unit )
 *
 * These pin the cases that were argued over while it was being built, so a
 * later change cannot quietly reintroduce one of them.
 */

const rate = (plu, article, r) => ({ plu, article, rate: r })

test('one product, one article - the plain case', () => {
  const units = new Map([['100', 10]])
  const out = explodeArticles(units, [rate(100, 'A', 0.5)])
  assert.equal(out.get('A'), 5)
})

test('several menu items using one article add together', () => {
  const units = new Map([['100', 10], ['200', 4]])
  const out = explodeArticles(units, [rate(100, 'A', 0.5), rate(200, 'A', 2)])
  assert.equal(out.get('A'), 10 * 0.5 + 4 * 2)
})

test('different recipe quantities are honoured per menu item', () => {
  const units = new Map([['100', 100], ['200', 100]])
  const out = explodeArticles(units, [rate(100, 'A', 0.001), rate(200, 'A', 0.008)])
  assert.equal(Number(out.get('A').toFixed(6)), 0.9)
})

/*
 * Two paths to the same article inside ONE product are two real requirements -
 * a sauce in the base and again in a topping - so their rates add. The query
 * sums them before they reach here; what must never happen is the product's
 * units being counted once per path.
 */
test('multiple recipe paths add their rates, not the product units', () => {
  const units = new Map([['100', 10]])
  // The query returns one pre-summed row per (PLU, article): 0.2 + 0.3.
  const out = explodeArticles(units, [rate(100, 'A', 0.5)])
  assert.equal(out.get('A'), 5, 'one row per pair, units counted once')

  // If the query ever returned a row per path instead, the rates still add and
  // the units are still counted once each - which is the property that matters.
  const perPath = explodeArticles(units, [rate(100, 'A', 0.2), rate(100, 'A', 0.3)])
  assert.equal(perPath.get('A'), 5, 'rates add; units are not multiplied by path count')
})

/*
 * Several product NAMES can share one PLU on the sales side (YP PLU 958 is both
 * "7up" and "Sprite"). The units are summed per PLU before they get here, so
 * the rate must be applied once - not once per name.
 */
test('one PLU carrying several product names is multiplied once', () => {
  // 7up 30 units + Sprite 70 units, summed to the PLU by the caller.
  const units = new Map([['958', 100]])
  const out = explodeArticles(units, [rate(958, 'A', 0.01)])
  assert.equal(Number(out.get('A').toFixed(6)), 1)
})

test('PLU matching is exact - a different PLU contributes nothing', () => {
  const units = new Map([['40005094', 3526]])
  const out = explodeArticles(units, [rate(40005094, 'A', 0.006), rate(40005095, 'B', 0.005)])
  assert.equal(Number(out.get('A').toFixed(3)), 21.156)
  assert.equal(out.has('B'), false, 'a PLU with no planned units adds nothing')
})

test('numeric and string PLUs both resolve', () => {
  const units = new Map([['100', 10]])
  assert.equal(explodeArticles(units, [rate(100, 'A', 1)]).get('A'), 10, 'numeric PLU')
  assert.equal(explodeArticles(units, [rate('100', 'A', 1)]).get('A'), 10, 'string PLU')
})

/*
 * The real worked example, from the recipe master on 28 Sep 2026.
 * 106401405 Yelo Nashville Seasoning Powder across its seven menu items.
 */
test('worked example: Yelo Nashville Seasoning Powder', () => {
  const units = new Map([
    ['40005094', 3526], ['40005096', 3323], ['4000501162', 1958], ['40005095', 2753],
    ['4000501161', 1052], ['40005091', 2475], ['40005093', 2089],
  ])
  const rates = [
    rate(40005094, 'NASH', 0.006), rate(40005096, 'NASH', 0.005),
    rate(4000501162, 'NASH', 0.008), rate(40005095, 'NASH', 0.005),
    rate(4000501161, 'NASH', 0.008), rate(40005091, 'NASH', 0.001),
    rate(40005093, 'NASH', 0.001),
  ]
  assert.equal(Number(explodeArticles(units, rates).get('NASH').toFixed(3)), 80.180)
})

// --- brand scoping -------------------------------------------------------

test('recipe groups are scoped to the right brand', () => {
  assert.equal(belongsToBrand('YP', 'Yelo Pizza Finished Product'), true)
  assert.equal(belongsToBrand('YP', 'BBT Final Food Recipe'), false, 'BBT lettuce must not reach YP')
  assert.equal(belongsToBrand('BUR', 'Just C Final Food Recipes'), true, 'Just C is BUR')
  assert.equal(belongsToBrand('SLC', 'Slice Final Food Recipes'), true)
})

test('recipe group names match despite double spaces and case', () => {
  assert.equal(belongsToBrand('YP', 'bola  Yelo recipes'), true)
  assert.equal(belongsToBrand('YP', 'YELO PIZZA  COMMISSARY'), true)
  assert.equal(belongsToBrand('CHP', ' Chilipepper Final Product '), true)
})

test('unmapped groups belong to nobody', () => {
  for (const brand of ['YP', 'BBT', 'MM', 'SLC', 'BUR']) {
    assert.equal(belongsToBrand(brand, 'FM Finished Item'), false, 'FM is a separate company')
    assert.equal(belongsToBrand(brand, 'Love bird Final Food Recipe'), false, 'Love bird is unassigned')
  }
})

test('an unknown brand is permissive rather than empty', () => {
  assert.equal(belongsToBrand('NEW', 'Anything At All'), true)
  assert.equal(recipeGroupNamesFor('NEW'), null)
})
