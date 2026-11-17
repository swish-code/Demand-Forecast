import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * The warmer's reach, and the cache key it has to land on.
 *
 * Added 17 Nov 2026 with the two lookups that were never warmed. Measured over
 * a month of `perf.log` before the change:
 *
 *   miss:future-demand   1,476 misses   216.5s each
 *   miss:nonRecipe       1,632 misses   194.8s each
 *   cold requests        41% of calls, 85.1% of the endpoint's total time
 *
 * These are structural tests. A behavioural one would need Power BI and a
 * database, and what actually broke here is not arithmetic - it is two pieces
 * of code agreeing on a string. That is exactly what reading the source can
 * check and a mocked run cannot.
 */

const warm = readFileSync(new URL('./warm.js', import.meta.url), 'utf8')
const api = readFileSync(new URL('./routes/api.js', import.meta.url), 'utf8')

const slice = (src, from, to) => {
  const at = src.indexOf(from)
  assert.ok(at > 0, `expected to find ${from}`)
  const end = src.indexOf(to, at)
  return src.slice(at, end > at ? end : undefined)
}

test('the warmer warms the non-recipe lookup', () => {
  assert.ok(warm.includes('nonRecipeFor'), 'warmBrand must warm the non-recipe entry')
  assert.ok(
    /import \{[^}]*nonRecipeFor[^}]*\} from '\.\/routes\/api\.js'/.test(warm),
    'it must come from the route, not be rebuilt locally'
  )
})

test('the cache key is built in ONE place, so the two cannot drift', () => {
  // The whole point of the extraction: the warmer must not compose its own
  // key. If it ever does, it will warm an entry no request looks for and the
  // symptom is silent - the cache simply stops helping.
  assert.ok(
    !/nonRecipe:\$\{/.test(warm),
    'warm.js must not compose the nonRecipe cache key itself'
  )
  const occurrences = api.split(':nonRecipe:').length - 1
  assert.equal(occurrences, 1, 'the nonRecipe key must be written exactly once, in api.js')
})

test('nonRecipeFor keeps the guards the route applied', () => {
  const fn = slice(api, 'export async function nonRecipeFor(', '\n}\n')
  for (const guard of ['grain.date', 'grain.location', 'f.items', 'f.recipeGroups', 'allowsRaw(f)']) {
    assert.ok(fn.includes(guard), `nonRecipeFor must still guard on ${guard}`)
  }
  // And it must still exclude only what THIS window's explosion returned.
  assert.ok(fn.includes('covered:'), 'the window-scoped exclusion must be preserved')
  assert.ok(fn.includes('rows.length'), 'the row count must stay part of the key')
})

test('the route calls the shared helper rather than its own copy', () => {
  assert.ok(
    /const extra = await nonRecipeFor\(\{ ds, f, brand, rows, grain \}\)/.test(api),
    'the fan-out must delegate to nonRecipeFor with the request own ds, filters and rows'
  )
})

test('the explosion is fetched once and reused, not queried twice', () => {
  const body = slice(warm, 'async function warmBrand(', '\nexport async function warmOnce')
  assert.equal(
    body.split('data.componentLevel(').length - 1,
    1,
    'componentLevel must be fetched once per brand and the result reused'
  )
  assert.ok(body.includes('componentRows = await data.componentLevel'), 'the rows must be captured')
  assert.ok(
    body.includes('rows: componentRows'),
    'the captured rows must be what the non-recipe warm is keyed on'
  )
})

test('a window the explosion could not answer is skipped, not guessed', () => {
  const body = slice(warm, 'async function warmBrand(', '\nexport async function warmOnce')
  assert.ok(
    /if \(!componentRows\) return null/.test(body),
    'warming from a null would fill a key no request will look for'
  )
})

test('pacing is unchanged - every job still waits GAP_MS', () => {
  const body = slice(warm, 'for (const job of jobs)', '\n}\n')
  assert.ok(body.includes('await sleep(GAP_MS)'), 'the gap between queries must be preserved')
  // And one failure must not stop the brands behind it.
  assert.ok(/catch \{/.test(body), 'a failed job must be swallowed, not thrown')
  assert.ok(body.includes('await job()'), 'each job must be awaited before the next begins')
})

test('every brand is warmed, and one failure does not end the cycle', () => {
  const once = slice(warm, 'export async function warmOnce(', '\n}\n')
  assert.ok(
    /for \(const brand of config\.brands\) await warmBrand\(brand\)/.test(once),
    'all registered brands must be warmed, in sequence'
  )
  assert.ok(once.includes('finally'), 'completion must be recorded whatever happened')
})

test('future-demand is warmed through the fan-out, not brand by brand', () => {
  // `articlesWithAnyFutureDemand` already fans out to every brand in one pass,
  // so warming it per brand would be the duplicate work this change removes.
  // Comments stripped: this file explains the fan-out in prose right beside
  // the job, and a test that reads prose is testing the wrong thing.
  const code = warm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(
    !/articlesWithFutureDemand\s*\(/.test(code),
    'the warmer must not call the per-brand future-demand lookup directly'
  )
  const wh = readFileSync(new URL('./insights/whConstant.js', import.meta.url), 'utf8')
  assert.ok(
    wh.includes('articlesWithAnyFutureDemand'),
    'the constants path must still be what pulls future demand in'
  )
})
