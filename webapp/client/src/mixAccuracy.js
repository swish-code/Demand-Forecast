/**
 * How close the PRODUCT MIX forecast came to what was actually used.
 *
 *   accuracy = 1 - |actual - forecast| / actual
 *
 * Divided by the ACTUAL, not by the larger of the two — which is what makes it
 * a different measure from `whAccuracy`, and deliberately so. This one asks
 * "how wrong was the plan about what we would need", and the thing that
 * happened is the denominator.
 *
 * WHY IT LIVES IN ITS OWN FILE
 *
 * It was written inline in `ComponentLevel.jsx`, where it re-scores a folded
 * row from that row's own totals. The Procurement view needs exactly the same
 * score per article per month, and a second copy of a formula is a second thing
 * to fix: the two pages would read the same columns, under the same heading,
 * and could answer differently. Both now call this.
 *
 * The same reasoning, and the same shape, as `whAccuracy.js` and
 * `insights/stockCover.js`.
 *
 * NULL RATHER THAN A NUMBER, in three cases:
 *
 *   no actual        nothing has been measured, so there is nothing to compare
 *                    against. A future month is the common case, and a zero
 *                    here would read as a forecast that missed completely.
 *   actual of zero   the denominator. Nothing moved, so the ratio has no value
 *                    — not an accuracy of nought.
 *   no forecast      no recipe names this article, so the product mix has
 *                    nothing to explode through one.
 *
 * The figure is left SIGNED and unbounded. An article forecast at 40,345
 * against four units issued scores -1,008,417%, and that is a finding about a
 * discontinued line rather than a number to clamp away. Averaging across
 * articles is where the floor belongs — see `averageScore` in `scores.js`.
 */
export function mixAccuracy(forecast, actual) {
  if (actual === null || actual === undefined) return null
  if (forecast === null || forecast === undefined) return null
  const a = Number(actual)
  const f = Number(forecast)
  if (!Number.isFinite(a) || !Number.isFinite(f)) return null
  if (a <= 0) return null
  return 1 - Math.abs(a - f) / a
}
