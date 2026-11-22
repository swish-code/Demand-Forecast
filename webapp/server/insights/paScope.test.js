import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexNodes, placeLine, countsTowardPm } from './paScope.js'
import { fold } from './recipeLevel.js'

/*
 * A small tree shaped like the real ones (SS, 22 Nov 2026):
 *
 *   Broasted Meal
 *     Chicken Pieces            RAW   Level 1
 *     Garlic Sauce portion (PA) PA    Level 1, opens "Garlic Sauce portion"
 *       Clear Sauce Container   RAW   inside a PA  -> not counted
 *     Coleslaw Portion          PREP  Level 1, opens "Coleslaw Portion"
 *       Coleslaw Sticker        RAW   inside a PREP -> counted
 *       Marinated Kebab (PA)    PA    inside a PREP -> counted (the PA itself)
 *         Chicken Breast        RAW   inside a PA below a PREP -> not counted
 */
const nodes = indexNodes([
  { path: 'Broasted Meal', type: 'PA', item: 'Garlic Sauce portion (PA)' },
  { path: 'Broasted Meal', type: 'PREP', item: 'Coleslaw Portion' },
  { path: 'Broasted Meal > Coleslaw Portion', type: 'PA', item: 'Marinated Kebab (PA)' },
])

test('Level 1 lines count', () => {
  assert.equal(placeLine(nodes, 'Broasted Meal'), 'L1')
  assert.equal(countsTowardPm('L1'), true)
})

test('lines inside a PREP sub-recipe count', () => {
  assert.equal(placeLine(nodes, 'Broasted Meal > Coleslaw Portion'), 'PREP')
  assert.equal(countsTowardPm('PREP'), true)
})

test("lines inside a PA's own recipe do not count - the PA is already counted", () => {
  assert.equal(placeLine(nodes, 'Broasted Meal > Garlic Sauce portion'), 'PA')
  assert.equal(placeLine(nodes, 'Broasted Meal > Coleslaw Portion > Marinated Kebab'), 'PA')
  assert.equal(countsTowardPm('PA'), false)
})

test('names are compared trimmed, single-spaced and case-blind', () => {
  assert.equal(placeLine(nodes, '  broasted meal >  coleslaw   portion '), 'PREP')
})

test('a lone PA whose recipe is named differently is still that PA', () => {
  const n = indexNodes([{ path: 'Burger', type: 'PA', item: 'Beef Patty 140g (PA)' }])
  assert.equal(placeLine(n, 'Burger > Patty Mix'), 'PA')
})

test('a PREP and a PA of the same name at one node cannot be told apart', () => {
  const n = indexNodes([
    { path: 'Wrap', type: 'PA', item: 'Sauce (PA)' },
    { path: 'Wrap', type: 'PREP', item: 'Sauce' },
  ])
  assert.equal(placeLine(n, 'Wrap > Sauce'), 'AMBIGUOUS')
  assert.equal(countsTowardPm('AMBIGUOUS'), false)
})

test('fold keeps Level 1 and PREP lines, drops lines inside a PA, and sums per article', () => {
  const place = (path) => placeLine(nodes, path)
  const rows = [
    { 'RECIPE TABLE[Item No.]': '0101', 'RECIPE TABLE[Recipe Path]': 'Broasted Meal', '[qty]': 10 },
    { 'RECIPE TABLE[Item No.]': '101', 'RECIPE TABLE[Recipe Path]': 'Broasted Meal > Coleslaw Portion', '[qty]': 5 },
    { 'RECIPE TABLE[Item No.]': '202', 'RECIPE TABLE[Recipe Path]': 'Broasted Meal > Garlic Sauce portion', '[qty]': 7 },
    { 'RECIPE TABLE[Item No.]': '303', 'RECIPE TABLE[Recipe Path]': 'Broasted Meal', '[qty]': 0 },
  ]
  const out = fold(rows, place)
  assert.deepEqual([...out], [['101', 15]])
})
