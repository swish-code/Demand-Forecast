/**
 * Two shapes in the shipping history that decide how forecastable it is.
 *
 * Both were measured by hand while working out why warehouse accuracy sits
 * where it does. Computed live here instead of quoted, because a number written
 * into a page is true on the day it is written and slowly becomes a lie, and
 * because the whole argument these figures support — that the method has to
 * match the demand pattern — is only worth making if the patterns can be
 * checked on any window.
 *
 * ZERO WEEKS. Most article-weeks have no shipment at all. That is not a gap in
 * the data, it is what the demand looks like: an article ordered every third
 * week is silent two weeks in three, and a forecast that spreads its demand
 * evenly is wrong in both — too high on the quiet weeks and too low on the
 * ordering week.
 *
 * WEEKDAY SHAPE. A large minority of articles ship on one weekday. Spreading
 * their forecast evenly across the week guarantees a miss on every other day,
 * which is why accuracy on a short window reads so much worse than the same
 * articles over a whole month.
 */
import * as cube from '../cube/query.js'

/** How far back the patterns are measured. Half a year of ordering cycles. */
const WEEKS = 26

const DAY = 86_400_000
const iso = (d) => new Date(d).toISOString().slice(0, 10)

/** Sunday first, matching PostgreSQL's `EXTRACT(DOW)`. */
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * How often articles actually ship, and on which days.
 *
 * Returns null rather than throwing when the copy cannot answer — these are
 * explanatory figures, and a page that loses its whole diagnosis because one
 * supporting chart failed is worse than a page missing that chart.
 */
export async function shippingPatterns({ asAt = new Date() } = {}) {
  const to = typeof asAt === 'string' ? asAt.slice(0, 10) : iso(asAt)
  const from = iso(Date.parse(`${to}T00:00:00Z`) - WEEKS * 7 * DAY)

  try {
    const [weeks, days] = await Promise.all([
      cube.shippingWeeks(from, to),
      cube.shippingWeekdays(from, to),
    ])

    if (!weeks?.length) return null

    /* ----------------------------------------------------- zero weeks ---- */
    const totalWeeks = WEEKS
    let shipped = 0
    const regularity = { regular: 0, irregular: 0, intermittent: 0 }
    for (const r of weeks) {
      const w = Math.min(Number(r.weeks_shipped) || 0, totalWeeks)
      shipped += w
      const share = w / totalWeeks
      if (share >= 0.8) regularity.regular += 1
      else if (share >= 0.3) regularity.irregular += 1
      else regularity.intermittent += 1
    }
    const articleWeeks = weeks.length * totalWeeks

    /* -------------------------------------------------- weekday shape ---- */
    const perArticle = new Map()
    const overall = new Array(7).fill(0)
    for (const r of days) {
      const a = String(r.article)
      const d = Number(r.dow)
      const q = Number(r.qty) || 0
      if (!Number.isInteger(d) || d < 0 || d > 6) continue
      overall[d] += q
      if (!perArticle.has(a)) perArticle.set(a, new Array(7).fill(0))
      perArticle.get(a)[d] += q
    }

    let oneDay = 0
    let leaning = 0
    let spread = 0
    for (const shape of perArticle.values()) {
      const total = shape.reduce((s, v) => s + v, 0)
      if (total <= 0) continue
      const top = Math.max(...shape) / total
      if (top >= 0.5) oneDay += 1
      else if (top >= 0.3) leaning += 1
      else spread += 1
    }

    const overallTotal = overall.reduce((s, v) => s + v, 0)

    return {
      from,
      to,
      weeks: totalWeeks,
      articles: weeks.length,
      /*
       * The headline: how much of the history is silence.
       *
       * Over articles the warehouse actually shipped in the window, so it
       * measures demand that comes in bursts rather than a catalogue full of
       * dead lines — those are counted by the status ladder instead.
       */
      zeroShare: articleWeeks ? 1 - shipped / articleWeeks : null,
      zeroWeeks: Math.max(0, articleWeeks - shipped),
      articleWeeks,
      regularity: [
        {
          key: 'regular',
          label: 'Ships most weeks',
          note: 'Shipped in 8 weeks out of 10 or more',
          count: regularity.regular,
          plan: 'An average works well here',
        },
        {
          key: 'irregular',
          label: 'Ships some weeks',
          note: 'Shipped in 3 to 8 weeks out of 10',
          count: regularity.irregular,
          plan: 'An average is stretched — better as how often, and how much',
        },
        {
          key: 'intermittent',
          label: 'Ships rarely',
          note: 'Shipped in fewer than 3 weeks out of 10',
          count: regularity.intermittent,
          plan: 'An average is the wrong shape entirely',
        },
      ],
      weekday: {
        overall: overall.map((q, i) => ({
          key: DOW[i],
          label: DOW[i].slice(0, 3),
          qty: q,
          share: overallTotal ? q / overallTotal : 0,
        })),
        concentration: [
          {
            key: 'one-day',
            label: 'Ships on one day',
            note: 'More than half its volume falls on a single weekday',
            count: oneDay,
          },
          {
            key: 'leaning',
            label: 'Leans towards a day',
            note: 'Between a third and a half on one weekday',
            count: leaning,
          },
          {
            key: 'spread',
            label: 'Spread through the week',
            note: 'No single weekday dominates',
            count: spread,
          },
        ],
      },
    }
  } catch (err) {
    console.warn(`  [patterns] ${err.message}`)
    return null
  }
}
