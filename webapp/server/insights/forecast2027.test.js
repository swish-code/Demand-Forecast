import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pickBaseYear } from './salesPlan.js'
import { planUnitsFor, planMixFor, historyWeightFor } from './planForecast.js'
import { explodeArticles } from './planArticles.js'
import { forecastAnnual } from '../cube/planSource.js'

/*
 * The 2027 pipeline, end to end, at the seams that can be tested without a
 * database or a Power BI token.
 *
 * The chain under test:
 *
 *   'FORECAST (2)'[Totalsale] -> cube_sales_daily (2027 rows)
 *        -> month's sales -> product units -> product mix -> article quantities
 *
 * and, beside it, the baseline that decides WHICH year the mix is read from.
 * Those two came apart on 21 Oct 2026: the sales copy now reaches into 2027
 * while the product tables still stop at the end of 2026, so the baseline can
 * no longer be "the last year with sales in it".
 */

/* ============================== 1. the 2026 baseline ====================== */

/*
 * `pickBaseYear` answers "which year do we read a product mix from". Before the
 * split it was the year of the newest day in `cube_sales_daily`; extending the
 * sales copy into 2027 would have moved it to a year with no product rows at
 * all, and every mix would have been read from nothing.
 */

const year = (y, n) => ({ y: String(y), n })

test('2026 stays the baseline when it is the only complete product year', () => {
  assert.equal(pickBaseYear([year(2026, 12)]), 2026)
})

test('2027 sales rows cannot move the baseline - only product months count', () => {
  // The rows handed in come from cube_article_monthly. The sales copy having
  // 2027 in it is invisible here, which is exactly the property wanted.
  assert.equal(pickBaseYear([year(2025, 2), year(2026, 12)]), 2026)
})

test('a partial 2027 does not take over from a complete 2026', () => {
  for (const months of [1, 2, 3, 4, 5]) {
    assert.equal(
      pickBaseYear([year(2026, 12), year(2027, months)]),
      2026,
      `${months} month(s) of 2027 must not become the baseline`
    )
  }
})

test('2027 does take over once it is substantially complete', () => {
  assert.equal(pickBaseYear([year(2026, 12), year(2027, 6)]), 2027)
  assert.equal(pickBaseYear([year(2026, 12), year(2027, 12)]), 2027)
})

test('the newest qualifying year wins, not the fullest', () => {
  assert.equal(pickBaseYear([year(2026, 12), year(2027, 7)]), 2027)
})

test('no year with enough data yields null, not a guess', () => {
  assert.equal(pickBaseYear([]), null)
  assert.equal(pickBaseYear([year(2026, 3)]), null)
  assert.equal(pickBaseYear(null), null)
})

test('unparseable rows are ignored rather than becoming NaN', () => {
  assert.equal(pickBaseYear([{ y: 'xxxx', n: 12 }, year(2026, 12)]), 2026)
})

/* ========================= 2. 2027 monthly sales ========================== */

/*
 * Two sources can size a 2027 month: the copy's real daily rows, and the
 * model's annual figure spread by the seasonal shape. The copy must win, so
 * that the product forecast and the warehouse forecast are sized by the same
 * series. `salesOverride` is how the copy's figure reaches `planUnitsFor`.
 */

// A basis where every month is sound and the rate is 1 unit per unit of sales,
// so `units` reads straight through and the arithmetic under test is visible.
const flatBasis = (rate = 1) => ({
  ratio: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, rate])),
  brandMedian: rate,
  byMonth: {},
  complete: [],
  latest: new Map(),
  monthsWith: new Map(),
})

test("the copy's monthly figure is used when the caller supplies one", () => {
  const units = planUnitsFor(flatBasis(2), 'BBT', 2027, 3, 500_000)
  assert.equal(units, 1_000_000)
})

test('a zero month from the copy yields no units, and does not fall through', () => {
  // Falling through to the derived figure here would be the silent-fallback
  // bug in miniature: a month the copy says is empty must stay empty.
  assert.equal(planUnitsFor(flatBasis(), 'BBT', 2027, 3, 0), 0)
})

test('no basis yields no units whatever the sales', () => {
  assert.equal(planUnitsFor(null, 'BBT', 2027, 3, 999_999), 0)
})

test('an annual figure is the sum of twelve months, and a part year is refused', () => {
  assert.equal(forecastAnnual(new Array(12).fill(500_000)).value, 6_000_000)
  const short = new Array(12).fill(500_000)
  short[7] = 0
  assert.equal(forecastAnnual(short), null)
})

/* ===================== 3. product and article quantities ================== */

/*
 * The whole chain, composed: a month's sales become product units, the units
 * are split by the mix, and the mix is exploded through the recipe tree into
 * article quantities. The oracle is the arithmetic the business rule states -
 * sales x rate x share x qty-per-unit - computed by hand here.
 */

const mixBasis = () => ({
  ratio: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 0.5])),
  brandMedian: 0.5,
  // March's mix: two products, 3:1.
  byMonth: { 3: new Map([['100', 75], ['200', 25]]) },
  complete: [3],
  latest: new Map([['100', 0.75], ['200', 0.25]]),
  monthsWith: new Map([['100', 1], ['200', 1]]),
})

test('product units split across the mix in the right proportion', () => {
  const basis = mixBasis()
  const units = planUnitsFor(basis, 'BBT', 2027, 3, 1_000_000)
  assert.equal(units, 500_000) // 1,000,000 x 0.5

  const picked = planMixFor(basis, 3)
  assert.ok(picked, 'March must produce a mix')
  // Both halves agree on 3:1, so the blend is 3:1 whatever the history weight.
  assert.equal(Number((picked.mix.get('100') ?? 0).toFixed(10)), 0.75)
  assert.equal(Number((picked.mix.get('200') ?? 0).toFixed(10)), 0.25)

  assert.equal(units * picked.mix.get('100'), 375_000)
  assert.equal(units * picked.mix.get('200'), 125_000)
})

test('article quantities follow product units through the recipe tree', () => {
  const basis = mixBasis()
  const units = planUnitsFor(basis, 'BBT', 2027, 3, 1_000_000)
  const picked = planMixFor(basis, 3)

  const perProduct = new Map()
  for (const [product, share] of picked.mix) perProduct.set(product, units * share)

  const out = explodeArticles(perProduct, [
    { plu: 100, article: 'A', item: 'A', rate: 0.002 },
    { plu: 200, article: 'A', item: 'A', rate: 0.004 },
    { plu: 200, article: 'B', item: 'B', rate: 1 },
  ])

  // A: 375,000 x 0.002 + 125,000 x 0.004 = 750 + 500
  assert.equal(Number(out.get('A').qty.toFixed(6)), 1250)
  // B: 125,000 x 1
  assert.equal(Number(out.get('B').qty.toFixed(6)), 125_000)
})

test('the article total is linear in sales - doubling sales doubles articles', () => {
  // This is the property that lets the component rows be scaled rather than
  // re-exploded, and it is asserted rather than assumed.
  const basis = mixBasis()
  const once = planUnitsFor(basis, 'BBT', 2027, 3, 1_000_000)
  const twice = planUnitsFor(basis, 'BBT', 2027, 3, 2_000_000)
  const picked = planMixFor(basis, 3)
  const qty = (units) =>
    explodeArticles(new Map([...picked.mix].map(([p, s]) => [p, units * s])), [
      { plu: 100, article: 'A', item: 'A', rate: 0.002 },
      { plu: 200, article: 'A', item: 'A', rate: 0.004 },
    ]).get('A').qty
  assert.equal(Number((qty(twice) / qty(once)).toFixed(10)), 2)
})

/* ============================ 4. source failures ========================== */

test('a failed source read produces null, never a zero-valued year', () => {
  assert.equal(forecastAnnual(null), null)
  assert.equal(forecastAnnual([]), null)
  assert.equal(forecastAnnual(new Array(12).fill(0)), null)
})

test('a missing forecast source is raised, not shown as an empty table', () => {
  const src = readFileSync(new URL('./salesPlan.js', import.meta.url), 'utf8')
  assert.ok(
    src.includes('export function forecastSourceError'),
    'there must be an explicit error for a year the model cannot size'
  )
  const q = readFileSync(new URL('../cube/query.js', import.meta.url), 'utf8')
  for (const fn of ['forecastSales', 'productLevel', 'componentLevel']) {
    const at = q.indexOf(`export async function ${fn}(`)
    assert.ok(at > 0, `${fn} must exist`)
    assert.ok(
      q.slice(at, at + 400).includes('guardForecastSource'),
      `${fn} must refuse a forecast year it cannot size`
    )
  }
})

test('the copy is preferred over the derived figure, in both sizing paths', () => {
  const q = readFileSync(new URL('../cube/query.js', import.meta.url), 'utf8')
  const planned = q.slice(q.indexOf('async function plannedSales('))
  assert.ok(
    planned.slice(0, planned.indexOf('\n}\n')).includes('copySales'),
    'plannedSales must consult the sales copy before deriving'
  )
  const mix = q.slice(q.indexOf('async function planMix('))
  assert.ok(
    mix.slice(0, mix.indexOf('\n}\n')).includes('copySales'),
    'planMix must size from the sales copy before deriving'
  )
})

/* ============== 5. independence from manually entered targets ============= */

/*
 * The guarantee the whole exercise exists for. Asserted structurally, because
 * a behavioural test can only show that one particular call did not read a
 * typed target; these rule out the class.
 */

test('the product path never reads the typed monthly values', () => {
  const src = readFileSync(new URL('./planForecast.js', import.meta.url), 'utf8')
  assert.ok(
    !/\bplanMonthlyValues\b/.test(src),
    'planForecast.js must not reference the typed-target accessor at all'
  )
})

test('nothing in the forecast path reads cube_sales_plan', () => {
  for (const f of ['./planForecast.js', './whConstant.js', './siteForecast.js', '../cube/query.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!code.includes('cube_sales_plan'), `${f} must not read the typed sales-plan table`)
  }
})

test('planUnitsFor cannot be reached by a typed target when the copy answers', () => {
  // With an override present the function must not consult the plans map at
  // all - proven by it answering for a brand/year that has no plan whatsoever.
  const units = planUnitsFor(flatBasis(), '__no_such_brand__', 2099, 7, 1234)
  assert.equal(units, 1234)
})

test('historyWeightFor is unaffected by any of this', () => {
  // A guard on the blend the mix uses: the 2027 work changed what a month is
  // WORTH, never how its mix is blended.
  const basis = mixBasis()
  assert.ok(historyWeightFor(basis, '100') > 0)
  assert.ok(historyWeightFor(basis, '100') <= 0.75)
})

/* ================= 6. 2026 and historical actuals untouched =============== */

test('the sales extract widens only the sales window, not the product one', () => {
  const src = readFileSync(new URL('../cube/extract.js', import.meta.url), 'utf8')
  const at = src.indexOf('async function fillWide(')
  const fn = src.slice(at, src.indexOf('\n}\n', at))
  assert.ok(fn.includes('fetchSalesValue(brand, sales)'), 'sales must use the wide sales window')
  assert.ok(fn.includes('fetchArticles(brand, w)'), 'articles must stay on the calendar window')
  assert.ok(
    fn.includes('fetchMasterActual(brand, wide)'),
    'the actual-sales read must stay on the calendar window - 2027 has no actuals'
  )
})

test('the sales window can only widen, never truncate', () => {
  const src = readFileSync(new URL('../cube/extract.js', import.meta.url), 'utf8')
  assert.ok(
    /const salesTo = iso\(Math\.max\(/.test(src),
    'salesTo must be a maximum, so a missing SalesMax leaves the copy alone'
  )
})

test('the baseline is derived from product tables, not from the sales copy', () => {
  const src = readFileSync(new URL('./salesPlan.js', import.meta.url), 'utf8')
  const at = src.indexOf('export async function loadSalesPlans(')
  const head = src.slice(at, at + 1600)
  assert.ok(head.includes('cube_article_monthly'), 'the baseline must look at product coverage')
  assert.ok(
    head.indexOf('cube_article_monthly') < head.indexOf('MAX(date) AS hi'),
    'product coverage must be consulted before the sales copy'
  )
})
