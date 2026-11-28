import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accuracy, rebuild, classify, foldMonth, cleanMonths, kstKey } from './theoreticalDrivers.js'

const M = (o) => new Map(Object.entries(o))

test('accuracy is 1 - sum|x - mc| / sum mc, over both sides', () => {
  // |90-100| + |0-50| + |20-0| = 80 over 150
  assert.equal(accuracy(M({ a: 100, b: 50 }), M({ a: 90, c: 20 })).toFixed(4), (1 - 80 / 150).toFixed(4))
  assert.equal(accuracy(new Map(), M({ a: 1 })), null)
})

test('accuracy can leave articles out of the other side (water)', () => {
  // MC books no water; PM does. Dropped, the water article is zero on both sides.
  const mc = M({ a: 100 })
  const pm = M({ a: 100, 104800018: 40 })
  assert.equal(accuracy(mc, pm), 0.6)
  assert.equal(accuracy(mc, pm, { drop: new Set(['104800018']) }), 1)
})

test('rebuild multiplies sales through each product recipe and keeps the PLUs', () => {
  const recipes = new Map([
    ['1', { name: 'Burger', per: M({ bun: 1, beef: 0.14 }) }],
    ['2', { name: 'Water bottle', per: M({ bottle: 1 }) }],
  ])
  const { qty, byPlu } = rebuild(
    [
      { pro: '1', plu: '2001', q: 10 },
      { pro: '1', plu: '2001', q: -2 }, // a refund nets off
      { pro: '2', plu: '3001', q: 5 },
      { pro: '9', plu: '9999', q: 7 }, // no product: nothing
    ],
    recipes
  )
  assert.equal(qty.get('bun'), 8)
  assert.equal(qty.get('beef').toFixed(2), '1.12')
  assert.equal(qty.get('bottle'), 5)
  assert.equal(qty.size, 3)
  assert.equal(byPlu.get('bun').get('2001\u0000Burger'), 8)
})

test('classify: water MC never posts', () => {
  assert.equal(classify({ art: '104800018', mc: 0, pm: 7795, rb: 7000, month: '2026-10-01' }).kind, 'notposted')
})

test('classify: booked by MC, in no current recipe = removed (the straw)', () => {
  const c = classify({ art: '107000007', mc: 136139, pm: 0, rb: 0, month: '2026-10-01' })
  assert.equal(c.kind, 'removed')
})

test('classify: recipe lines changed after the month began = changed, with the date', () => {
  const c = classify({
    art: '106800379',
    mc: 18907,
    pm: 40399,
    rb: 40000,
    month: '2026-10-01',
    dates: { created: '2026-10-17', changed: null },
  })
  assert.deepEqual(c, { kind: 'changed', since: '2026-10-17' })
})

test('classify: a disagreement with no line change is MC booking, not a recipe change', () => {
  const c = classify({
    art: 'x',
    mc: 100,
    pm: 200,
    rb: 200,
    month: '2026-10-01',
    dates: { created: '2025-01-01', changed: '2026-02-01' },
  })
  assert.equal(c.kind, 'booking')
})

test('classify: PM far from MC current recipes = Recipe File / sales', () => {
  // MC's current recipes reproduce MC's booking; PM does not.
  assert.equal(classify({ art: 'x', mc: 100, pm: 160, rb: 101, month: '2026-10-01' }).kind, 'file')
})

test('foldMonth: accuracies, gap by cause, and the article list', () => {
  const out = foldMonth({
    month: '2026-10-01',
    actual: M({ straw: 100, bun: 1000, stick: 50 }),
    names: M({ straw: 'Straw', bun: 'Bun', stick: 'Sticker' }),
    rb: M({ bun: 1000, stick: 120, 104800018: 30 }),
    rbByPlu: new Map([['stick', new Map([['2001\u0000Burger', 120]])]]),
    pm: M({ bun: 1100, stick: 120, 104800018: 30 }),
    dates: M({ stick: { lines: 3, created: '2026-10-17', changed: null } }),
  })
  // MC 1,150. PM gap: straw 100 + bun 100 + stick 70 + water 30 = 300.
  assert.equal(out.mcTotal, 1150)
  assert.equal(out.acc.pm.toFixed(4), (1 - 300 / 1150).toFixed(4))
  // Current recipes: straw 100 + stick 70 + water 30 = 200.
  assert.equal(out.acc.rebuild.toFixed(4), (1 - 200 / 1150).toFixed(4))
  assert.equal(out.acc.rebuildNoWater.toFixed(4), (1 - 170 / 1150).toFixed(4))
  assert.deepEqual(out.gapByCause, { changed: 70, removed: 100, booking: 0, notposted: 30, file: 100 })
  assert.equal(out.gapTotal, 300)
  const stick = out.articles.find((a) => a.article === 'stick')
  assert.equal(stick.kind, 'changed')
  assert.equal(stick.timing, 70)
  assert.equal(stick.file, 0)
  assert.deepEqual(stick.plus, [{ plu: '2001', name: 'Burger', qty: 120 }])
  assert.equal(out.articles.find((a) => a.article === '104800018').name, 'Water for Recipe')
})

test('foldMonth without PM still splits MC against its own recipes', () => {
  const out = foldMonth({
    month: '2026-10-01',
    actual: M({ a: 100 }),
    names: new Map(),
    rb: M({ a: 80 }),
    rbByPlu: new Map(),
    pm: null,
    dates: new Map(),
  })
  assert.equal(out.acc.pm, null)
  assert.equal(out.acc.rebuild, 0.8)
  assert.equal(out.articles[0].pm, null)
  assert.equal(out.articles[0].file, null)
})

test('cleanMonths and kstKey', () => {
  assert.deepEqual(cleanMonths(['2026-11-15', '2026-10', 'bad', '2026-10-01']), ['2026-10-01', '2026-11-01'])
  assert.equal(kstKey('SS - Salmiya (Blk 2)'), 'SSSALMIYABLK2')
})

test('brandSales joins only the brand’s own outlets', async () => {
  const { brandSales } = await import('./theoreticalDrivers.js')
  const byKst = new Map([
    ['41', [{ pro: '1', plu: 'p', q: 3 }]],
    ['51', [{ pro: '3', plu: 'r', q: 1 }]],
    ['99', [{ pro: '2', plu: 'q', q: 9 }]], // another brand's outlet
  ])
  assert.deepEqual(brandSales(['41', '51'], byKst).map((s) => s.pro), ['1', '3'])
  assert.deepEqual(brandSales(['41'], undefined), [])
})

test('spans: closed months together, the open month on its own', async () => {
  const { spans } = await import('./theoreticalDrivers.js')
  const now = new Date().toISOString().slice(0, 7) + '-01'
  assert.deepEqual(spans(['2020-01-01', '2020-02-01', now]), [['2020-01-01', '2020-02-01'], [now]])
  assert.deepEqual(spans(['2020-01-01']), [['2020-01-01']])
})
