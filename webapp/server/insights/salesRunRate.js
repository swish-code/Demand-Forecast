/**
 * Sales value month by month, and the pace the current month is running at.
 *
 * This belongs on a warehouse page because it is the warehouse forecast's own
 * denominator. Every WH figure is `constant x total sales`, so the requirement
 * moves with sales whether or not any article's own behaviour changes — a month
 * running 10% ahead pulls 10% more through the warehouse, and somebody reading
 * a rising outbound forecast should be able to see whether that is a change in
 * demand for the article or simply a busier month.
 *
 * "Run rate" here means the plain thing: what the month is on course for, from
 * how much has been sold so far and how much of the month has gone. It is
 * deliberately not the model's own projection — those sit side by side, and
 * where they disagree that is worth knowing rather than hiding behind one line.
 *
 * Twelve months regardless of the date slicer. A run rate is a comparison with
 * previous months, and a slicer set to three weeks would leave nothing to
 * compare against; the window's end date is honoured so scrolling back in time
 * still works.
 */
import * as cube from '../cube/query.js'
import { config } from '../config.js'
import { cached } from '../cache.js'

const MONTHS_BACK = 12

const monthOf = (iso) => String(iso).slice(0, 7)
const daysInMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * The last day any brand has actual sales for.
 *
 * The models are not all extracted to the same day, and taking the latest of
 * them would treat one brand's forecast as everybody's actual. The earliest is
 * the honest boundary: a day is only "actual" once every brand has reported it.
 */
function actualThrough() {
  const dates = config.brands
    .map((b) => cube.dateRangeFor(b.code)?.lastActual)
    .filter(Boolean)
    .sort()
  return dates.length ? dates[0] : null
}

export async function salesRunRate({ dateTo } = {}) {
  const asked = String(dateTo || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const [y, m] = asked.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1 - (MONTHS_BACK - 1), 1)).toISOString().slice(0, 10)

  /*
   * Read to the end of the month, not to the end of the slicer.
   *
   * Cutting the window mid-month truncates "still expected" to the few days
   * before the cut, so the bar shows a fraction of the month while the run rate
   * beside it projects the whole of it — 828,505 against 2,899,603 on the first
   * run of this, which reads as the month collapsing rather than as two figures
   * measuring different spans.
   */
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)

  return cached(`sales-runrate:${from}:${end}`, async () => {
    const rows = await cube.salesByDate(from, end).catch(() => [])
    if (!rows.length) return { months: [], unavailable: true }

    const boundary = actualThrough()

    /*
     * Split each month into what has happened and what has not.
     *
     * `cube_sales_daily` holds one series that is actual for past dates and
     * forecast for future ones, so the two are told apart by the date rather
     * than by the column — which is why the boundary above has to be right.
     */
    const byMonth = new Map()
    for (const r of rows) {
      const date = String(r.date).slice(0, 10)
      const ym = monthOf(date)
      const value = Number(r.value) || 0
      const held = byMonth.get(ym) ?? { month: ym, actual: 0, ahead: 0, days: 0, actualDays: 0 }
      held.days += 1
      if (!boundary || date <= boundary) {
        held.actual += value
        held.actualDays += 1
      } else {
        held.ahead += value
      }
      byMonth.set(ym, held)
    }

    const months = [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1))
    for (const mo of months) {
      const inMonth = daysInMonth(mo.month)
      mo.total = mo.actual + mo.ahead
      mo.complete = mo.actualDays >= inMonth
      /*
       * The run rate: today's pace carried to the end of the month.
       *
       * Only for a month still in progress. Quoting it for a finished month
       * would just restate the total while implying it was a projection.
       */
      mo.runRate = mo.complete || !mo.actualDays ? null : (mo.actual / mo.actualDays) * inMonth
      mo.daysInMonth = inMonth
    }

    const current = months.find((mo) => !mo.complete && mo.actualDays > 0) ?? null
    const finished = months.filter((mo) => mo.complete)
    const previous = finished.length ? finished[finished.length - 1] : null

    /*
     * Like for like: the same number of days into the previous month.
     *
     * Comparing nine days of this month against all of last month reads as a
     * collapse every time, which is the most common way a run-rate figure
     * misleads somebody.
     */
    let samePoint = null
    if (current && previous) {
      const prevRows = rows.filter(
        (r) =>
          monthOf(r.date) === previous.month &&
          Number(String(r.date).slice(8, 10)) <= current.actualDays
      )
      samePoint = prevRows.reduce((s, r) => s + (Number(r.value) || 0), 0)
    }

    return {
      months,
      boundary,
      summary: {
        current: current
          ? {
              month: current.month,
              soFar: current.actual,
              days: current.actualDays,
              daysInMonth: current.daysInMonth,
              runRate: current.runRate,
              // What the models themselves expect, for comparison.
              projected: current.total,
            }
          : null,
        previous: previous ? { month: previous.month, total: previous.total } : null,
        samePoint,
        // Pace against the same point last month — the honest comparison.
        pace:
          current && samePoint > 0 ? current.actual / samePoint - 1 : null,
        // And against last month's finished total, which is what a run rate is for.
        versusLastMonth:
          current?.runRate && previous?.total > 0 ? current.runRate / previous.total - 1 : null,
      },
    }
  })
}
