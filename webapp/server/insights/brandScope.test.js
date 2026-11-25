import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { narrowToBrands } from './brandScope.js'

/*
 * The defect, reported 25 Nov 2026: selecting one brand on Stock Article,
 * Production or Swish Bakery listed that brand's articles AND every blank-brand
 * site row AND every FM article.
 */

const NINE = 9
const row = (article, chainid) => ({ 'Item No.': article, ...(chainid === undefined ? {} : { CHAINID: chainid }) })
const ids = (rows) => rows.map((r) => r['Item No.'])

/* ------------------------------------------------- the reported defect - */

test('one brand selected keeps that brand and drops the blanks and FM', () => {
  const rows = [
    row('1', 'BBT'),
    row('2', ''), // __unattributed: the site moved it somewhere that is not a brand
    row('3', 'FM'), // stamped by withFmArticles, after the merge
    row('4', 'MM'), // another brand's row
    row('5', 'BBT'),
  ]
  assert.deepEqual(
    ids(narrowToBrands(rows, { brandCodes: ['BBT'], brandSplit: true, totalBrands: NINE })),
    ['1', '5']
  )
})

test('a missing CHAINID key is treated exactly as a blank one', () => {
  // `siteOnlyRows` omits the field; the fan-out writes '' for some paths. Both
  // mean "no brand", and a filter that told them apart would be a trap.
  const rows = [row('1', 'BBT'), row('2'), row('3', '   ')]
  assert.deepEqual(
    ids(narrowToBrands(rows, { brandCodes: ['BBT'], brandSplit: true, totalBrands: NINE })),
    ['1']
  )
})

test('several brands selected keeps all of them, and still no FM', () => {
  const rows = [row('1', 'BBT'), row('2', 'MM'), row('3', 'SLC'), row('4', 'FM'), row('5', '')]
  assert.deepEqual(
    ids(narrowToBrands(rows, { brandCodes: ['BBT', 'MM'], brandSplit: true, totalBrands: NINE })),
    ['1', '2']
  )
})

test('the brand is matched whatever case either side arrives in', () => {
  const rows = [row('1', 'bbt'), row('2', 'BBT'), row('3', ' Bbt ')]
  assert.deepEqual(
    ids(narrowToBrands(rows, { brandCodes: ['BbT'], brandSplit: true, totalBrands: NINE })),
    ['1', '2', '3']
  )
})

/* ------------------------------------------------- what must NOT change - */

test('every brand asked for narrows nothing at all', () => {
  /*
   * The unattributed and FM rows are real articles these sites handle. The
   * unnarrowed page is where they have always been read, and this change must
   * not remove them from it.
   */
  const all = ['BBT', 'SS', 'MM', 'PAT', 'YP', 'SLC', 'BUR', 'CHP', 'TBL']
  const rows = [row('1', 'BBT'), row('2', ''), row('3', 'FM')]
  const out = narrowToBrands(rows, { brandCodes: all, brandSplit: true, totalBrands: NINE })
  assert.equal(out, rows, 'the same array, so nothing downstream can be confused by a copy')
})

test('a merged view keeps its blank rows, because every row is blank there', () => {
  /*
   * With no brand grain nothing is stamped: a component in two brands is one
   * thing to order. Narrowing on the blank would empty the table.
   */
  const rows = [row('1'), row('2'), row('3', 'FM')]
  assert.deepEqual(
    ids(narrowToBrands(rows, { brandCodes: ['BBT'], brandSplit: false, totalBrands: NINE })),
    ['1', '2'],
    'the blanks stay and FM still goes - FM names a brand, and it is not the one asked for'
  )
})

test('no brands resolved narrows nothing, rather than emptying the page', () => {
  // "We could not tell" must never become "none of these match" - the same
  // direction as the New Article filter's own refusal.
  const rows = [row('1', 'BBT'), row('2', '')]
  assert.equal(narrowToBrands(rows, { brandCodes: [], brandSplit: true, totalBrands: NINE }), rows)
  assert.equal(narrowToBrands(rows, { brandSplit: true, totalBrands: NINE }), rows)
  assert.equal(narrowToBrands(rows, {}), rows)
})

test('an unknown total does not stop the narrowing', () => {
  // totalBrands is only the "everything was asked for" escape hatch. Without
  // it the selection is still a selection.
  const rows = [row('1', 'BBT'), row('2', 'FM')]
  assert.deepEqual(ids(narrowToBrands(rows, { brandCodes: ['BBT'], brandSplit: true })), ['1'])
})

test('empty and absent input are handled without throwing', () => {
  const opts = { brandCodes: ['BBT'], brandSplit: true, totalBrands: NINE }
  assert.deepEqual(narrowToBrands([], opts), [])
  assert.deepEqual(narrowToBrands(null, opts), [])
  assert.deepEqual(narrowToBrands(undefined, opts), [])
})

/* ------------------------------------------------- how it reaches a page - */

test('both component pipelines narrow, and after FM has been stamped', () => {
  /*
   * Order is the whole correctness argument: `withFmArticles` writes FM into
   * the brand cell, so narrowing BEFORE it ran would let every FM article
   * through as a blank. Pinned here because the chain is one long expression
   * and a future edit could reorder it without anything else complaining.
   */
  const api = readFileSync(new URL('../routes/api.js', import.meta.url), 'utf8')
  const code = api.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(
    code.split('narrowToBrands(').length - 1,
    2,
    'both the single-brand and merged pipelines must narrow'
  )
  for (const m of code.matchAll(/narrowToBrands\(await withFmArticles\(/g)) assert.ok(m)
  assert.equal(
    code.split('narrowToBrands(await withFmArticles(').length - 1,
    2,
    'it must wrap withFmArticles, so FM is on the row before the brand is tested'
  )
})
