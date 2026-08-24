import { forecastAccuracy } from '../data/merge.js'
/**
 * The rules that turn a brand's numbers into things worth telling someone.
 *
 * Kept as pure functions over already-fetched data: no Power BI calls, no
 * database, no clock. That makes each threshold testable on its own, and means
 * the same rules can later feed an email without being reimplemented.
 *
 * Thresholds mirror the dashboard exactly — a finding must never disagree with
 * the figure the same person can see on screen.
 */

export const ACCURACY_TARGET = 0.95
export const ACCURACY_FLOOR = 0.85
export const VARIANCE_LIMIT = 0.15

/**
 * Yesterday's accuracy is judged against this, not the 30-day target.
 *
 * A single day swings far more than a month does, so the line sits lower than
 * the 95% target used for a period — holding one day to 95% would report every
 * brand every morning and the digest would stop being read. The floor below is
 * ten points under the threshold: not "missed it" but "had a bad day".
 */
export const DAILY_ACCURACY_THRESHOLD = 0.9
export const DAILY_ACCURACY_FLOOR = 0.8
/** Share of a production plan needing extra prep before it is worth saying. */
export const EXTRA_PREP_SHARE = 0.4

/** Ordered worst-first, so a digest can be truncated without losing the point. */
export const SEVERITY = ['critical', 'warning', 'info']

const pct = (v, digits = 1) => `${(Number(v) * 100).toFixed(digits)}%`
const int = (v) => Math.round(Number(v) || 0).toLocaleString('en-US')

function finding(severity, code, title, detail, extra = {}) {
  return { severity, code, title, detail, ...extra }
}

/** "Thu 21 Aug" — a date a person recognises without doing arithmetic. */
function dayName(iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/**
 * The most recent day that has all its sales in.
 *
 * Today is excluded because it is still being written — quoting a part day as
 * yesterday's result would report a collapse that has not happened.
 */
export function lastCompleteDay(trend, today) {
  const rows = (trend ?? [])
    .filter((r) => Number(r.Actual_Qty) > 0 && (!today || r.Date < today))
    .sort((a, b) => String(a.Date).localeCompare(String(b.Date)))

  const last = rows[rows.length - 1]
  if (!last) return null

  const actual = Number(last.Actual_Qty)
  const forecast = Number(last.Forecast_Qty) || 0
  return {
    date: last.Date,
    actual,
    forecast,
    accuracy: forecastAccuracy(actual, forecast),
  }
}

/**
 * `input` is one brand's slice:
 *   brand      { code, label }
 *   kpis       { Actual_Qty, Forecast_Qty, Variance_Pct, Forecast_Accuracy }
 *   trend      [{ Date, Actual_Qty, Forecast_Qty }]
 *   locations  [{ LocationID, Forecast_Accuracy }]
 *   plan       { rows, tomorrowQty, extraPrep }
 *   dateRange  { today, lastActual }
 */
export function evaluateBrand(input) {
  const out = []
  const { brand, kpis = {}, trend = [], locations = [], plan, dateRange = {} } = input

  // --- is the data even current? ------------------------------------------
  // Checked first and deliberately loudest: every other finding below is
  // meaningless if the model stopped refreshing.
  const staleDays = daysBetween(dateRange.lastActual, dateRange.today)
  if (staleDays === null) {
    out.push(
      finding(
        'critical',
        'no-data',
        `${brand.label}: no data returned`,
        'The model answered but carried no dates. Treat every other figure for this brand as unverified.'
      )
    )
    return out
  }
  if (staleDays >= 2) {
    out.push(
      finding(
        'critical',
        'stale-data',
        `${brand.label}: actuals are ${staleDays} days behind`,
        `The most recent actual is ${dateRange.lastActual}, but today is ${dateRange.today}. Accuracy and variance below are computed on incomplete data.`,
        { value: staleDays }
      )
    )
  }

  // --- yesterday's accuracy ------------------------------------------------
  //
  // The last complete day rather than the 30-day figure. A month-long average
  // is slow to move and slow to recover, so it reports the same brands as
  // "under target" for weeks after the day that caused it — which is not a
  // morning message. One day is what an operator can still do something about.
  const yesterday = lastCompleteDay(trend, dateRange.today)
  if (yesterday) {
    const a = yesterday.accuracy
    if (a < DAILY_ACCURACY_FLOOR) {
      out.push(
        finding(
          'critical',
          'daily-accuracy-floor',
          `${brand.label}: ${pct(a)} on ${dayName(yesterday.date)}`,
          `Well below the ${pct(DAILY_ACCURACY_THRESHOLD, 0)} daily threshold — ${((DAILY_ACCURACY_THRESHOLD - a) * 100).toFixed(1)}pp under. Sold ${int(yesterday.actual)} against a forecast of ${int(yesterday.forecast)}.`,
          { value: a, date: yesterday.date }
        )
      )
    } else if (a < DAILY_ACCURACY_THRESHOLD) {
      out.push(
        finding(
          'warning',
          'daily-accuracy',
          `${brand.label}: ${pct(a)} on ${dayName(yesterday.date)}`,
          `Under the ${pct(DAILY_ACCURACY_THRESHOLD, 0)} daily threshold. Sold ${int(yesterday.actual)} against a forecast of ${int(yesterday.forecast)}.`,
          { value: a, date: yesterday.date }
        )
      )
    }
  }

  // --- headline variance, with its direction spelled out -------------------
  const variance = Number(kpis.Variance_Pct) || 0
  if (Math.abs(variance) > VARIANCE_LIMIT) {
    // Forecast above actual is over-forecasting: prep that was not needed.
    const over = variance < 0
    const gap = Math.abs(Number(kpis.Forecast_Qty) - Number(kpis.Actual_Qty))
    out.push(
      finding(
        Math.abs(variance) > VARIANCE_LIMIT * 2 ? 'critical' : 'warning',
        'variance',
        `${brand.label}: ${over ? 'over' : 'under'}-forecasting by ${pct(Math.abs(variance))}`,
        over
          ? `Forecast exceeded actual by ${int(gap)} units — prep is running ahead of demand.`
          : `Actual exceeded forecast by ${int(gap)} units — branches are likely running short.`,
        { value: variance }
      )
    )
  }

  // --- branches that are dragging the brand down ---------------------------
  const failing = locations
    .filter((l) => Number(l.Forecast_Accuracy) > 0 && Number(l.Forecast_Accuracy) < ACCURACY_FLOOR)
    .sort((a, b) => Number(a.Forecast_Accuracy) - Number(b.Forecast_Accuracy))
  if (failing.length) {
    const names = failing.slice(0, 5).map((l) => `${l.LocationID} (${pct(l.Forecast_Accuracy)})`)
    out.push(
      finding(
        'warning',
        'locations-below-floor',
        `${brand.label}: ${failing.length} branch${failing.length === 1 ? '' : 'es'} below ${pct(ACCURACY_FLOOR, 0)}`,
        names.join(', ') + (failing.length > 5 ? `, and ${failing.length - 5} more` : ''),
        { locations: failing.map((l) => l.LocationID) }
      )
    )
  }

  // --- is accuracy getting worse, not just bad? ----------------------------
  const drift = accuracyDrift(trend)
  if (drift !== null && drift <= -3) {
    out.push(
      finding(
        'warning',
        'accuracy-drift',
        `${brand.label}: accuracy fell ${Math.abs(drift).toFixed(1)}pp over the period`,
        'The rolling 7-day figure is trending down, so the current number is likely to keep sliding.',
        { value: drift }
      )
    )
  }

  // --- tomorrow's prep -----------------------------------------------------
  if (plan) {
    if (!plan.rows) {
      out.push(
        finding(
          'critical',
          'no-plan',
          `${brand.label}: no production plan for tomorrow`,
          'The plan returned zero rows. Branches have nothing to prepare against.'
        )
      )
    } else {
      // Roughly a quarter to a third of any plan normally carries extra prep,
      // so reporting it every morning would just be nine lines of noise. Only
      // an unusual share is worth anyone's attention.
      const share = plan.extraPrep / plan.rows
      if (share >= EXTRA_PREP_SHARE) {
        out.push(
          finding(
            'info',
            'extra-prep',
            `${brand.label}: ${pct(share, 0)} of tomorrow's plan needs extra prep`,
            `${int(plan.extraPrep)} of ${int(plan.rows)} products, against ${int(plan.tomorrowQty)} forecast units — well above the usual quarter.`,
            { value: share }
          )
        )
      }
    }
  }

  return out
}

/** Percentage points gained or lost between the first and last rolling window. */
export function accuracyDrift(trend) {
  const points = rollingAccuracy(trend)
  if (points.length < 2) return null
  return (points[points.length - 1].accuracy - points[0].accuracy) * 100
}

/** Seven-day rolling accuracy, mirroring the chart on the summary page. */
export function rollingAccuracy(trend, window = 7) {
  const rows = (trend ?? []).filter((r) => Number(r.Actual_Qty) > 0)
  const out = []
  for (let i = window - 1; i < rows.length; i++) {
    let actual = 0
    let forecast = 0
    for (let j = i - window + 1; j <= i; j++) {
      actual += Number(rows[j].Actual_Qty) || 0
      forecast += Number(rows[j].Forecast_Qty) || 0
    }
    if (actual <= 0) continue
    out.push({ date: rows[i].Date, accuracy: 1 - Math.abs(actual - forecast) / actual })
  }
  return out
}

function daysBetween(from, to) {
  if (!from || !to) return null
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 86_400_000)
}

/** Worst severity present, for a one-line summary of a whole digest. */
export function worstSeverity(findings) {
  for (const s of SEVERITY) if (findings.some((f) => f.severity === s)) return s
  return null
}
