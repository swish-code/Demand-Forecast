import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEPARTMENT, departmentsForRow, pathsForDepartment, rowBelongs } from './responsibility.js'
import { SOURCE } from './productionSource.js'

/*
 * The departmental responsibility rule, and the two mistakes it exists to stop.
 *
 * Measured over 2026-05-01..2026-10-31 before any of this was written:
 *
 *   pinning on Prod_Source alone put SPONGE PAD, SUGAR DARK BROWN, YIEST DRY
 *   SAF-INSTANT and HP 106A CARTRIDGE on the Bakery and Production pages,
 *   because those sites had ISSUED them. None is made at either site.
 *
 *   pinning on "transferred from" alone classified an article from a
 *   brand-to-brand transfer, which is no department's responsibility at all.
 *
 * Both are tested here by name, because both read as plausible until you look.
 */

const whOf = (...articles) => new Set(articles)
const srcOf = (pairs) => new Map(Object.entries(pairs))
const buyOf = (pairs) =>
  new Map(Object.entries(pairs).map(([a, list]) => [a, new Set(list)]))

test('a PREP step belongs to both making departments and never to Others', () => {
  const got = departmentsForRow({ article: '', nodeType: 'PREP' })
  assert.ok(got.has(DEPARTMENT.CK), 'prep work happens in the kitchen')
  assert.ok(got.has(DEPARTMENT.BAKERY), 'and in the bakery')
  assert.ok(!got.has(DEPARTMENT.OTHERS), 'a prep step is never nobody’s work')
  // It carries no article number in any model, so it must not need one.
  assert.equal(got.size, 2)
})

test('a RAW article a site merely ISSUED is not that site’s responsibility', () => {
  // SPONGE PAD: the bakery handed it on. The bakery does not make sponge pads.
  const got = departmentsForRow({
    article: '101500034',
    nodeType: 'RAW',
    whSupplied: whOf('101500034'),
    prodSource: srcOf({ 101500034: SOURCE.BAKERY }),
    purchases: buyOf({}),
  })
  assert.ok(!got.has(DEPARTMENT.BAKERY), 'passing stock on is not producing it')
  assert.ok(got.has(DEPARTMENT.WAREHOUSE), 'the warehouse that supplies it owns it')
})

test('a PA article made at a site IS that site’s responsibility', () => {
  const got = departmentsForRow({
    article: '106400748',
    nodeType: 'PA',
    whSupplied: whOf(),
    prodSource: srcOf({ 106400748: SOURCE.CK }),
    purchases: buyOf({}),
  })
  assert.deepEqual([...got], [DEPARTMENT.CK])
})

test('a department that BUYS an article direct owns it, whatever its node type', () => {
  // TOMATO FRESH: the kitchen orders it in itself, so the kitchen plans it.
  const got = departmentsForRow({
    article: '103000122',
    nodeType: 'RAW',
    whSupplied: whOf(),
    prodSource: srcOf({}),
    purchases: buyOf({ 103000122: ['CKU/CPU'] }),
  })
  assert.deepEqual([...got], [DEPARTMENT.CK])
})

test('a supplier delivering straight to a brand is the warehouse’s to buy', () => {
  const got = departmentsForRow({
    article: '104100006',
    nodeType: 'RAW',
    whSupplied: whOf(),
    prodSource: srcOf({}),
    purchases: buyOf({ 104100006: ['BBT'] }),
  })
  assert.deepEqual([...got], [DEPARTMENT.WAREHOUSE])
})

test('a brand-to-brand transfer creates no responsibility anywhere', () => {
  /*
   * Nothing is passed for it: no warehouse supply, no production source, no
   * purchase. A brand lending stock to another brand is the only evidence, and
   * it must not reach a department page. This is requirement 3, and the reason
   * the earlier "transferred from" reading was rejected - it classified 79 RAW
   * ingredients off brand-to-brand movements alone.
   */
  const got = departmentsForRow({
    article: '103000099',
    nodeType: 'RAW',
    whSupplied: whOf(),
    prodSource: srcOf({}),
    purchases: buyOf({}),
  })
  assert.deepEqual([...got], [DEPARTMENT.OTHERS])
})

test('one article can be two departments’ business at once', () => {
  // BBT WET BATTER: made at the bakery, supplied by the warehouse. Both are
  // true and both departments have work to do, so both pages show it.
  const got = departmentsForRow({
    article: '106400059',
    nodeType: 'PA',
    whSupplied: whOf('106400059'),
    prodSource: srcOf({ 106400059: SOURCE.BAKERY }),
    purchases: buyOf({}),
  })
  assert.ok(got.has(DEPARTMENT.WAREHOUSE))
  assert.ok(got.has(DEPARTMENT.BAKERY))
  assert.ok(!got.has(DEPARTMENT.OTHERS), 'an owned article is never also unowned')
})

test('Others is only ever reached when nothing else claims the row', () => {
  const owned = departmentsForRow({
    article: 'X',
    nodeType: 'PA',
    whSupplied: whOf('X'),
    prodSource: srcOf({ X: SOURCE.CK }),
    purchases: buyOf({ X: ['SWISH BAKERY'] }),
  })
  assert.ok(!owned.has(DEPARTMENT.OTHERS))
  assert.equal(owned.size, 3, 'all three can be true of one article')
})

test('an empty permitted set denies, it does not wave everything through', () => {
  // The security-critical direction: an account whose grant resolves to nothing
  // must see nothing, not everything.
  assert.equal(rowBelongs(new Set([DEPARTMENT.CK]), new Set()), false)
  assert.equal(rowBelongs(new Set([DEPARTMENT.CK]), null), true, 'no pin means no filter')
  assert.equal(rowBelongs(new Set([DEPARTMENT.CK]), new Set([DEPARTMENT.CK])), true)
  assert.equal(rowBelongs(new Set([DEPARTMENT.CK]), new Set([DEPARTMENT.BAKERY])), false)
})

/* ---------- the Path column, narrowed to the page's own department ---------- */

/*
 * Reported from the live Stock Article page on 18 Nov 2026: the column printed
 * `SS → SS-PLC`, `PAT → BUR` and `CKU/CPU → MM` on a warehouse page. Every one
 * of those rows belongs there - the warehouse supplies the article - but the
 * column was answering a different question, and read as a leaking filter.
 */

test('a leg the department was at either end of is kept', () => {
  assert.deepEqual(
    pathsForDepartment(['Central Warehouse → CKU/CPU'], DEPARTMENT.WAREHOUSE),
    ['Central Warehouse → CKU/CPU']
  )
  // Stock arriving INTO the warehouse is the warehouse's business to see.
  assert.deepEqual(
    pathsForDepartment(['SWISH BAKERY → Central Warehouse'], DEPARTMENT.WAREHOUSE),
    ['SWISH BAKERY → Central Warehouse']
  )
})

test('another department’s legs are replaced by a line, not by a blank', () => {
  // The exact cells from the report. The row stays; the column stops claiming.
  for (const leg of ['SS → SS-PLC', 'PAT → BUR', 'CKU/CPU → MM', 'YP-DFC → YP']) {
    assert.deepEqual(
      pathsForDepartment([leg], DEPARTMENT.WAREHOUSE),
      ['No Central Warehouse movement in this window'],
      `${leg} is not the warehouse's leg`
    )
  }
})

test('the brand note survives narrowing, because it is about the brand', () => {
  assert.deepEqual(
    pathsForDepartment(['SS → SS-PLC', 'Not transferred to SS'], DEPARTMENT.WAREHOUSE),
    ['No Central Warehouse movement in this window', 'Not transferred to SS']
  )
  assert.deepEqual(
    pathsForDepartment(['SWISH BAKERY → Central Warehouse', 'Not transferred to BBT'], DEPARTMENT.WAREHOUSE),
    ['SWISH BAKERY → Central Warehouse', 'Not transferred to BBT']
  )
})

test('a mixed cell keeps its own leg and drops the other', () => {
  assert.deepEqual(
    pathsForDepartment(['CKU/CPU → BBT', 'Central Warehouse → CKU/CPU'], DEPARTMENT.WAREHOUSE),
    ['Central Warehouse → CKU/CPU']
  )
  // The same cell read from the kitchen's page keeps both: it is at an end of each.
  assert.deepEqual(
    pathsForDepartment(['CKU/CPU → BBT', 'Central Warehouse → CKU/CPU'], DEPARTMENT.CK),
    ['CKU/CPU → BBT', 'Central Warehouse → CKU/CPU']
  )
})

test('an article that did not move is left alone, not told it has no leg', () => {
  // Nothing moved, so there is nothing to narrow and no finding to report.
  assert.deepEqual(pathsForDepartment([], DEPARTMENT.WAREHOUSE), [])
  assert.deepEqual(pathsForDepartment(null, DEPARTMENT.WAREHOUSE), [])
  assert.deepEqual(
    pathsForDepartment(['Not transferred to SS'], DEPARTMENT.WAREHOUSE),
    ['Not transferred to SS']
  )
})

test('Others narrows nothing, because it is the absence of a department', () => {
  const paths = ['SS → SS-PLC', 'CKU/CPU → MM']
  assert.deepEqual(pathsForDepartment(paths, DEPARTMENT.OTHERS), paths)
})

test('narrowing the column removes no row from the page', () => {
  /*
   * The security-and-honesty direction. `pathsForDepartment` is called on rows
   * that have ALREADY passed `rowBelongs`, and it returns a cell, never a
   * verdict - so there is no input for which it can empty the list it was
   * given without putting a line in its place.
   */
  for (const paths of [['SS → SS-PLC'], ['CKU/CPU → MM', 'Not transferred to BBT']]) {
    assert.ok(pathsForDepartment(paths, DEPARTMENT.WAREHOUSE).length > 0)
  }
})

test('the Path narrowing runs only where ONE department is pinned', () => {
  const code = strip(api)
  assert.ok(
    /const only = wanted\.size === 1/.test(code),
    'with two departments pinned there is no single site whose legs to show'
  )
  assert.ok(code.includes('pathsForDepartment('), 'the server must apply it')
})

/* ---------- the six defects found in review, each pinned by a test ---------- */

test('a single failed lookup does not empty the page', () => {
  /*
   * The guard tested ALL THREE lookups with &&, so one failure was not a
   * failure. With the warehouse supply set unavailable, nothing could be the
   * warehouse's, every row fell to Others, and Stock Article rendered empty
   * with no error - which reads as "there is no data".
   */
  const code = strip(api)
  assert.ok(
    !/if \(!whSupplied && !prodSource && !purchases\)/.test(code),
    'the all-three guard must be gone'
  )
  assert.ok(/const missing = \[/.test(code), 'each missing lookup must be named')
  assert.ok(
    /if \(!permitted\) \{[\s\S]{0,200}return rows/.test(code),
    'a page pin with a degraded lookup must show rows rather than nothing'
  )
})

test('a failed purchase read is never cached as "nobody buys direct"', () => {
  /*
   * It caught its own error and returned null, which became an empty Map -
   * a successful answer as far as `cached` is concerned, so the emptiness was
   * stored for the whole window. Every article a site buys direct moved to
   * Others for a month.
   */
  const src = strip(readFileSync(new URL('./responsibility.js', import.meta.url), 'utf8'))
  const body = src.slice(src.indexOf('export async function purchasesByArticle'))
  assert.ok(
    !/purchases unavailable/.test(body),
    'the read must throw rather than resolve to an empty map'
  )
})

test('the status ladder reads the departmental pin as well as the source pin', () => {
  // Production and Swish Bakery stopped sending `prodSources` on 18 Nov, and
  // silently fell back to the warehouse ladder - "Never shipped" on every PA
  // article the warehouse does not handle.
  const code = strip(api)
  assert.ok(/SOURCE_FOR_DEPARTMENT/.test(code), 'the bridge between the two pins must exist')
  assert.ok(
    /filters\?\.responsibility \?\? \[\]\)[\s\S]{0,120}SOURCE_FOR_DEPARTMENT/.test(code),
    'withStatus must consult the responsibility pin'
  )
})

test('a mixed grant is not narrowed to the Factory alone', () => {
  /*
   * `src-ck` and `src-bakery` left SOURCE_BY_PAGE and `allowedProdSources`
   * was not updated with them, so a grant of src-ck + src-factory resolved to
   * YELO Factory only and `withProductionSource` emptied Production before
   * the departmental filter ran.
   */
  const code = strip(api)
  const fn = code.slice(code.indexOf('function allowedProdSources'), code.indexOf('async function withProductionSource'))
  assert.ok(
    /RESPONSIBILITY_BY_PAGE\[p\]/.test(fn),
    'a grant holding a department page must not be narrowed by production source'
  )
})

test('the site-page pre-fan pass still runs for the department pages', () => {
  // `sourcesAsked` went null when those pages stopped sending `prodSources`,
  // which switched off the 29-30 Sep dormant-article fix.
  const code = strip(api)
  assert.ok(
    /const pinnedSources = \(g\.parts\[0\]\?\.f\?\.responsibility \?\? \[\]\)/.test(code),
    'the departmental pin must count as asking for its site'
  )
})

test('the Responsibility stamp has a column to appear in', () => {
  // It was written onto every row and rendered nowhere, so it reached neither
  // the table nor the CSV.
  const page = readFileSync(
    new URL('../../client/src/pages/ComponentLevel.jsx', import.meta.url),
    'utf8'
  )
  assert.ok(/key: 'Responsibility'/.test(page), 'the column must exist')
})

/* ---------- structural: the pins, and the one that had to be removed ---------- */

const api = readFileSync(new URL('../routes/api.js', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../client/src/pages/../App.jsx', import.meta.url), 'utf8')
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the server pins each page itself rather than trusting the request', () => {
  const code = strip(api)
  for (const [page, dept] of [
    ['component', 'WAREHOUSE'],
    ['src-ck', 'CK'],
    ['src-bakery', 'BAKERY'],
    ['src-others', 'OTHERS'],
  ]) {
    assert.ok(
      new RegExp(`'?${page}'?:\\s*DEPARTMENT\\.${dept}`).test(code),
      `${page} must be pinned to DEPARTMENT.${dept} on the server`
    )
  }
})

test('Production and Swish Bakery no longer carry a production-source pin', () => {
  /*
   * Both mechanisms filter, and `withProductionSource` runs FIRST. Leaving the
   * old pin on would have dropped every row the new rule admits on other
   * evidence - the articles the kitchen buys resolve to `Unclassified` - and
   * the page would have looked unchanged for a reason nobody could see.
   */
  const code = strip(api)
  const map = code.slice(code.indexOf('const SOURCE_BY_PAGE'), code.indexOf('function allowedProdSources'))
  assert.ok(!map.includes("'src-ck'"), 'src-ck must not be pinned by production source')
  assert.ok(!map.includes("'src-bakery'"), 'src-bakery must not be pinned by production source')
  assert.ok(map.includes("'src-factory'"), 'the YELO Factory page is deliberately unchanged')
  assert.ok(map.includes("'src-none'"), 'the Unclassified page is deliberately unchanged')
})

test('the client sets the departmental pin AND clears it', () => {
  // A pin that is never cleared survives onto pages that have none - the bug
  // fixed for `prodSources` on 1 Nov 2026, not to be reintroduced here.
  assert.ok(/base\.responsibility = \[page\.lockResponsibility\]/.test(app))
  assert.ok(/else delete base\.responsibility/.test(app))
})

/** One page's config block, from its id to the start of the next page's. */
function pageBlock(code, id) {
  const at = code.indexOf(`id: '${id}'`)
  assert.ok(at > 0, `expected a page with id ${id}`)
  const next = code.indexOf('id: ', at + 10)
  return code.slice(at, next > at ? next : undefined)
}

test('the node-type locks are gone from the three department pages', () => {
  const code = strip(app)
  for (const id of ['component', 'src-ck', 'src-bakery', 'src-others']) {
    assert.ok(
      !/lockNodeTypes/.test(pageBlock(code, id)),
      `${id} must not lock the node type - the department pin decides its population`
    )
  }
  /*
   * Procurement KEEPS its RAW lock, deliberately. It is the ordering view of
   * the bought half and was not in scope; changing it would have altered a page
   * nobody asked about.
   */
  assert.ok(/lockNodeTypes/.test(pageBlock(code, 'procurement')), 'Procurement is left alone')
})

test('each department page pins exactly one department, and the Factory none', () => {
  const code = strip(app)
  for (const [id, dept] of [
    ['component', 'Central Warehouse'],
    ['src-ck', 'Central Kitchen / CPU'],
    ['src-bakery', 'Swish Bakery'],
    ['src-others', 'Others'],
  ]) {
    const block = pageBlock(code, id)
    assert.ok(
      block.includes(`lockResponsibility: '${dept}'`),
      `${id} must pin ${dept}`
    )
    assert.ok(!block.includes('lockProdSource'), `${id} must not also pin a production source`)
  }
  // Requirement 5: the YELO Factory keeps working exactly as it did.
  const factory = pageBlock(code, 'src-factory')
  assert.ok(factory.includes("lockProdSource: 'YELO Factory'"), 'the Factory keeps its own pin')
  assert.ok(!factory.includes('lockResponsibility'), 'and is not migrated')
})

test('the departmental filter is applied in the component-level pipeline', () => {
  const code = strip(api)
  const calls = code.split('await withResponsibility(').length - 1
  assert.equal(calls, 2, 'both the single-brand and merged branches must filter')
  assert.ok(
    code.includes('await withResponsibility(await withProductionSource('),
    'it must run after Prod_Source is stamped, so the column survives'
  )
})

test('Others is grantable, so its rows can be restricted server-side', () => {
  const departments = readFileSync(new URL('../departments.js', import.meta.url), 'utf8')
  assert.ok(strip(departments).includes("'src-others'"), 'a page absent from PAGE_IDS cannot be granted')
})
