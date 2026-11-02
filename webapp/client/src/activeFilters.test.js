import test from 'node:test'
import assert from 'node:assert/strict'
import { activeChips, activeCount } from './activeFilters.js'

/*
 * The mobile filter summary.
 *
 * The acceptance criterion this answers is "the Filters badge shows the correct
 * active-filter count, and the chips match what is actually selected". That is
 * worth testing rather than eyeballing, because a summary that disagrees with
 * the filters is actively harmful: it tells somebody they have checked when
 * they have not.
 *
 * `slicers` mirrors the real SLICERS table in components/FilterBar.jsx. It is
 * passed in rather than imported because that file is JSX and this runner does
 * not parse JSX - see the header of activeFilters.js.
 */
const SLICERS = [
  { id: 'location', key: 'locations', label: 'Location' },
  { id: 'product', key: 'products', label: 'Product' },
  { id: 'article', key: 'articles', label: 'Product PLU' },
  { id: 'articleName', key: 'articles', label: 'Product PLU' },
  { id: 'item', key: 'items', label: 'Article' },
  { id: 'nodeType', key: 'nodeTypes', label: 'Prod. type' },
  { id: 'category', key: 'categories', label: 'Category' },
  { id: 'supply', key: 'supply', label: 'Supply' },
  { id: 'status', key: 'statuses', label: 'Status' },
]

const BRANDS = [
  { code: 'BBT', label: 'BBT' },
  { code: 'CHP', label: 'Chilli Pepper' },
  { code: 'SS', label: 'Shawarma Shakir' },
]

const ALL = ['BBT', 'CHP', 'SS']
const SHOW = ['location', 'item', 'category', 'supply', 'status', 'date']

const chips = (over = {}) =>
  activeChips({ slicers: SLICERS, brands: BRANDS, selectedBrands: ALL, show: SHOW, filters: {}, ...over })

test('nothing filtered reads zero', () => {
  assert.deepEqual(chips(), [])
  assert.equal(activeCount({ slicers: SLICERS, brands: BRANDS, selectedBrands: ALL, show: SHOW }), 0)
})

test('every brand selected is not a filter', () => {
  /*
   * The default state of the page. Counting it would mean the badge could
   * never read zero, and "Filters . 1" on an unfiltered page is noise.
   */
  assert.deepEqual(chips({ selectedBrands: ALL }), [])
})

test('a narrowed brand selection is a filter', () => {
  assert.deepEqual(chips({ selectedBrands: ['BBT'] }), [{ key: 'brand', text: 'BBT' }])
  assert.deepEqual(chips({ selectedBrands: ['BBT', 'CHP'] }), [{ key: 'brand', text: '2 brands' }])
})

test('a single brand uses its label, not its code', () => {
  assert.equal(chips({ selectedBrands: ['CHP'] })[0].text, 'Chilli Pepper')
})

test('one value shows the value; several show a count', () => {
  assert.equal(chips({ filters: { statuses: ['Active'] } })[0].text, 'Status: Active')
  assert.equal(
    chips({ filters: { statuses: ['Active', 'Idle', 'Stopped'] } })[0].text,
    'Status: 3 selected'
  )
})

test('the badge always equals the number of chips', () => {
  const args = {
    slicers: SLICERS,
    brands: BRANDS,
    selectedBrands: ['BBT'],
    show: SHOW,
    filters: { statuses: ['Active'], categories: ['Food', 'Packaging'], items: ['106400843'] },
  }
  assert.equal(activeCount(args), activeChips(args).length)
  assert.equal(activeCount(args), 4, 'brand + status + category + article')
})

test('a filter the page does not offer produces no chip', () => {
  /*
   * Filter state is shared across pages and persisted. A Category chosen on
   * Stock Article survives onto Production, which has no Category control - so
   * a chip for it would be one the reader cannot clear.
   */
  const set = { filters: { categories: ['Food'] } }
  assert.equal(chips({ ...set, show: ['location', 'date'] }).length, 0)
  assert.equal(chips({ ...set, show: ['category'] }).length, 1)
})

test('the date is never a chip', () => {
  /*
   * It always has a value, so it would make the badge read 1 on an unfiltered
   * page. The bar shows it beside the button instead.
   */
  assert.deepEqual(chips({ filters: { dateFrom: '2026-09-01', dateTo: '2026-09-30' } }), [])
})

test('two slicers over the same field produce one chip', () => {
  /*
   * `article` and `articleName` are different controls over `filters.articles`.
   * A page offering both would otherwise show the same selection twice.
   */
  const out = chips({ show: ['article', 'articleName'], filters: { articles: ['8300110'] } })
  assert.equal(out.length, 1)
  assert.equal(out[0].text, 'Product PLU: 8300110')
})

test('empty and malformed values are not filters', () => {
  assert.deepEqual(chips({ filters: { statuses: [] } }), [])
  assert.deepEqual(chips({ filters: { statuses: null } }), [])
  assert.deepEqual(chips({ filters: { statuses: 'Active' } }), [], 'a bare string is not a selection')
})

test('no brands configured cannot crash the bar', () => {
  assert.deepEqual(activeChips({ slicers: SLICERS, show: SHOW }), [])
  assert.deepEqual(activeChips(), [])
})
