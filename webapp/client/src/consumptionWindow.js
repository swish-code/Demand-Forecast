/**
 * The month arithmetic the consumption page needs, in one place.
 *
 * Oracle books consumption once per article per outlet per CALENDAR MONTH and
 * nothing in the extract says which day anything moved, so the consumption side
 * cannot be cut finer than a month. A window that is not whole months is still
 * answered - with the months it touches - and the page has to be able to say
 * so, which is what `isWholeMonths` is for.
 *
 * Separate from `window.js` because that module is about the FORECAST window -
 * future months, part-months, what is measurable yet - and this is about a
 * source whose grain is fixed. Mixing them would invite one rule to be applied
 * where the other belongs.
 *
 * Mirrors `monthStartOf` in server/powerbi/consumption.js deliberately: the two
 * sides must agree about which months a window covers, or the banner would name
 * different months from the figures underneath it.
 */

/** The first of the month a date falls in, as ISO. */
export const monthStartOf = (iso) => `${String(iso ?? '').slice(0, 7)}-01`

/**
 * Does this window start on a first and end on a month end?
 *
 * Both halves matter and for different reasons. A window starting mid-month
 * misses days the consumption figure still includes; one ending mid-month does
 * the same at the other end. Either way the forecast side covers fewer days
 * than the consumption beside it, and the comparison is quietly unfair in a
 * direction nobody can see from the numbers.
 */
export function isWholeMonths(from, to) {
  if (!from || !to) return false
  const f = String(from).slice(0, 10)
  const t = String(to).slice(0, 10)
  if (f.slice(8, 10) !== '01') return false
  const [y, m, d] = t.split('-').map(Number)
  if (!y || !m || !d) return false
  // Day 0 of the NEXT month is the last day of this one, which is also how the
  // server decides it - see `consumptionByArticle`.
  return d === new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** The last day of the month a date falls in, as ISO. */
export function monthEndOf(iso) {
  const [y, m] = String(iso ?? '').split('-').map(Number)
  if (!y || !m) return String(iso ?? '')
  // Day 0 of the next month is the last day of this one, which is also how
  // `isWholeMonths` and the server's `consumptionByArticle` decide it.
  const d = new Date(Date.UTC(y, m, 0))
  return d.toISOString().slice(0, 10)
}

/** "01 Oct" / "31 Oct", as the date slicer writes them. */
export function dayLabel(iso) {
  const [y, m, d] = String(iso ?? '').split('-').map(Number)
  if (!y || !m || !d) return String(iso ?? '')
  return `${String(d).padStart(2, '0')} ${SHORT[m - 1]}`
}

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "September 2026" from an ISO month start. */
export function monthLabel(iso) {
  const [y, m] = String(iso ?? '').split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) return String(iso ?? '')
  return `${NAMES[m - 1]} ${y}`
}
