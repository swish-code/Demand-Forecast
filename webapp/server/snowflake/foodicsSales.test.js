import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonPlu, foldSales, salesFromSnowflake, mcPlu, windowEnd } from './foodicsSales.js'
import { isSingleSelect } from './read.js'
import { assemblePm } from '../insights/recipeLevel.js'

test('BBT, Yelo, MM and TBL read their sales from Snowflake', () => {
  assert.equal(salesFromSnowflake('BBT'), true)
  assert.equal(salesFromSnowflake(' yp '), true)
  assert.equal(salesFromSnowflake('MM'), true)
  assert.equal(salesFromSnowflake('tbl'), true)
  for (const b of ['SS', 'PAT', 'CHP', 'SLC', 'BUR', '']) assert.equal(salesFromSnowflake(b), false)
})

test('a PLU is written one way, including 14-digit combo ids', () => {
  assert.equal(canonPlu(' 0102 '), '102')
  assert.equal(canonPlu('83001108300112'), '83001108300112')
  assert.equal(canonPlu('232020220303'), '232020220303')
  assert.equal(canonPlu('ABC-1'), 'ABC-1')
  assert.equal(canonPlu(null), '')
})

test('sales fold per PLU and outlet; a line with no MAPPED_SKU is counted, not lost', () => {
  const { lines, unmapped } = foldSales([
    { LOC: 'adl ', SKU: '922', Q: 2941 }, // PRODUCT line
    { LOC: 'ADL', SKU: '0922', Q: 593 }, // OPTION line, same PLU: MC holds the sum
    { LOC: 'ARD', SKU: '922', Q: 10 },
    { LOC: 'ARD', SKU: null, Q: 7 },
    { LOC: 'ARD', SKU: '5', Q: 0 },
  ])
  const adl = lines.find((l) => l.plu === '922' && l.branch === 'ADL')
  assert.equal(adl.q, 3534)
  assert.equal(lines.length, 2)
  assert.deepEqual(unmapped, { q: 7, rows: 1 })
})

test('Yelo SBH is filed under SBS, the KST MAP code; other brands are untouched', () => {
  assert.equal(foldSales([{ LOC: 'SBH', SKU: '1', Q: 3 }], 'YP').lines[0].branch, 'SBS')
  assert.equal(foldSales([{ LOC: 'SBH', SKU: '1', Q: 3 }], 'BBT').lines[0].branch, 'SBH')
})

test('the read connection refuses anything but one SELECT', () => {
  assert.equal(isSingleSelect('SELECT 1'), true)
  assert.equal(isSingleSelect('  with x as (select 1) select * from x;'), true)
  assert.equal(isSingleSelect("SELECT 'a;b' AS s"), true)
  assert.equal(isSingleSelect('SELECT 1; DROP TABLE t'), false)
  assert.equal(isSingleSelect('GRANT SELECT ON t TO ROLE r'), false)
  assert.equal(isSingleSelect('CREATE TEMPORARY TABLE x (a int)'), false)
  assert.equal(isSingleSelect('USE ROLE SYSADMIN'), false)
})

test('PM = units x QTY BU over the counting lines, matched on the canonical PLU', () => {
  const byPlu = new Map([
    ['8300110', 100], // combo PRODUCT line with a recipe
    ['83001108300112', 40], // combo OPTION line with its own recipe
    ['999', 5], // no recipe: not costed
  ])
  const lines = [
    { plu: '8300110', article: 'bun', item: 'Bun', bu: 'Each', qty: 2 },
    { plu: '83001108300112', article: 'bun', item: 'Bun', bu: 'Each', qty: 1 },
    { plu: '83001108300112', article: 'cheese', item: 'Cheese', bu: 'Kilogram', qty: 0.02 },
  ]
  const out = assemblePm(byPlu, lines)
  assert.equal(out.get('bun'), 240)
  assert.equal(out.get('cheese').toFixed(2), '0.80')
  assert.equal(out.stats.unitsCosted, 140)
  assert.equal(out.stats.plusWithout, 1)
  assert.deepEqual(out.info.get('cheese'), { item: 'Cheese', bu: 'Kilogram' })
})

test('TBL brown-rice options take the PLU MC holds; nothing else moves', () => {
  assert.equal(mcPlu('TBL', '3003', 'OPTION'), '50003003')
  assert.equal(mcPlu('TBL', '4006', 'OPTION'), '50004006')
  assert.equal(mcPlu('TBL', '1648', 'PRODUCT'), '1648', 'short product codes MC holds as they are')
  assert.equal(mcPlu('TBL', '3003', 'PRODUCT'), '3003', 'only option lines')
  assert.equal(mcPlu('TBL', '5000', 'OPTION'), '5000', 'the Brown Rice choice has no MC PLU and is left alone')
  assert.equal(mcPlu('TBL', '40002150', 'OPTION'), '40002150')
  assert.equal(mcPlu('MM', '3003', 'OPTION'), '3003', 'MM is not touched')
})

test('MM and TBL outlets are renamed as the model renames them, and option lines fold into one PLU', () => {
  const out = foldSales(
    [
      { LOC: 'HAW', SKU: '3003', T: 'OPTION', Q: 2 },
      { LOC: 'HAW', SKU: '3003', T: 'OPTION', Q: 3 },
      { LOC: 'HAW', SKU: '40002150', T: 'PRODUCT', Q: 1 },
    ],
    'TBL'
  )
  const byKey = new Map(out.lines.map((l) => [`${l.plu}|${l.branch}`, l.q]))
  assert.equal(byKey.get('50003003|HWL'), 5)
  assert.equal(byKey.get('40002150|HWL'), 1)
  const mm = foldSales([{ LOC: 'QAD', SKU: '3000140', T: 'OPTION', Q: 4 }], 'MM')
  assert.deepEqual(mm.lines, [{ plu: '3000140', branch: 'QDS', q: 4 }])
})

test("a window reaching today stops at yesterday, Kuwait time; a closed one is untouched", () => {
  const now = Date.parse('2026-11-26T08:00:00Z') // 11:00 in Kuwait, 26 Nov
  assert.equal(windowEnd('2026-11-30', now), '2026-11-26', 'November reads through the 25th')
  assert.equal(windowEnd('2026-10-31', now), '2026-11-01')
  assert.equal(windowEnd('2026-11-25', Date.parse('2026-11-25T22:00:00Z')), '2026-11-26', 'after midnight in Kuwait the 25th is complete')
})

test("MM's HOF/CAT outlet is catering, as MC files it", () => {
  const out = foldSales([{ LOC: 'HOF/CAT', SKU: '3000028', T: 'PRODUCT', Q: 5 }], 'MM')
  assert.equal(out.lines[0].branch, 'CAT')
  assert.equal(foldSales([{ LOC: 'HOF/CAT', SKU: '1', T: 'PRODUCT', Q: 1 }], 'TBL').lines[0].branch, 'HOF/CAT', 'TBL untouched')
})

test("BBT's YRD and Yelo's MOD are filed under MC's VIB and DFC", () => {
  assert.equal(foldSales([{ LOC: 'YRD', SKU: '8013', T: 'PRODUCT', Q: 1 }], 'BBT').lines[0].branch, 'VIB')
  assert.equal(foldSales([{ LOC: 'MOD', SKU: '20303', T: 'OPTION', Q: 1 }], 'YP').lines[0].branch, 'DFC')
  assert.equal(foldSales([{ LOC: 'SBH', SKU: '1', T: 'PRODUCT', Q: 1 }], 'YP').lines[0].branch, 'SBS')
})
