import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldCounts } from './consumptionLive.js'

test('CONSUMPTION = Opening + Transfer In + Transfer Out + Usage + Purchase - Closing, as the Power Query', () => {
  const out = foldCounts(
    [
      // Transfer out and usage are booked negative in MC, so they are added as they stand.
      { M: '2026-10-01', KST_NAME: 'SS Rai', ART_NUMMER: '0102000003', ART_NAME: 'Bun', OPENING: 100, TRIN: 20, TROUT: -5, USG: -3, PURCH: 50, POT: -140 },
    ],
    [{ M: '2026-10-01', KST_NAME: 'SS Rai', ART_NUMMER: '102000003', CLOSING: 30 }]
  )
  const h = out.get('2026-10-01|SS Rai|102000003')
  assert.equal(h.consumption, 100 + 20 - 5 - 3 + 50 - 30)
  assert.equal(h.potential, 140, 'MC books the theoretical negative; it is negated once')
  assert.equal(h.name, 'Bun')
  assert.equal(out.size, 1, 'two spellings of one article number are one record')
})

test('an article counted at closing with no movements still has its consumption', () => {
  const out = foldCounts([], [{ M: '2026-10-01', KST_NAME: 'X', ART_NUMMER: '7', CLOSING: 4 }])
  assert.equal(out.get('2026-10-01|X|7').consumption, -4)
  assert.equal(out.get('2026-10-01|X|7').potential, 0)
})

test('a reversal nets: a positive INP_SALES reduces the theoretical', () => {
  const out = foldCounts(
    [
      { M: '2026-09-01', KST_NAME: 'X', ART_NUMMER: '7', POT: -10 },
      { M: '2026-09-01', KST_NAME: 'X', ART_NUMMER: '007', POT: 2 },
    ],
    []
  )
  assert.equal(out.get('2026-09-01|X|7').potential, 8)
})
