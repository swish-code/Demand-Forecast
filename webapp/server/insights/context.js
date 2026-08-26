import { forecastAccuracy } from '../data/merge.js'
/**
 * Why the forecast and the actuals differ — computed once, read by several pages.
 *
 * This exists to answer a question branches ask constantly: "the plan told us to
 * prepare more than we sold, is the dashboard wrong?" Usually it is not, and the
 * real reason is knowable — demand moved and the forecast has not caught up, or
 * this weekday is always over, or the whole brand leans the same way.
 *
 * The one rule that matters here: this must **attribute** the gap, never excuse
 * it. Every figure below is a measurement, and the wording built from it says
 * "unexplained" when nothing explains it. A panel that always finds an external
 * cause gets found out, and then nobody believes any of the numbers.
 */

const DAY = 86_400_000
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const num = (v) => Number(v) || 0

function quantile(sorted, q) {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * @param trend      [{ Date, Actual_Qty, Forecast_Qty }] daily, ascending
 * @param byLocation [{ LocationID, Actual_Qty, Forecast_Qty }] over the same window
 */
export function buildContext({ trend = [], byLocation = [], today = null } = {}) {
  // Only completed days. Today is still being written and would read as a
  // collapse in demand that has not happened.
  const rows = trend
    .filter((r) => num(r.Actual_Qty) > 0 && (!today || r.Date < today))
    .sort((a, b) => String(a.Date).localeCompare(String(b.Date)))

  if (rows.length < 8) {
    return { enough: false, days: rows.length }
  }

  // Signed error, forecast minus actual. Positive means over-forecast: the plan
  // asked for more prep than the day needed.
  const err = rows.map((r) => num(r.Forecast_Qty) - num(r.Actual_Qty))
  const scale = mean(rows.map((r) => num(r.Actual_Qty))) || 1

  const bias = mean(err) / scale
  const typical = mean(err.map(Math.abs)) / scale
  const noise = Math.max(0, typical - Math.abs(bias))

  // --- weekday pattern -----------------------------------------------------
  const buckets = new Map()
  rows.forEach((r, i) => {
    const d = new Date(`${r.Date}T00:00:00Z`).getUTCDay()
    if (!buckets.has(d)) buckets.set(d, [])
    buckets.get(d).push(err[i] / num(r.Actual_Qty))
  })
  const weekday = [1, 2, 3, 4, 5, 6, 0]
    .filter((d) => buckets.has(d))
    .map((d) => ({
      day: d,
      label: DAY_NAMES[d],
      lean: mean(buckets.get(d)),
      samples: buckets.get(d).length,
    }))

  // What removing each weekday's average lean would leave behind. The gap
  // between this and `typical` is what a weekday correction is actually worth.
  const byDay = new Map(weekday.map((w) => [w.day, w.lean]))
  const afterWeekday = mean(
    rows.map((r, i) => {
      const d = new Date(`${r.Date}T00:00:00Z`).getUTCDay()
      return Math.abs(err[i] / num(r.Actual_Qty) - (byDay.get(d) ?? 0))
    })
  )

  // --- has demand moved, and did the forecast follow? ----------------------
  const last7 = rows.slice(-7)
  const prev7 = rows.slice(-14, -7)
  let shift = null
  if (prev7.length === 7) {
    const aPrev = mean(prev7.map((r) => num(r.Actual_Qty)))
    const fPrev = mean(prev7.map((r) => num(r.Forecast_Qty)))
    const actual = aPrev ? (mean(last7.map((r) => num(r.Actual_Qty))) - aPrev) / aPrev : 0
    const forecast = fPrev ? (mean(last7.map((r) => num(r.Forecast_Qty))) - fPrev) / fPrev : 0
    shift = { actual, forecast, lag: actual - forecast }
  }

  // --- week by week, for the "what changed" chart --------------------------
  // Anchored to the most recent complete day and walked backwards, so the last
  // bucket is always a full seven days rather than whatever the month left over.
  const weeks = []
  for (let end = rows.length; end - 7 >= 0; end -= 7) {
    const slice = rows.slice(end - 7, end)
    const actual = slice.reduce((n, r) => n + num(r.Actual_Qty), 0)
    const forecast = slice.reduce((n, r) => n + num(r.Forecast_Qty), 0)
    weeks.unshift({ from: slice[0].Date, to: slice[slice.length - 1].Date, actual, forecast })
    if (weeks.length >= 8) break
  }
  const weekly = weeks.map((w, i) => {
    const prev = weeks[i - 1]
    return {
      ...w,
      actualChange: prev?.actual ? (w.actual - prev.actual) / prev.actual : null,
      forecastChange: prev?.forecast ? (w.forecast - prev.forecast) / prev.forecast : null,
    }
  })

  // --- the range a normal day falls in -------------------------------------
  // Percentiles, not a standard deviation: daily variance is not symmetric and
  // one closure or one promotion would widen an SD enough to make the band
  // useless exactly when it matters.
  const daily = rows.map((r, i) => err[i] / num(r.Actual_Qty)).sort((a, b) => a - b)

  /*
   * The middle half of days, not the middle eight-tenths.
   *
   * At the tenth and ninetieth percentiles the band came out around 87–104 for
   * every 100 prepped — seventeen points wide, which is too loose to prep
   * against: a range that covers almost everything tells a section leader
   * nothing they can act on. The quartiles describe the day they are actually
   * likely to get. The two worst and two best days in a month sit outside it on
   * purpose, and `low`/`high` are still honest about which days those are.
   */
  const BAND_LOW = 0.25
  const BAND_HIGH = 0.75
  const band = {
    lo: quantile(daily, BAND_LOW),
    hi: quantile(daily, BAND_HIGH),
    median: quantile(daily, 0.5),
  }

  // The same band restated as the question a kitchen actually asks: of what the
  // plan tells us to prepare, how much has been selling?
  //
  // `band` measures forecast against actual; this inverts it, so the most
  // over-forecast day becomes the *lowest* share of the plan that sold.
  const share = (e) => 1 / (1 + e)
  const trust = {
    low: share(band.hi),
    high: share(band.lo),
    typical: share(band.median),
    days: rows.length,
  }

  // --- how each branch is leaning ------------------------------------------
  const locations = byLocation
    .map((l) => {
      const a = num(l.Actual_Qty)
      const f = num(l.Forecast_Qty)
      return {
        location: l.LocationID,
        qty: a,
        lean: a ? (f - a) / a : 0,
        accuracy: forecastAccuracy(a, f),
      }
    })
    .filter((l) => l.qty > 0)
    .sort((a, b) => b.lean - a.lean)

  const leaning = locations.filter((l) => Math.abs(l.lean) > 0.02)
  const sameWay =
    leaning.length > 1 && leaning.every((l) => Math.sign(l.lean) === Math.sign(leaning[0].lean))

  return {
    enough: true,
    days: rows.length,
    window: { from: rows[0].Date, to: rows[rows.length - 1].Date },
    typical,
    bias,
    noise,
    weekday,
    weekdayFix: { after: afterWeekday, saves: Math.max(0, typical - afterWeekday) },
    shift,
    weekly,
    band,
    trust,
    locations,
    brandLean: mean(locations.map((l) => l.lean)),
    allLeanSameWay: sameWay,
  }
}

/**
 * The headline sentence, in the words a branch manager would use.
 *
 * Ordered by how much of the gap each cause accounts for, and it returns
 * `cause: 'unexplained'` when none of them do. That last case is the reason
 * anybody trusts the other four.
 */
export function explain(ctx) {
  if (!ctx?.enough) {
    return { cause: 'insufficient', headline: 'Not enough completed days yet to explain the gap.' }
  }

  const pct = (v) => `${Math.abs(v * 100).toFixed(1)}%`

  // A demand move the forecast has not followed is the biggest single cause
  // when it happens, and it is the one people most often mistake for a bug.
  if (ctx.shift && Math.abs(ctx.shift.lag) >= 0.03 && Math.abs(ctx.shift.actual) >= 0.05) {
    const fell = ctx.shift.actual < 0
    return {
      cause: 'demand-shift',
      headline: `Demand ${fell ? 'fell' : 'rose'} ${pct(ctx.shift.actual)} this week and the forecast has only ${fell ? 'come down' : 'risen'} ${pct(ctx.shift.forecast)}.`,
      detail: `The forecast is running ${fell ? 'ahead of' : 'behind'} demand by about ${pct(ctx.shift.lag)} while it catches up. This is a change in how much is being sold, not a change to how the forecast is calculated.`,
    }
  }

  const worstDay = [...ctx.weekday].sort((a, b) => Math.abs(b.lean) - Math.abs(a.lean))[0]
  if (worstDay && Math.abs(worstDay.lean) >= 0.08 && ctx.weekdayFix.saves >= 0.01) {
    return {
      cause: 'weekday',
      headline: `${worstDay.label} is consistently ${worstDay.lean > 0 ? 'over' : 'under'}-forecast by ${pct(worstDay.lean)}.`,
      detail: `The same pattern shows up every ${worstDay.label} across the period, so it is predictable rather than random — prepare toward the ${worstDay.lean > 0 ? 'lower' : 'higher'} end on that day.`,
    }
  }

  if (Math.abs(ctx.bias) >= 0.03 && Math.abs(ctx.bias) > ctx.noise) {
    return {
      cause: 'lean',
      headline: `The forecast runs ${pct(ctx.bias)} ${ctx.bias > 0 ? 'above' : 'below'} actual demand most days.`,
      detail: `${ctx.allLeanSameWay ? 'Every branch leans the same way, so this is brand-wide' : 'The lean is not the same at every branch'}. It is a steady offset rather than day-to-day noise, and it has been passed to whoever maintains the model.`,
    }
  }

  if (ctx.typical > 0 && ctx.noise >= Math.abs(ctx.bias)) {
    return {
      cause: 'noise',
      headline: `Day-to-day variation of about ${pct(ctx.typical)} is normal for this brand.`,
      detail: 'There is no consistent lean — some days land over, some under. A gap of this size on any single day is expected rather than a fault.',
    }
  }

  return {
    cause: 'unexplained',
    headline: 'The current gap is not explained by demand shifts, weekday patterns or a steady lean.',
    detail: 'Worth raising with whoever maintains the forecast — none of the usual causes account for it.',
  }
}

/**
 * What to tell a production team about how far to trust the plan.
 *
 * Written for someone standing in a kitchen, not reading a report. "About 96
 * out of every 100 units on the plan actually got sold" is a sentence you can
 * prep against; "the forecast runs 4.7% above actual" is not, however precise
 * it is.
 *
 * Returned as separate pieces rather than one paragraph so the page and the
 * email can lay it out differently while saying exactly the same thing.
 *
 * Null rather than a hedge when there is not enough history — an invented
 * tolerance is worse than no tolerance.
 */
export function trustNote(ctx) {
  if (!ctx?.enough || !ctx.trust) return null

  const pct = (v) => `${Math.round(v * 100)}%`
  const { low, high, typical, days } = ctx.trust
  const perHundred = Math.round(typical * 100)

  // Which way the plan leans decides the advice, so it is decided once here
  // rather than being left to whoever writes the next piece of copy.
  const leansOver = typical < 0.97
  const leansUnder = typical > 1.03

  const advice = leansOver
    ? {
        summary:
          'The plan tends to ask for a little more than what is needed, so prepping the exact full amount every day usually leaves you with leftovers.',
        keeps: `For items that keep well and do not spoil fast, prepping about ${pct(typical)} of the plan amount is usually safer.`,
        fast:
          'For fast movers that tend to sell out, stick with the full planned amount so you do not run short.',
      }
    : leansUnder
      ? {
          summary:
            'The plan tends to ask for a little less than what is needed, so prepping the exact amount has been leaving you short more often than not.',
          keeps: `For items that keep well, prepping about ${pct(typical)} of the plan amount has been closer to what actually sells.`,
          fast: 'For fast movers, prep a little above the planned amount so you do not sell out early.',
        }
      : {
          summary:
            'The plan has been landing close, over about as often as under.',
          keeps: 'Prepare to the stated quantity.',
          fast: 'No adjustment needed on fast movers either.',
        }

  // The whole panel in one sentence, in the words a kitchen actually uses.
  //
  // No percentages of percentages and no "variance": "for every 100 you prep,
  // you have been selling between 88 and 104" is a thing a section leader can
  // picture. The long version below still exists for the API.
  const per = (v) => Math.round(v * 100)
  const evidence = `For every 100 you prep, you have most often sold between ${per(low)} and ${per(high)}.`

  // Both halves of the advice in one line, because the halves point opposite
  // ways and only giving one of them is how a kitchen ends up short.
  //
  // The plan leaning high does not mean make less of everything: it means make
  // less of what keeps, and still make the full amount of anything that sells
  // out, because running out of a fast mover costs a sale and a leftover tray
  // of something that keeps costs almost nothing.
  const headline = leansOver
    ? `Make about ${pct(typical)} of the plan on items that keep, but still make the full amount on fast movers. ${evidence}`
    : leansUnder
      ? `Make a little more than the plan, especially on fast movers. ${evidence}`
      : `Make what the plan says, on everything. ${evidence}`

  return {
    low,
    high,
    typical,
    days,
    perHundred,
    headline,
    question: 'How much can you trust this prep plan?',
    lead: `Looking at the last ${days} days: most days, about ${perHundred} out of every 100 units on the plan actually got sold.`,
    range: `On half of the days, actual sales landed between ${pct(low)} and ${pct(high)} of what the plan said.`,
    meaningTitle: 'What this means for prepping',
    ...advice,
    basis: `Based on the last ${days} completed days.`,
  }
}
