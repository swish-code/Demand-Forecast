/**
 * A brand that has sales in Power BI and nothing else.
 *
 * Forevermore is the case. There is no product-level data to build a
 * `Forecast_Product_Table` from, so it can never be a brand in the full sense —
 * no recipe explosion, no product forecast, nothing on the Stock Article page.
 * What it does have is a daily sales figure, and that is the one number the
 * rest of the app actually needs from it: FM's warehouse outbound is already in
 * the system and correctly coded, and it was being measured against an
 * all-brands sales total that left FM out.
 *
 * So this is a second, much smaller extract. It reads one table of daily sales
 * and writes it into `cube_sales_daily` under its own brand code, which is
 * the whole integration — every per-brand query filters `brand = ?` and cannot
 * see it, and the four all-brands queries have no brand filter and pick it up.
 *
 * The brand is deliberately kept out of `config.brands`. That list drives the
 * picker and every full-brand query, and an entry there would point the recipe
 * and product code at tables this model does not have.
 *
 * Column names are discovered rather than dictated. The model is being built by
 * hand from a spreadsheet, and "Business Date" or "Net Sales" are as likely as
 * "Date" and "Actual" — so the schema is read once and matched against the same
 * vocabulary the CSV importer uses. If nothing matches, the error says exactly
 * what to rename.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { pg } from '../db/accounts.js'
import { COLUMN_ALIASES, normalise } from './salesImport.js'

const BATCH = 500

/** Discovery is a fixed property of the model, so it is read once per process. */
const schemaCache = new Map()

const daxDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-')
  return `DATE(${Number(y)},${Number(m)},${Number(d)})`
}

/** `Table[Column]`, quoting the table only when DAX needs it. */
const ref = (table, column) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(table) ? `${table}[${column}]` : `'${table}'[${column}]`

/**
 * A column that is a proportion rather than a quantity.
 *
 * Found by running discovery against a real model: it happily chose
 * "D. Forecast %" as the forecast, which is a percentage and would have loaded
 * numbers like 0.94 into a sales column where every total still looks plausible
 * and every figure is wrong. Names carrying a %, "percent", "ratio" or "var"
 * are never the quantity being looked for.
 */
const isRatio = (name) =>
  /%|percent|pct|ratio|variance|\bvar\b|index/i.test(String(name).replace(/_/g, ' '))

/**
 * Exact alias first, then a looser contains-match.
 *
 * Two passes rather than one so "Actual Sales" beats "Sales Amount KWD" when
 * both are present, instead of whichever the model happened to list first.
 */
const matchExact = (name, key) => {
  const n = normalise(name)
  return COLUMN_ALIASES[key].some((a) => n === normalise(a))
}
const matchLoose = (name, key) => {
  const n = normalise(name)
  return COLUMN_ALIASES[key].some((a) => n.includes(normalise(a)))
}

/**
 * Which table and columns to read, from a model's column list.
 *
 * Scored rather than assumed: a model built from a spreadsheet usually has one
 * table, but an import brings the auto-generated date tables along with it, and
 * picking the wrong one produces an empty extract rather than an error. A table
 * only qualifies with both a date column and a numeric sales column.
 *
 * Separated from the query so the choice can be tested against a real model's
 * schema without a network call — which is how the percentage bug was found,
 * and how the Forevermore model was checked before it was published.
 *
 * Takes `{ table, column, type }` and returns the best candidate, or null.
 */
export function chooseSalesTable(all) {
  const tables = new Map()
  for (const r of all) {
    // Power BI's own row-number column is in every table and is never data.
    if (!r.table || !r.column || r.column.startsWith('RowNumber-')) continue
    if (!tables.has(r.table)) tables.set(r.table, [])
    tables.get(r.table).push(r)
  }

  let best = null
  for (const [table, columns] of tables) {
    const numeric = (c) => /number|integer|decimal|currency|double/i.test(c.type)
    // Quantities only — a percentage column is never the figure wanted here.
    const quantities = columns.filter((c) => numeric(c) && !isRatio(c.column))
    const texts = columns.filter((c) => /text|string/i.test(c.type))
    const dates = columns.filter((c) => /date|time/i.test(c.type))

    const pick = (list, key) =>
      list.find((c) => matchExact(c.column, key)) ?? list.find((c) => matchLoose(c.column, key))

    const date = pick(dates, 'date') ?? dates[0]
    const actual = pick(quantities, 'actual')
    const forecast = pick(quantities, 'forecast')
    const location = pick(texts, 'location')
    // The same column cannot be both halves of the comparison.
    if (forecast && actual && forecast.column === actual.column) continue
    if (!date || !actual) continue

    // Prefer the table that answers the most of the question.
    const score = 2 + (forecast ? 1 : 0) + (location ? 1 : 0)
    if (!best || score > best.score) {
      best = {
        score,
        table,
        date: date.column,
        actual: actual.column,
        forecast: forecast?.column ?? null,
        location: location?.column ?? null,
      }
    }
    }

  return best
}

export async function discoverSales(datasetId, workspace = null) {
  if (schemaCache.has(datasetId)) return schemaCache.get(datasetId)

  const work = (async () => {
    const rows = await executeQuery(
      `EVALUATE SELECTCOLUMNS(INFO.VIEW.COLUMNS(), "Tbl", [Table], "Col", [Name], "Type", [DataType])`,
      datasetId,
      { bulk: true, workspace }
    )
    const all = rows.map((r) => {
      const k = Object.keys(r)
      return { table: String(r[k[0]] ?? ''), column: String(r[k[1]] ?? ''), type: String(r[k[2]] ?? '') }
    })

    const best = chooseSalesTable(all)
    if (!best) {
      const seen = [...new Set(all.map((r) => r.table))].join(', ') || '(no tables)'
      throw new Error(
        `No sales table found in this model. It needs one table with a date column and a numeric sales column — name them "Date" and "Sales". Tables present: ${seen}.`
      )
    }
    return best
  })()

  schemaCache.set(datasetId, work)
  // A failed discovery must not be cached, or a fixed model still reads as broken.
  work.catch(() => schemaCache.delete(datasetId))
  return work
}

/** Dropped when a model is republished with different columns. */
export function forgetSalesSchema() {
  schemaCache.clear()
}

/** The brand's daily sales over a window, as `{ date, location, actual, forecast }`. */
export async function fetchSalesOnly(brand, window) {
  const s = await discoverSales(brand.datasetId, brand.workspaceId ?? null)
  const groupBy = [ref(s.table, s.date)]
  if (s.location) groupBy.push(ref(s.table, s.location))

  const measures = [`"Actual", SUM(${ref(s.table, s.actual)})`]
  if (s.forecast) measures.push(`"Forecast", SUM(${ref(s.table, s.forecast)})`)

  const rows = await executeQuery(
    `EVALUATE
SUMMARIZECOLUMNS(
  ${groupBy.join(',\n  ')},
  FILTER(ALL(${ref(s.table, s.date)}),
    ${ref(s.table, s.date)} >= ${daxDate(window.from)} && ${ref(s.table, s.date)} <= ${daxDate(window.to)}),
  ${measures.join(',\n  ')}
)`,
    brand.datasetId,
    // These models are published wherever whoever built them had rights, so the
    // workspace travels with the entry rather than being assumed.
    { bulk: true, workspace: brand.workspaceId ?? null }
  )

  const out = []
  for (const r of rows) {
    const k = Object.keys(r)
    const date = String(r[k[0]] ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const location = s.location ? String(r[k[1]] ?? '').trim() || 'ALL' : 'ALL'
    out.push({
      date,
      location,
      actual: Number(r.Actual) || 0,
      forecast: Number(r.Forecast) || 0,
    })
  }
  return { rows: out, schema: s }
}

/**
 * Refresh one sales-only brand into the local copy.
 *
 * Replaces the window rather than upserting into it, for the same reason the
 * main extract does: a restated day with fewer branches than before must lose
 * the old ones, or both are counted.
 */
export async function refreshSalesOnly(brand, window) {
  const { rows: perBranch, schema } = await fetchSalesOnly(brand, window)

  /*
   * Summed to one row a day.
   *
   * The sales table is keyed on brand and date, because the constant is a
   * brand-level figure and never asks about a branch. Forevermore reports four
   * branches a day, so writing them unaggregated would have three of them
   * overwrite each other and record a quarter of the sales.
   */
  const byDate = new Map()
  for (const r of perBranch) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.actual)
  const rows = [...byDate.entries()]
    .map(([date, actual]) => ({ date, actual }))
    .sort((x, y) => (x.date < y.date ? -1 : 1))

  await pg.tx(async () => {
    await pg.run('DELETE FROM cube_sales_daily WHERE brand = ? AND date >= ? AND date <= ?', [
      brand.code,
      window.from,
      window.to,
    ])
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
      for (const r of slice) args.push(brand.code, r.date, r.actual)
      await pg.run(
        `INSERT INTO cube_sales_daily (${columns.join(', ')})
         VALUES ${slice.map(() => marks).join(', ')}
         ON CONFLICT (brand, date) DO UPDATE SET value = excluded.value`,
        args
      )
    }
  })

  return {
    brand: brand.code,
    rows: rows.length,
    branchRows: perBranch.length,
    from: window.from,
    to: window.to,
    actual: rows.reduce((s, r) => s + r.actual, 0),
    read: `${schema.table}: ${schema.date}, ${schema.actual}${schema.forecast ? ', ' + schema.forecast : ''}${schema.location ? ', ' + schema.location : ''}`,
    noForecast: !schema.forecast,
  }
}

/** How far either side of today a refresh reaches. */
const HISTORY_DAYS = Number(process.env.SALES_ONLY_HISTORY_DAYS) || 800
const AHEAD_DAYS = 35

const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * The whole range, every time.
 *
 * The main extract goes to great trouble to refresh incrementally because it is
 * pulling millions of rows per brand from several tables. This is one table of
 * daily totals — a couple of thousand rows for two years — so a full pull costs
 * one query and removes every question about which days are stale. It also
 * means a restated history corrects itself without anybody asking it to.
 */
export function salesWindow(today = new Date()) {
  const now = Date.parse(iso(today.getTime ? today.getTime() : today))
  return { from: iso(now - HISTORY_DAYS * DAY), to: iso(now + AHEAD_DAYS * DAY) }
}

/**
 * Every sales-only brand, in one pass.
 *
 * Failures are collected rather than thrown: these brands are an addition to
 * the all-brands total, and one badly-shaped model must not stop the nine real
 * brands from refreshing.
 */
export async function refreshAllSalesOnly(window = salesWindow()) {
  const out = []
  for (const brand of config.salesOnly) {
    try {
      out.push(await refreshSalesOnly(brand, window))
    } catch (err) {
      console.warn(`  [sales-only] ${brand.code}: ${err.message}`)
      out.push({ brand: brand.code, error: err.message })
    }
  }
  return out
}
