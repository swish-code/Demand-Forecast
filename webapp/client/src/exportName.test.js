import test from 'node:test'
import assert from 'node:assert/strict'
import { exportFileName, periodLabel } from './exportName.js'

/**
 * File names for the downloads: the table, then the dates, and nothing else.
 *
 * Worth pinning because the failures are silent — an illegal character makes
 * the browser save something unrecognisable rather than refusing.
 */

test('names the table and the period', () => {
  assert.equal(
    exportFileName('Product Details', { dateFrom: '2026-10-01', dateTo: '2026-10-31' }),
    'Product Details - 2026-10-01 to 2026-10-31.csv'
  )
})

test('the made-in-house pages name their own table', () => {
  assert.equal(
    exportFileName('PA Articles', { dateFrom: '2026-10-01', dateTo: '2026-10-31' }),
    'PA Articles - 2026-10-01 to 2026-10-31.csv'
  )
})

test('one day reads as one day, not a range to itself', () => {
  assert.equal(
    exportFileName('PA Articles', { dateFrom: '2026-10-13', dateTo: '2026-10-13' }),
    'PA Articles - 2026-10-13.csv'
  )
})

test('no dates at all says so rather than going silent', () => {
  assert.equal(exportFileName('PA Articles', {}), 'PA Articles - all dates.csv')
  assert.equal(exportFileName('PA Articles'), 'PA Articles - all dates.csv')
})

test('one open end is still named', () => {
  assert.equal(periodLabel('2026-10-01', ''), '2026-10-01')
  assert.equal(periodLabel('', '2026-10-31'), '2026-10-31')
})

test('a timestamp is cut back to the day', () => {
  assert.equal(
    exportFileName('Product Details', {
      dateFrom: '2026-10-01T00:00:00Z',
      dateTo: '2026-10-31T00:00:00Z',
    }),
    'Product Details - 2026-10-01 to 2026-10-31.csv'
  )
})

test('nothing but the table and the dates is in the name', () => {
  // The rule asked for on 13 Oct 2026: two selections of the same table over
  // the same dates produce the same name.
  const a = exportFileName('Product Details', { dateFrom: '2026-10-01', dateTo: '2026-10-31' })
  const b = exportFileName('Product Details', { dateFrom: '2026-10-01', dateTo: '2026-10-31' })
  assert.equal(a, b)
  assert.doesNotMatch(a, /BBT|selected|brands/)
})

test('the workbook keeps the same name and its own extension', () => {
  assert.equal(
    exportFileName('Replenishment Planning', {
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      ext: 'xlsx',
    }),
    'Replenishment Planning - 2026-10-01 to 2026-10-31.xlsx'
  )
})

test('characters a file name may not carry are removed', () => {
  const name = exportFileName('Stock/Articles: "detail"?', {
    dateFrom: '2026-10-01',
    dateTo: '2026-10-31',
  })
  assert.doesNotMatch(name, /[\\/:*?"<>|]/)
  assert.match(name, /^Stock Articles detail - 2026-10-01 to 2026-10-31\.csv$/)
})

test('it always ends in the extension', () => {
  assert.match(exportFileName('PA Articles', {}), /\.csv$/)
  assert.match(exportFileName('PA Articles', { ext: 'xlsx' }), /\.xlsx$/)
})
