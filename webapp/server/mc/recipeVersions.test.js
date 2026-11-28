import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  diffVersions,
  recipeStart,
  inForce,
  stateKnownAt,
  defaultPostingTime,
  postingTime,
  postingUpdates,
  canonLines,
  dropZeroPaths,
  uncertainIn,
  unloggedWindows,
  kuwaitNow,
} from './recipeVersions.js'
import { costDays, provenDays, brandScope } from '../insights/datedPm.js'

test('a changed recipe closes its old version and opens a new one; an unchanged one is left alone', () => {
  const open = new Map([
    ['10', { hash: 'a' }],
    ['11', { hash: 'b' }],
    ['12', { hash: 'c' }],
  ])
  const now = new Map([
    ['10', { hash: 'a', body: [] }],
    ['11', { hash: 'B', body: [['1', 2]] }],
    ['13', { hash: 'd', body: [] }],
  ])
  const d = diffVersions(open, now, () => '2026-11-23 10:00:00')
  assert.deepEqual(d.close.map((c) => c.key).sort(), ['11', '12'], 'changed and vanished are closed, never deleted')
  assert.deepEqual(d.insert.map((c) => c.key).sort(), ['11', '13'])
})

test("a version starts at MC's own save time for the recipe or any sub-recipe in it", () => {
  const tree = new Map([['100', new Set(['100', '200'])]])
  const saves = new Map([['200', ['2026-11-23 09:41:00', '2026-11-23 10:15:00']]])
  const at = '2026-11-23 10:20:00'
  assert.equal(recipeStart({ rez: '100', tree, saves, since: '2026-11-23 10:00:00', at }), '2026-11-23 10:15:00')
  assert.equal(recipeStart({ rez: '100', tree, saves, since: '2026-11-23 10:16:00', at }), at, 'no save in the interval: the capture time')
})

test('the version in force at a moment: valid_from <= t < valid_to', () => {
  const rows = [
    { key: '1', valid_from: '2026-11-26 13:00:00', valid_to: '2026-11-28 10:00:00', v: 'old' },
    { key: '1', valid_from: '2026-11-28 10:00:00', valid_to: null, v: 'new' },
  ]
  assert.equal(inForce(rows, '2026-11-27 06:00:00').get('1').v, 'old')
  assert.equal(inForce(rows, '2026-11-28 10:00:00').get('1').v, 'new')
  assert.equal(inForce(rows, '2026-11-26 06:00:00').has('1'), false, 'before the first capture nothing is known')
})

test('MC posts day d at 06:00 the next morning; a re-posted day uses the re-post time', () => {
  assert.equal(defaultPostingTime('2026-11-30'), '2026-12-01 06:00:00')
  const reposted = new Map([['MM|2026-11-20', '2026-11-29 09:00:00']])
  assert.equal(postingTime(reposted, 'MM', '2026-11-20'), '2026-11-29 09:00:00')
  assert.equal(postingTime(reposted, 'TBL', '2026-11-20'), '2026-11-21 06:00:00')
})

test('the state at a moment is proven only by probes that bracket it closely or agree', () => {
  const probes = [
    { at: '2026-11-27 05:40:00', ok: true, sig: 'x' },
    { at: '2026-11-27 05:50:00', ok: true, sig: 'y' },
    { at: '2026-11-27 06:10:00', ok: true, sig: 'y' },
    { at: '2026-11-28 01:00:00', ok: true, sig: 'z' },
    { at: '2026-11-28 09:00:00', ok: true, sig: 'z' },
  ]
  assert.equal(stateKnownAt(probes, '2026-11-27 06:00:00'), true, 'same signature either side')
  assert.equal(stateKnownAt(probes, '2026-11-27 12:00:00'), false, 'a change somewhere in a 15-hour gap')
  assert.equal(stateKnownAt(probes, '2026-11-28 06:00:00'), true, 'a long gap with nothing changed is still proven')
  assert.equal(stateKnownAt(probes, '2026-11-26 06:00:00'), false, 'before the first probe')
  assert.equal(stateKnownAt([{ at: '2026-11-27 05:00:00', ok: false }, ...probes.slice(2)], '2026-11-27 05:30:00'), false, 'failed probes prove nothing')
})

test('a posted day whose MC total later moves is marked re-posted; a stable one is not', () => {
  const existing = new Map([
    ['MM|2026-11-20', { sold: 1000, first_seen: '2026-11-21 09:00:00', reposted: null }],
    ['MM|2026-11-21', { sold: 1000, first_seen: '2026-11-22 09:00:00', reposted: null }],
  ])
  const totals = new Map([
    ['MM|2026-11-20', 2000],
    ['MM|2026-11-21', 1000.5],
    ['MM|2026-11-22', 900],
  ])
  const ups = new Map(postingUpdates(existing, totals, '2026-11-29 09:00:00').map((u) => [u.day, u]))
  assert.equal(ups.get('2026-11-20').reposted, '2026-11-29 09:00:00')
  assert.equal(ups.get('2026-11-21').reposted, null)
  assert.equal(ups.get('2026-11-22').isNew, true)
})

test('recipe lines are written one way, so the same recipe always has the same version', () => {
  assert.deepEqual(canonLines(new Map([['b', 0.1 + 0.2], ['a', 1], ['z', 0]])), [['a', 1], ['b', 0.3]])
})

test('kuwait wall clock is UTC+3', () => {
  assert.equal(kuwaitNow(Date.parse('2026-11-26T22:30:00Z')), '2026-11-27 01:30:00')
})

test('each day is costed with the product and recipe in force at its own posting time', () => {
  const versions = {
    products: [{ key: '7', valid_from: '2026-11-26 00:00:00', valid_to: null, kst_id: '232', plu: '40002175', rez_id: '9', art: null, qty: null }],
    recipes: [
      { key: '9', valid_from: '2026-11-26 00:00:00', valid_to: '2026-11-28 10:00:00', lines: new Map([['cup', 1], ['sticker', 1]]) },
      { key: '9', valid_from: '2026-11-28 10:00:00', valid_to: null, lines: new Map([['cup', 1]]) },
    ],
  }
  const days = new Map([
    ['2026-11-26', '2026-11-27 06:00:00'],
    ['2026-11-28', '2026-11-29 06:00:00'],
  ])
  const sales = [
    { day: '2026-11-26', plu: '40002175', branch: 'MNF', q: 10 },
    { day: '2026-11-28', plu: '40002175', branch: 'MNF', q: 5 },
    { day: '2026-11-28', plu: '999', branch: 'MNF', q: 3 },
    { day: '2026-11-27', plu: '40002175', branch: 'MNF', q: 100 }, // not a proven day: ignored here
  ]
  const out = costDays({ sales, days, versions, kstsOf: () => ['232'], brandKsts: new Set(['232']) })
  assert.equal(out.get('cup'), 15)
  assert.equal(out.get('sticker'), 10, 'the sticker only on the day posted before the edit')
  assert.equal(out.stats.noProduct, 3)
  assert.equal(out.stats.units, 18)
})

test('only posted days with a proven recipe state are costed from captured versions', () => {
  const probes = [
    { at: '2026-11-26 13:00:00', ok: true, sig: 's' },
    { at: '2026-11-27 07:00:00', ok: true, sig: 's' },
  ]
  const days = provenDays({ brand: 'MM', from: '2026-11-25', to: '2026-11-27', probes, reposted: new Map(), now: '2026-11-27 08:00:00' })
  assert.deepEqual(days.map((d) => d.day), ['2026-11-26'], '25th posted before capture began; 27th not posted yet')
})

test('rows under a sub-recipe line with 0 base units are dropped, as MC posts them; others are kept', () => {
  const rows = [
    { rez: '13808', sub: '3250', art: 'sleeve', qty: 1 }, // only via the zero line
    { rez: '13808', sub: '13808', art: 'box', qty: 1 }, // the recipe's own line
    { rez: '4796', sub: '3250', art: 'sleeve', qty: 1 }, // 3250 reached normally from 4796
    { rez: '9000', sub: '3250', art: 'sleeve', qty: 1 }, // reached through a zero line AND a normal one
    { rez: '9100', sub: '7777', art: 'x', qty: 1 }, // linked some other way: never dropped
  ]
  const edges = [
    { parent: '13808', child: '3250', ge: 0 },
    { parent: '4796', child: '3250', ge: 1 },
    { parent: '9000', child: '3250', ge: 0 },
    { parent: '9000', child: '5000', ge: 1 },
    { parent: '5000', child: '3250', ge: 1 },
  ]
  const { rows: out, dropped } = dropZeroPaths(rows, edges)
  assert.equal(dropped, 1)
  assert.deepEqual(out.map((r) => `${r.rez}|${r.art}`), ['13808|box', '4796|sleeve', '9000|sleeve', '9100|x'])
})

test('an overnight gap is proven when nothing changed, or every change carries MC\'s own time', () => {
  const probes = [
    { at: '2026-11-27 19:42:00', ok: true, sig: 'a' },
    { at: '2026-11-28 13:40:00', ok: true, sig: 'b', changed: 0 },
  ]
  assert.equal(stateKnownAt(probes, '2026-11-28 06:00:00'), true, 'signature moved, content did not')
  const changed = [probes[0], { ...probes[1], changed: 3 }]
  const store = (from, captured) => ({ recipes: [{ valid_from: from, captured }], products: [] })
  const logged = store('2026-11-28 09:15:00', '2026-11-28 13:40:00')
  const unlogged = store('2026-11-28 13:40:00', '2026-11-28 13:40:00')
  assert.equal(stateKnownAt(changed, '2026-11-28 06:00:00', { uncertainBetween: (a, b) => uncertainIn(logged, a, b) }), true)
  assert.equal(stateKnownAt(changed, '2026-11-28 06:00:00', { uncertainBetween: (a, b) => uncertainIn(unlogged, a, b) }), false)
  assert.equal(stateKnownAt(changed, '2026-11-28 06:00:00'), false, 'without the version check, a changed gap proves nothing')
})

test('an unlogged change is unsure from the previous full read to its capture, and only for its own brand', () => {
  const probes = [
    { at: '2026-11-26 17:16:00', ok: true, kind: 'start', changed: 0 },
    { at: '2026-11-27 16:26:00', ok: true, kind: 'probe', changed: 0, full: false },
    { at: '2026-11-27 16:38:53', ok: true, kind: 'start', changed: 32, full: true },
  ]
  const recipes = [
    { key: '16731', valid_from: '2026-11-27 16:38:53', captured: '2026-11-27 16:38:53' }, // unlogged: TBL bun swap
    { key: '4796', valid_from: '2026-11-27 10:05:00', captured: '2026-11-27 16:38:53' }, // dated by MC's save log
  ]
  const w = unloggedWindows({ recipes, products: [], probes })
  assert.deepEqual(w, [{ kind: 'recipe', key: '16731', from: '2026-11-26 17:16:00', to: '2026-11-27 16:38:53' }])
  const store = {
    products: [
      { key: '1', kst_id: '300', rez_id: '16731' }, // a TBL outlet
      { key: '2', kst_id: '41', rez_id: '4796' }, // an SS outlet
    ],
  }
  const tbl = brandScope(store, new Set(['300']))
  const ss = brandScope(store, new Set(['41']))
  assert.equal(tbl.has('recipe', '16731'), true)
  assert.equal(ss.has('recipe', '16731'), false, "TBL's unlogged edit does not make SS's 26 Nov unsure")
  const t = '2026-11-27 06:00:00'
  const unsureFor = (scope) => w.some((x) => scope.has(x.kind, x.key) && x.from < t && t <= x.to)
  assert.equal(unsureFor(tbl), true)
  assert.equal(unsureFor(ss), false)
})
