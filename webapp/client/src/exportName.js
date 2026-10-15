/**
 * What a downloaded file is called.
 *
 * One rule, everywhere: the name of the table, then the date range it covers.
 *
 *   Product Details - 2026-10-01 to 2026-10-31.csv
 *
 * A download that cannot be told apart from last week's is a download somebody
 * has to open to identify, and browsers helpfully append "(7)" rather than
 * complaining. The table says what the file is; the period says which one it is.
 *
 * DELIBERATELY NOTHING ELSE
 *
 * Asked for on 13 Oct 2026, after a first version that also carried the brands
 * and every slicer the reader had set. Two selections of the same table on the
 * same dates now produce the same name, which is the trade that was asked for:
 * the names stay short and predictable, and a file is identified by what it is
 * rather than by how it was narrowed.
 */

/** Characters a file name may not carry on Windows or macOS. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * The period, as "2026-10-01 to 2026-10-31".
 *
 * One day where both ends match, and "all dates" where neither is set - which
 * is a real selection and worth saying rather than leaving the name silent.
 */
export function periodLabel(from, to) {
  const a = String(from ?? '').slice(0, 10)
  const b = String(to ?? '').slice(0, 10)
  if (!a && !b) return 'all dates'
  if (a && b) return a === b ? a : `${a} to ${b}`
  return a || b
}

/**
 * Build the file name.
 *
 * `base` is the table - "Product Details", "PA Articles". `ext` is for the one
 * table that also downloads a workbook; everything else takes the default.
 */
export function exportFileName(base, { dateFrom, dateTo, ext = 'csv' } = {}) {
  const name = `${String(base ?? 'Export').trim()} - ${periodLabel(dateFrom, dateTo)}`
  return `${name.replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim()}.${ext}`
}
