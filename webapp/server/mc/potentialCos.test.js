import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldPotential, mergeRows } from './potentialCos.js'

const map = new Map([
  ['SHAKIRALRAI', { brand: 'SS', branch: 'RAI' }],
  ['MMCATERING', { brand: 'MM', branch: 'CAT' }],
  ['MMARDIYA', { brand: 'MM', branch: 'ARD' }],
])

test('MC stores Potential COS negative; it is negated, and a reversal nets', () => {
  const out = foldPotential(
    [
      { M: '2026-10-01', KST_NAME: 'Shakir Al Rai', ART_NUMMER: '0102000003', ART_NAME: 'Bun', POT: -100 },
      { M: '2026-10-01', KST_NAME: 'Shakir Al-Rai', ART_NUMMER: '102000003', ART_NAME: 'Bun', POT: 4 },
    ],
    map
  )
  assert.equal(out.series.get('102000003|SS').get('2026-10-01'), 96)
  assert.equal(out.byBranch.get('SS|RAI|102000003').get('2026-10-01'), 96)
  assert.equal(out.branchNames.get('SS|RAI'), 'Shakir Al Rai')
  assert.equal(out.names.get('102000003'), 'Bun')
})

test('catering theoretical is left out; unmapped outlets are counted, not placed', () => {
  const out = foldPotential(
    [
      { M: '2026-10-01', KST_NAME: 'MM-Catering', ART_NUMMER: '1', POT: -50 },
      { M: '2026-10-01', KST_NAME: 'MM-Ardiya', ART_NUMMER: '1', POT: -20 },
      { M: '2026-10-01', KST_NAME: 'Staff Meal', ART_NUMMER: '1', POT: -7 },
    ],
    map
  )
  assert.equal(out.series.get('1|MM').get('2026-10-01'), 20)
  assert.equal(out.unplaced.get('2026-10-01'), 7)
  assert.equal(out.series.size, 1)
})

test('months come back sorted, and a row with no figure adds nothing', () => {
  const out = foldPotential(
    [
      { M: '2026-11-01', KST_NAME: 'MM-Ardiya', ART_NUMMER: '1', POT: null },
      { M: '2026-09-01', KST_NAME: 'MM-Ardiya', ART_NUMMER: '1', POT: -3 },
      { M: 'bad', KST_NAME: 'MM-Ardiya', ART_NUMMER: '1', POT: -3 },
    ],
    map
  )
  assert.deepEqual(out.months, ['2026-09-01', '2026-11-01'])
  assert.equal(out.series.get('1|MM').has('2026-11-01'), false)
})

test('the new-article read adds only pairs the counted read did not return', () => {
  const counted = [{ KST_NAME: 'Shakir Al Rai', ART_NUMMER: '0106600102', POT: -100 }]
  const fresh = [
    { KST_NAME: 'Shakir Al-Rai', ART_NUMMER: '106600102', POT: -100 }, // same pair, other spelling
    { KST_NAME: 'Shakir Al Rai', ART_NUMMER: '106600170', POT: -40 },
  ]
  const rows = mergeRows(counted, fresh)
  assert.equal(rows.length, 2)
  const out = foldPotential(rows.map((r) => ({ ...r, M: '2026-11-01' })), map)
  assert.equal(out.series.get('106600102|SS').get('2026-11-01'), 100, 'not counted twice')
  assert.equal(out.series.get('106600170|SS').get('2026-11-01'), 40)
})
