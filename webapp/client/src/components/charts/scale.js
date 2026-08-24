/**
 * Value-axis scale that yields exactly TWO gridlines.
 *
 * Recharts draws a gridline at every axis tick, and a `tickCount` of 3 includes
 * zero — three lines. Here the ticks deliberately omit zero: the bottom of the
 * plot already reads as the baseline, so two round-numbered lines are enough to
 * judge magnitude. Pair with `syncWithTicks` on CartesianGrid, otherwise it adds
 * its own boundary line back.
 */

/**
 * Round up to the next "nice" number. The ladder is finer than the usual
 * 1/2/5 so the axis top sits close to the data: a 55,000 peak becomes 60,000
 * rather than 100,000, which would leave half the plot empty.
 */
const LADDER = [1, 1.2, 1.5, 1.8, 2, 2.5, 3, 4, 5, 6, 8, 10]

function niceNumber(value) {
  if (!Number.isFinite(value) || value <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(value))
  const frac = value / pow
  const step = LADDER.find((s) => frac <= s + 1e-9) ?? 10
  return step * pow
}

/**
 * @param {object[]} data
 * @param {string[]} keys value fields to consider
 * @returns {{domain: [number, number], ticks: number[]}}
 */
export function twoLineScale(data, keys) {
  return axisScale(data, keys, 2)
}

/**
 * Evenly spaced round ticks including zero, as in the reference UI
 * (0k / 15k / 30k / 45k / 60k). `steps` is the number of intervals.
 */
export function axisScale(data, keys, steps = 4) {
  let max = 0
  for (const row of data ?? []) {
    for (const k of keys) {
      const v = Number(row?.[k])
      if (Number.isFinite(v) && v > max) max = v
    }
  }
  if (max <= 0) return { domain: [0, 1], ticks: [1] }

  const top = niceNumber(max)
  const ticks = Array.from({ length: steps + 1 }, (_, i) => (top / steps) * i)
  return { domain: [0, top], ticks }
}

/**
 * A tight range around the data rather than a zero baseline. For two lines that
 * both sit far from zero, anchoring at zero flattens the gap between them; the
 * comparison is what matters here, not the absolute magnitude.
 */
export function tightScale(data, keys, steps = 3) {
  let min = Infinity
  let max = -Infinity
  for (const row of data ?? []) {
    for (const k of keys) {
      const raw = row?.[k]
      // Number(null) is 0, which would drag the minimum to zero and undo the
      // whole point of a tight axis. Skip blanks before converting.
      if (raw === null || raw === undefined || raw === '') continue
      const v = Number(raw)
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return axisScale(data, keys, 4)

  const step = niceNumber((max - min) / steps)
  const lo = Math.max(0, Math.floor(min / step) * step)
  const hi = Math.ceil(max / step) * step
  const ticks = []
  for (let v = lo; v <= hi + 1e-6; v += step) ticks.push(Math.round(v))
  return { domain: [lo, hi], ticks }
}
