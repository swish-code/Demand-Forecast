/**
 * The two ways this app reports accuracy across articles.
 *
 * Shared by Stock Article and Warehouse Insights. Both pages draw the same rows
 * from the same endpoint, so the only arrangement in which "do the two pages
 * agree?" cannot become a question worth asking is one where the figure is
 * worked out once — here — rather than twice.
 *
 * Moved out of ComponentLevel.jsx on 16 Sep 2026, when Warehouse Insights was
 * changed from comparing totals to reporting these two.
 */

/**
 * The average article's score, one entry per article.
 *
 * Per article rather than per row: the requirement is split across every recipe
 * group that uses an article and the score is a property of the article, so
 * averaging rows would weight a component used by nine recipes nine times.
 *
 * Unweighted, which is the point — a 12-unit article counts the same as a
 * 600,000-unit one. That is a different question from comparing the totals, and
 * the answer is usually lower: totals let one article's over-forecast cancel
 * another's under-forecast, and this does not.
 *
 * A mean, with each article's contribution floored at zero.
 *
 * The score divides by what actually moved, so it has no lower bound: Pepsi
 * Cola Can, forecast at 40,345 against four units issued since that line
 * stopped in July, scores -1,008,417%. Twelve articles like it out of 1,085
 * pulled the mean of an otherwise healthy set to -1087%, which describes
 * nothing and contradicted the band chart directly below it.
 *
 * Zero is the floor because zero is what "completely wrong" is worth to an
 * average. Below it the figure stops grading the forecast and starts grading
 * how small the denominator happened to be — one article that moved four units
 * would outvote a thousand good ones for ever.
 *
 * The column keeps its true signed value: a single row has space for
 * -1,008,417%, and that figure is a finding about a discontinued product. It is
 * only the average across articles that cannot carry it.
 *
 * Used by the cards and by the column footers from one place, so the figure at
 * the top of the page and the one at the bottom of the table cannot drift.
 */
export const averageScore = (rows, key) => {
  const seen = new Map()
  for (const r of rows) {
    const v = r[key]
    if (v === null || v === undefined) continue
    const article = String(r['Item No.'] ?? '').trim() || String(r.Item ?? '').trim()
    if (!article || seen.has(article)) continue
    seen.set(article, Number(v))
  }
  if (!seen.size) return null
  let sum = 0
  for (const v of seen.values()) sum += Math.max(0, v)
  return { value: sum / seen.size, count: seen.size }
}

/**
 * The same average, weighted by how much of the article actually moved.
 *
 * Two numbers answering two different questions, which is why both are shown.
 * The plain average asks "how did the typical article do", and counts a
 * packaging item that ships forty units a quarter exactly as heavily as
 * sunflower oil. Weighted by volume it asks "how did the units we actually ship
 * do", which is the question an order is judged on.
 *
 * Measured over five backtested months the two read 56.7% and 81.6% on the same
 * forecast — a 25-point gap, all of it the long tail of tiny articles. Showing
 * one without the other invites a reader to draw the wrong conclusion from
 * whichever they happen to see.
 *
 * Deliberately the same rows and the same de-duplication as `averageScore`, so
 * the pair always covers exactly the same set of articles.
 */
export const weightedScore = (rows, key, weightKey) => {
  const seen = new Map()
  for (const r of rows) {
    const v = r[key]
    if (v === null || v === undefined) continue
    const article = String(r['Item No.'] ?? '').trim() || String(r.Item ?? '').trim()
    if (!article || seen.has(article)) continue
    seen.set(article, { score: Math.max(0, Number(v)), weight: Math.max(0, Number(r[weightKey]) || 0) })
  }
  let sum = 0
  let total = 0
  for (const { score, weight } of seen.values()) {
    sum += score * weight
    total += weight
  }
  // No volume at all is not a zero-accuracy answer, it is no answer.
  return total > 0 ? { value: sum / total, weight: total } : null
}
