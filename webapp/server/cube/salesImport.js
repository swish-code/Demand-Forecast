/**
 * Daily sales for a brand that has no semantic model of its own.
 *
 * Forevermore is the case this exists for. Its warehouse outbound is already in
 * the system and correctly coded FM — 3.9 million units across 293 articles —
 * but it has no forecast model, so its sales were missing. That left the
 * catch-all bucket measuring FM's outbound against a sales total that excluded
 * FM, which overstates every rate derived from it.
 *
 * The rows land in `cube_sales_daily` under their own brand code, which is
 * the whole trick: every per-brand read filters `brand = ?` and so cannot see
 * them, while the four all-brands reads have no brand filter and pick them up
 * automatically. Nothing else in the app has to know this brand exists — it is
 * not in `config.brands`, so it never appears in the picker and no query is
 * ever pointed at a dataset it does not have.
 *
 * The extract leaves these rows alone: its only DELETE is scoped to `brand = ?`
 * for brands it owns, so an import survives every refresh.
 */
import { pg } from '../db/accounts.js'

/** Rows per INSERT. The same size the extract uses. */
const BATCH = 500

/** Excel keeps dates as days since 1899-12-30. Anything this big is one. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

const pad = (n) => String(n).padStart(2, '0')
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`

/**
 * A number that may have arrived dressed as a spreadsheet cell.
 *
 * Thousands separators, a stray currency symbol, accounting parentheses for
 * negatives, and non-breaking spaces all appear in exported files and all mean
 * a number. Returns null for anything genuinely unreadable rather than 0, so a
 * bad cell can be reported instead of silently becoming a zero sales day.
 */
export function parseNumber(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  let s = String(raw).trim()
  if (!s || s === '-' || s === '–') return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[\s  ]/g, '').replace(/[^0-9.,-]/g, '')
  // 1.234,56 (European) against 1,234.56 — whichever separator is last is the
  // decimal point, and the other is grouping.
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (lastComma > -1) {
    // A lone comma is a decimal point only when it is not grouping digits.
    s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.')
  }
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

/**
 * Every date in the file, read the same way — and the way chosen out loud.
 *
 * `03/04/2026` is the third of April or the fourth of March and nothing in the
 * cell says which. Guessing is how a sales file silently lands on the wrong
 * days, so the whole column is examined first: a value with a first part over
 * twelve proves day-first, a second part over twelve proves month-first. Only
 * when neither appears anywhere is the file genuinely ambiguous, and then it
 * says so rather than picking one.
 *
 * ISO dates and Excel serial numbers are unambiguous and skip all of this.
 */
export function detectDateOrder(values) {
  let dayFirst = false
  let monthFirst = false
  for (const v of values) {
    const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(String(v ?? '').trim())
    if (!m) continue
    const a = Number(m[1])
    const b = Number(m[2])
    if (a > 12) dayFirst = true
    if (b > 12) monthFirst = true
  }
  if (dayFirst && monthFirst) return { order: 'conflict' }
  if (dayFirst) return { order: 'day-first', proven: true }
  if (monthFirst) return { order: 'month-first', proven: true }
  return { order: 'day-first', proven: false }
}

/** One cell to an ISO date, given the order the column was found to use. */
export function parseDate(raw, order) {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  if (!s) return null

  // Already ISO, possibly with a time on the end.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (iso) return isoOf(iso[1], Number(iso[2]), Number(iso[3]))

  // An Excel serial number.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (n > 20000 && n < 90000) {
      const d = new Date(EXCEL_EPOCH + Math.floor(n) * 86_400_000)
      return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
    }
    return null
  }

  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s)
  if (!m) return null
  const first = Number(m[1])
  const second = Number(m[2])
  let year = Number(m[3])
  if (year < 100) year += year < 70 ? 2000 : 1900
  const day = order === 'month-first' ? second : first
  const month = order === 'month-first' ? first : second
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return isoOf(year, month, day)
}

/** Split one delimited line, honouring quoted fields. */
function splitLine(line, delimiter) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') cur += line[++i]
        else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === delimiter) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((v) => v.trim())
}

/** Which of the usual names a column is going by. */
export const COLUMN_ALIASES = {
  date: ['date', 'day', 'salesdate', 'businessdate', 'trandate', 'transactiondate', 'postingdate'],
  location: ['location', 'locationid', 'branch', 'store', 'outlet', 'site', 'shop', 'cost center', 'costcenter'],
  actual: ['actual', 'actualsales', 'sales', 'netsales', 'actualqty', 'amount', 'value', 'total', 'grosssales'],
  forecast: ['forecast', 'forecastsales', 'runrate', 'monthrunrate', 'budget', 'target', 'plan', 'projected'],
}

export const normalise = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

function matchColumns(header) {
  const found = {}
  header.forEach((name, i) => {
    const n = normalise(name)
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (found[key] !== undefined) continue
      if (aliases.some((a) => n === normalise(a))) found[key] = i
    }
  })
  // A second, looser pass, so "Sales Amount KWD" still finds `actual`.
  header.forEach((name, i) => {
    const n = normalise(name)
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (found[key] !== undefined) continue
      if (aliases.some((a) => n.includes(normalise(a)))) found[key] = i
    }
  })
  return found
}

/**
 * A delimited sales file to rows this app can store.
 *
 * Reports rather than throws. A file with three bad lines out of nine hundred
 * should load the other eight hundred and ninety-seven and say which three were
 * skipped and why — a whole import refused over one malformed cell is how
 * people end up pasting numbers in by hand.
 */
export function parseSalesCsv(text, { defaultLocation = 'ALL' } = {}) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
  if (lines.length < 2) {
    return { rows: [], skipped: [], columns: {}, error: 'The file needs a header row and at least one row of data.' }
  }

  // Whichever candidate appears most often in the header line.
  const delimiter = [',', ';', '\t', '|']
    .map((d) => ({ d, n: lines[0].split(d).length }))
    .sort((a, b) => b.n - a.n)[0].d

  const header = splitLine(lines[0], delimiter)
  const columns = matchColumns(header)
  if (columns.date === undefined) {
    return { rows: [], skipped: [], columns, header, error: 'No date column found. Name one of the columns "Date".' }
  }
  if (columns.actual === undefined && columns.forecast === undefined) {
    return {
      rows: [],
      skipped: [],
      columns,
      header,
      error: 'No sales column found. Name one of the columns "Actual" (and optionally "Forecast").',
    }
  }

  const body = lines.slice(1).map((l) => splitLine(l, delimiter))
  const order = detectDateOrder(body.map((c) => c[columns.date]))
  if (order.order === 'conflict') {
    return {
      rows: [],
      skipped: [],
      columns,
      header,
      error:
        'The date column mixes day-first and month-first dates, so it cannot be read safely. Please export it as YYYY-MM-DD.',
    }
  }

  /*
   * Summed per date and location, not one row per line.
   *
   * A daily sales export often carries a line per till, per hour or per
   * receipt, and the table is keyed on brand + date + location — so the last
   * line would otherwise overwrite the rest of the day instead of adding to it.
   */
  const totals = new Map()
  const skipped = []
  body.forEach((cells, i) => {
    const date = parseDate(cells[columns.date], order.order)
    if (!date) {
      skipped.push({ line: i + 2, why: `could not read the date "${cells[columns.date] ?? ''}"` })
      return
    }
    const actual = columns.actual === undefined ? 0 : parseNumber(cells[columns.actual]) ?? 0
    const forecast = columns.forecast === undefined ? 0 : parseNumber(cells[columns.forecast]) ?? 0
    const location =
      columns.location === undefined ? defaultLocation : String(cells[columns.location] ?? '').trim() || defaultLocation

    const key = `${date}|${location}`
    const held = totals.get(key) ?? { date, location, actual: 0, forecast: 0 }
    held.actual += actual
    held.forecast += forecast
    totals.set(key, held)
  })

  const rows = [...totals.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return {
    rows,
    skipped,
    columns,
    header,
    dateOrder: order,
    /*
     * Said out loud, because it is the one thing that can be wrong without
     * looking wrong. A day-first reading of an all-ambiguous column loads real
     * numbers onto the wrong dates and every total still balances.
     */
    dateWarning:
      order.proven || !rows.length
        ? null
        : `Every date in the file could be read either way round, so they were read as day-first (${rows[0].date} from "${body[0]?.[columns.date]}"). Check that is right, or export as YYYY-MM-DD.`,
    missingForecast: columns.forecast === undefined,
  }
}

/**
 * Write a brand's daily sales into the local copy, replacing what was there.
 *
 * Scoped to the dates the file covers, so importing one month does not delete
 * the others. Replace rather than upsert, for the reason the extract does the
 * same: a restated day that has fewer locations than before must lose the old
 * ones, or the two are counted together.
 */
export async function importSales(brand, perBranch) {
  const code = String(brand ?? '').trim()
  if (!code) throw new Error('A brand code is required.')
  if (!perBranch.length) return { written: 0, from: null, to: null }

  // One row a day: the table is keyed on brand and date, so several branches on
  // the same day are added together rather than overwriting one another.
  const byDate = new Map()
  for (const r of perBranch) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.actual)
  const rows = [...byDate.entries()]
    .map(([date, actual]) => ({ date, actual }))
    .sort((x, y) => (x.date < y.date ? -1 : 1))

  const dates = rows.map((r) => r.date).sort()
  const from = dates[0]
  const to = dates[dates.length - 1]

  await pg.tx(async () => {
    await pg.run('DELETE FROM cube_sales_daily WHERE brand = ? AND date >= ? AND date <= ?', [code, from, to])
    /*
     * Into the value columns, not the quantity ones.
     *
     * These sales are money. The quantity columns feed the Overview trend and
     * the branch panel, where the figure is labelled Qty and genuinely is one —
     * so a brand with no item count contributes nothing there, and everything
     * to the value total the constant divides by.
     */
    const columns = ['brand', 'date', 'value']
    const marks = `(${columns.map(() => '?').join(', ')})`
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH)
      const args = []
      for (const r of slice) args.push(code, r.date, r.actual)
      await pg.run(
        `INSERT INTO cube_sales_daily (${columns.join(', ')})
         VALUES ${slice.map(() => marks).join(', ')}
         ON CONFLICT (brand, date) DO UPDATE SET value = excluded.value`,
        args
      )
    }
  })

  return {
    written: rows.length,
    from,
    to,
    actual: rows.reduce((s, r) => s + r.actual, 0),
  }
}

/** What is already loaded for a brand, so the admin screen can show it. */
export async function importedSales(brand) {
  const row = await pg.get(
    `SELECT MIN(date) AS lo, MAX(date) AS hi, COUNT(*)::int AS n,
            SUM(value) AS actual, 0 AS forecast
       FROM cube_sales_daily WHERE brand = ?`,
    [String(brand ?? '').trim()]
  )
  if (!row || !row.n) return null
  return {
    from: row.lo,
    to: row.hi,
    rows: row.n,
    actual: Number(row.actual) || 0,
    forecast: Number(row.forecast) || 0,
  }
}
