import test from 'node:test'
import assert from 'node:assert/strict'

import { coveredByStock as server } from './stockCover.js'
import { coveredByStock as client } from '../../client/src/whAccuracy.js'

/**
 * The two copies of the stock rule must agree.
 *
 * The server cannot import the client's module at runtime - separate package,
 * separate build - so the rule is written twice. This is what stops that being
 * a silent liability: edit one and not the other and this fails.
 *
 * The matrix covers the boundary (exactly 2x), both sides of it, and every
 * guard the rule carries: missing readings, zero, and negative book balances.
 */
const CASES = [
  // [forecast, storeSoh, expected]
  [100, 250, true], // the worked example from the request
  [100, 200, true], // exactly 2x - covered
  [100, 199.99, false], // a hair under
  [100, 100, false], // same as forecast
  [100, 0, false], // nothing on the shelf
  [100, -50, false], // negative book balance, an accounting artefact
  [0, 0, false], // 2 * 0 <= 0 is true, and must NOT read as covered
  [0, 500, false], // nothing forecast
  [-10, 500, false], // negative forecast
  [100, null, false], // no reading at all
  [100, undefined, false],
  [null, 250, false],
  [undefined, 250, false],
  [100, NaN, false],
  [NaN, 250, false],
  ['100', '250', true], // strings, as they arrive from the model
]

test('the server and client stock rules agree', () => {
  for (const [forecast, soh, expected] of CASES) {
    const s = server(forecast, soh)
    const c = client(forecast, soh)
    assert.equal(
      s,
      c,
      `server and client disagree for forecast=${forecast} soh=${soh}: ${s} vs ${c}`
    )
    assert.equal(s, expected, `forecast=${forecast} soh=${soh} should be ${expected}`)
  }
})
