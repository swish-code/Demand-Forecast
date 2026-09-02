/**
 * Combining the same query across several brands.
 *
 * Each brand is its own semantic model, so "show me BBT and Chilli Pepper" is
 * two queries whose results have to be added up here rather than in DAX. The
 * rules below are the ones that keep the arithmetic honest:
 *
 *   - Quantities add.
 *   - Ratios never add. Variance and accuracy are recomputed from the summed
 *     quantities, because the average of two percentages is not the percentage
 *     of the two totals unless the brands happen to be the same size.
 *   - Rows that name the same thing in two brands stay separate. Two branches
 *     can share a location code across chains, and silently folding them
 *     together would invent a branch that does not exist.
 */

const num = (v) => Number(v) || 0

/**
 * Accuracy, defined exactly as the model's own measure defines it:
 *
 *     1 - ABS( DIVIDE( actual - forecast, actual ) )
 *
 * The denominator is the **actual**, matching the measure as it stands today.
 * It used to be the forecast, and this used to divide by the forecast to match
 * — then the measures were corrected in Power BI and this was left behind,
 * putting the app 0.09 to 0.23pp above what the report showed on every brand.
 *
 * Verified against the live models over a window of complete days, per brand:
 * BBT, CHP, MM and TBL all agree with the actual-denominator form to the second
 * decimal. Yelo Pizza is the exception — its model still divides by the
 * forecast, so this reads about 0.14pp below what Yelo's own report shows until
 * that measure is corrected too. The admin review names it.
 *
 * The app's job is to agree with the report, not to be independently correct.
 * Kept in one place so it cannot drift again.
 */
export function forecastAccuracy(actual, forecast) {
  if (!actual) return 1
  return 1 - Math.abs(actual - forecast) / actual
}

/** Variance and accuracy, derived the same way the DAX measures derive them. */
export function deriveKpis(actual, forecast) {
  return {
    Actual_Qty: actual,
    Forecast_Qty: forecast,
    Variance_Qty: actual - forecast,
    Variance_Pct: forecast ? (actual - forecast) / forecast : 0,
    Forecast_Accuracy: forecastAccuracy(actual, forecast),
  }
}

export function mergeKpis(parts) {
  const rows = parts.filter(Boolean)
  if (rows.length === 1) return rows[0]
  const actual = rows.reduce((n, r) => n + num(r.Actual_Qty), 0)
  const forecast = rows.reduce((n, r) => n + num(r.Forecast_Qty), 0)
  return deriveKpis(actual, forecast)
}

/** Daily series, summed date by date and returned in ascending order. */
export function mergeTrend(parts) {
  const lists = parts.filter(Boolean)
  if (lists.length === 1) return lists[0]

  const byDate = new Map()
  for (const list of lists) {
    for (const r of list) {
      const prev = byDate.get(r.Date) ?? { Date: r.Date, Actual_Qty: 0, Forecast_Qty: 0 }
      prev.Actual_Qty += num(r.Actual_Qty)
      prev.Forecast_Qty += num(r.Forecast_Qty)
      byDate.set(r.Date, prev)
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.Date).localeCompare(String(b.Date)))
}

/**
 * Rows keyed by one or more columns, summing the measures named in `sum`.
 *
 * `key` includes the brand for anything a brand can own — a product name or a
 * location code is only unique inside its own chain.
 */
/**
 * `keepNull` names measures where blank means "not known", not "none".
 *
 * Consumption is the case. It sits on one row per article and every other row
 * of that article is blank, so merging two brands that both carry the blank
 * side of the same component summed null with null and produced a measured
 * zero — a component the warehouse simply had not reported on came out looking
 * like one nobody had issued, and scored 0% accuracy for it.
 */
export function mergeRows(parts, { key, sum, sort, keepNull = [] }) {
  const lists = parts.filter(Boolean)
  if (lists.length === 1) return lists[0]

  const blank = new Set(keepNull)
  const missing = (v) => v === null || v === undefined

  const out = new Map()
  for (const list of lists) {
    for (const r of list) {
      const k = key(r)
      const prev = out.get(k)
      if (!prev) {
        out.set(k, { ...r })
        continue
      }
      for (const field of sum) {
        if (blank.has(field) && missing(prev[field]) && missing(r[field])) {
          prev[field] = null
          continue
        }
        prev[field] = num(prev[field]) + num(r[field])
      }
    }
  }
  const rows = [...out.values()]
  return sort ? rows.sort(sort) : rows
}

/** Slicer option lists: union, de-duplicated, sorted. */
export function mergeOptions(parts) {
  const seen = new Set()
  const out = []
  for (const list of parts) {
    for (const v of list ?? []) {
      const k = typeof v === 'object' && v !== null ? String(v.value) : String(v)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(v)
    }
  }
  return out.sort((a, b) => {
    const x = typeof a === 'object' && a !== null ? String(a.label ?? a.value) : String(a)
    const y = typeof b === 'object' && b !== null ? String(b.label ?? b.value) : String(b)
    return x.localeCompare(y, undefined, { numeric: true })
  })
}

/**
 * The calendar spanning every selected model.
 *
 * `lastActual` takes the **earliest** of the brands rather than the latest: a
 * combined view is only complete up to the point every brand has reported, and
 * quoting the latest would put a day in the window that one brand has no sales
 * for yet.
 */
export function mergeDateRange(parts) {
  const ranges = parts.filter(Boolean)
  if (ranges.length === 1) return ranges[0]

  const min = (field) => ranges.map((r) => r[field]).filter(Boolean).sort()[0]
  const max = (field) => ranges.map((r) => r[field]).filter(Boolean).sort().slice(-1)[0]

  return {
    min: min('min'),
    max: max('max'),
    today: max('today'),
    lastActual: min('lastActual'),
  }
}
