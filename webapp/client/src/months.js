/**
 * A date range, as the whole months it touches.
 *
 * Its own module so it can be tested without a JSX runtime, and because the
 * month boundary is a rule rather than a detail of one page: an off-by-one here
 * would silently drop December from a plan year or ask Power BI for a
 * thirty-second of January.
 */

/** Keep a careless range from turning into a hundred requests. */
const MAX_MONTHS = 24

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * The whole months a range touches, each with its own first and last day.
 *
 * The range is EXPANDED to month boundaries rather than clipped to them: a
 * reader who picks 15 January to 20 March is asking about January, February and
 * March, and showing them a part January beside two whole ones would put three
 * numbers of different lengths under one heading.
 */
export function monthsIn(from, to) {
  const out = []
  const a = String(from ?? '').slice(0, 10)
  const b = String(to ?? '').slice(0, 10)
  if (a.length < 7 || b.length < 7 || b < a) return out

  let y = Number(a.slice(0, 4))
  let m = Number(a.slice(5, 7))
  const ly = Number(b.slice(0, 4))
  const lm = Number(b.slice(5, 7))
  if (!Number.isFinite(y) || !Number.isFinite(m)) return out

  while ((y < ly || (y === ly && m <= lm)) && out.length < MAX_MONTHS) {
    const mm = String(m).padStart(2, '0')
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    out.push({
      key: `${y}-${mm}`,
      from: `${y}-${mm}-01`,
      to: `${y}-${mm}-${String(last).padStart(2, '0')}`,
      label: `${MONTH_NAMES[m - 1]} ${y}`,
      short: `${MONTH_NAMES[m - 1].slice(0, 3).toUpperCase()} ${y}`,
    })
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

