/*
 * What the Consumption page's visuals are FOLDED FROM - the arithmetic only.
 *
 * Separated from the drawings on 9 Nov 2026 for one reason: these decide what
 * the page claims - which months count as months, which articles count as high,
 * and in what order - and a `.jsx` module cannot be imported by `node --test`.
 * Logic that decides a claim should be checkable, so it lives here and the
 * charts import it. `consumptionInsights.jsx` re-exports every name, so nothing
 * else had to change.
 *
 * See that file for the colour reasoning; none of it is here.
 */

/**
 * Articles ranked by how far consumption ran from the recipe.
 *
 * Ranked on the ABSOLUTE variance, so an article 20,000 under is as prominent
 * as one 20,000 over - both are the same size of disagreement and the colour
 * says which direction it went.
 */
export function topVarianceArticles(rows, limit = 12) {
  return (rows ?? [])
    /*
     * Null is UNKNOWN, and `Number(null)` is 0 - which is finite, so a finite
     * check alone lets an unknown variance through as a zero bar labelled +0,
     * claiming the outlets matched the recipe exactly. The page filters these
     * rows out before it gets here, so this is a guard and not a fix; it is
     * cheap, and the page's whole argument is that a blank is not a zero.
     */
    .filter(
      (r) =>
        r.Consumption_Variance !== null &&
        r.Consumption_Variance !== undefined &&
        Number.isFinite(Number(r.Consumption_Variance))
    )
    .map((r) => ({
      article: String(r['Item No.'] ?? ''),
      name: String(r.Item ?? r['Item No.'] ?? ''),
      variance: Number(r.Consumption_Variance),
      pct: r.Consumption_Variance_Pct === null || r.Consumption_Variance_Pct === undefined
        ? null
        : Number(r.Consumption_Variance_Pct),
      theoretical: Number(r.Sys_Potential_COS) || 0,
      consumption: Number(r.Sys_Consumption) || 0,
      trend: Array.isArray(r.Variance_Trend) ? r.Variance_Trend : null,
    }))
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, limit)
}

/**
 * EVERY article, one row each, with a column per month - 10 Nov 2026.
 *
 * The Power BI view this replaces is a date across the top and an article down
 * the side; this is the same shape with the months aggregated, which is what
 * was asked for. Unlike `persistentVarianceArticles` it keeps ALL articles,
 * including the ones in agreement, because the brief is "lists all articles
 * grouped by brand" - the 6-of-6 narrowing is a toggle over this, not a
 * different fold.
 *
 * The month's variance is written under the month's own ISO key, so a column
 * can read it straight off the row and the set of columns follows the data
 * rather than being fixed in advance.
 *
 * A month the article has no row for is left UNDEFINED rather than zeroed. A
 * zero would say the outlets matched the recipe exactly that month, which is
 * the opposite of "Oracle recorded nothing"; the column renders it as a dash.
 */
export function monthlyVarianceByArticle(rows, months) {
  if (!months?.length) return []
  const wanted = new Set(months)
  const out = []

  for (const r of rows ?? []) {
    if (!Array.isArray(r.Variance_Trend)) continue

    const points = r.Variance_Trend.filter((p) => wanted.has(p.month))
    if (!points.length) continue

    const row = {
      key: `${r['Item No.']}|${r.CHAINID ?? ''}`,
      article: String(r['Item No.'] ?? ''),
      // Grouped on, so it needs a value that reads as a heading. The blank is
      // the KST MAP not resolving the outlet, which is a group of its own.
      brand: String(r.CHAINID ?? '') || '(unmapped)',
      name: String(r.Item ?? r['Item No.'] ?? ''),
      monthsSeen: points.length,
      monthsWindow: months.length,
      monthsHigh: 0,
      /*
       * How many of the months could be judged at all - 12 Nov 2026.
       *
       * "3 of 6" used to mean "high in 3 of the 6 months in the window", which
       * read as though the other three were fine. For an article MC holds no
       * theoretical for, none of the six can be judged, and the column now
       * says that instead of implying agreement.
       */
      monthsScored: 0,
      total: 0,
      /** Consumption over every month present - the other side of the pair. */
      consumptionTotal: 0,
      hasTheoretical: points.some((p) => p.pct !== null && p.pct !== undefined),
    }

    /*
     * THE SAME ROW CARRIES BOTH READINGS - 12 Nov 2026, on request.
     *
     * The table can be read as a quantity or as a percentage, and both come
     * off one fold rather than two: a second pass would be a second chance for
     * the two to disagree about which articles are in the table.
     *
     * The percentage columns are keyed `<month>__pct` so they cannot collide
     * with the quantity column for the same month - DataTable keys its hidden
     * set, its colgroup and its React children on the column key, and two
     * columns sharing one would fight over all three.
     */
    let theoretical = 0
    /*
     * The variance over the SAME months the denominator covers.
     *
     * NOT `row.total`, and the difference is the whole correctness of the
     * percentage. `row.total` is every month, including the ones MC holds no
     * theoretical for; `theoretical` can only sum the months that have one.
     * Dividing one by the other puts six months of quantity over one month of
     * theoretical.
     *
     * MEASURED, which is how this was caught. YP's sticker line carries no
     * theoretical in five of the six months and 892 in August. Summing all six
     * months' variance - 3,786,701 - over that 892 gave +424,518%, and the
     * same fault produced -17,215,825% on an unmapped article with a
     * theoretical of 4. Both are arithmetic, not findings.
     *
     * Matched month by month, the ratio answers the question actually being
     * asked: across the months MC could judge, how far did the outlets run?
     */
    let scoredVariance = 0

    for (const p of points) {
      const v = Number(p.variance) || 0
      const t = Number.isFinite(Number(p.theoretical)) ? Number(p.theoretical) : 0
      /*
       * FOUR FIELDS PER MONTH - 15 Nov 2026, on request.
       *
       * The table lays each month out as a group - MC theoretical,
       * consumption, variance, variance % - the way the PM table does, so
       * both sides have to be carried rather than only their difference.
       *
       * Consumption is the sum of the two by definition: the server builds
       * the variance as `consumption - theoretical`. Adding a third number to
       * every point of every article would be payload for an identity.
       *
       * Suffixed keys, because DataTable keys its hidden set, its colgroup and
       * its React children on the column key: the bare month stays the
       * variance, and the other three hang off it.
       */
      row[`${p.month}__theo`] = t
      row[`${p.month}__cons`] = v + t
      row[p.month] = v
      row[`${p.month}__pct`] = p.pct === null || p.pct === undefined ? null : Number(p.pct)
      row.total += v
      row.consumptionTotal += v + t
      if (t > 0) {
        theoretical += t
        scoredVariance += v
      }
      if (monthIsScored(p)) row.monthsScored += 1
      if (monthIsHigh(p)) row.monthsHigh += 1
    }

    row.totalTheoretical = theoretical
    /** The variance over the scored months alone - kept for the export. */
    row.scoredVariance = theoretical > 0 ? scoredVariance : null

    /*
     * THE SIX-MONTH PERCENTAGE IS THE MEAN OF THE MONTHLY ONES - 15 Nov 2026,
     * on request, replacing summed-variance-over-summed-theoretical.
     *
     *   (Apr% + Jun% + Sep% + Oct%) / 4
     *
     * EVERY VALID MONTH CARRIES EQUAL WEIGHT, which is the point of the
     * change: the previous figure was weighted by each month's theoretical, so
     * a heavy month decided the answer and a light month barely moved it. The
     * business asked for the plain average, where a month that ran 30% out
     * counts the same whether it was large or small.
     *
     * A month MC did not price is EXCLUDED, not counted as 0%. `__pct` is
     * already null for those - see the monthly fold above - so the filter is
     * the same rule the month columns show, and the two cannot drift apart.
     *
     * Null, never zero, when no month qualifies: zero would read as the
     * outlets having matched the recipe exactly.
     */
    const monthlyPcts = points
      .map((p) => (p.pct === null || p.pct === undefined ? null : Number(p.pct)))
      .filter((v) => v !== null && Number.isFinite(v))
    row.monthsInPct = monthlyPcts.length
    row.totalPct = monthlyPcts.length
      ? monthlyPcts.reduce((a, v) => a + v, 0) / monthlyPcts.length
      : null

    /*
     * "High in all 6 of the last 6" - the toggle's test.
     *
     * It demands the article was high in every month of the WINDOW, not merely
     * in every month it appears in. An article Oracle recorded for three
     * months is not an article that disagreed for six, and the toggle's label
     * says six.
     */
    row.everyMonth = row.monthsHigh === months.length
    out.push(row)
  }

  return out.sort(
    (a, b) => a.brand.localeCompare(b.brand) || Math.abs(b.total) - Math.abs(a.total)
  )
}

/**
 * The whole selection's variance, month by month.
 *
 * Summed over every article's own series rather than over the table's single
 * figure, because the series covers every month Oracle holds while the table
 * covers the window on screen. A month no article has a row for simply does not
 * appear - it is not drawn as a zero, which would claim perfect agreement.
 *
 * `only`, when given, is the set of months worth drawing - see `completeMonths`.
 */
export function monthlyVariance(rows, only = null) {
  const byMonth = new Map()
  for (const r of rows ?? []) {
    if (!Array.isArray(r.Variance_Trend)) continue
    for (const p of r.Variance_Trend) {
      if (only && !only.has(p.month)) continue
      const held = byMonth.get(p.month) ?? { month: p.month, variance: 0, theoretical: 0, articles: 0 }
      held.variance += Number(p.variance) || 0
      held.articles += 1
      byMonth.set(p.month, held)
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
}

/**
 * The months that are actually a month of data.
 *
 * MEASURED 9 NOV 2026, after the FM Sales Dashboard was republished.
 *
 * May 2026 arrived in the model that day carrying 1,710 article-brands against
 * roughly 8,500 in every other month, 172,285 of consumption against roughly
 * 17,000,000, and no theoretical whatsoever. Drawn as a month it reads as
 * consumption collapsing and every article's variance vanishing, which is a
 * partial load being reported as a finding.
 *
 * So a month qualifies on how many articles report in it, against the median
 * month - the one completeness test the client can run, because the trend
 * points carry a variance and not the two sides it came from. Counting rather
 * than naming the month means the next partial load drops out on its own.
 */
export function completeMonths(rows, { floor = 0.5 } = {}) {
  const counts = new Map()
  for (const r of rows ?? []) {
    if (!Array.isArray(r.Variance_Trend)) continue
    for (const p of r.Variance_Trend) counts.set(p.month, (counts.get(p.month) ?? 0) + 1)
  }
  if (!counts.size) return { months: [], partial: [] }

  const sorted = [...counts.values()].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  const months = []
  const partial = []
  for (const month of [...counts.keys()].sort()) {
    const share = median ? counts.get(month) / median : 0
    ;(share >= floor ? months : partial).push({ month, articles: counts.get(month), share })
  }
  return { months: months.map((m) => m.month), partial }
}

/**
 * Articles that ran from the recipe MONTH AFTER MONTH, not just once.
 *
 * Asked for on 9 Nov 2026: "articles that have high variance in the last 6
 * months (if available, if not until available along with how many months was
 * available)". So the window is the last `window` COMPLETE months, every row
 * says how many of them it actually appears in, and a month an article has no
 * row for is never counted as a month of agreement.
 *
 * The threshold is the Flag column's, reproduced here rather than read off the
 * row: the flag is stamped for the window on screen, and this asks the question
 * of each month separately. Beyond 1% of MC's theoretical and beyond half a
 * unit.
 *
 * A MONTH WITH NO THEORETICAL IS NOT HIGH - corrected 12 Nov 2026.
 *
 * It used to return true for those months, on the reasoning that "MC says
 * nothing and something was consumed" is not agreement. That is true, but it
 * is not disagreement either - it is an UNMEASURED month, and the same
 * reasoning was removed from `mcStatus` on 11 Nov when non-recipe articles
 * stopped being counted as variances. This function was missed, so the two
 * rules contradicted each other: the Status column called an article "No
 * theoretical" while the Months high column beside it called the same article
 * high in all six months.
 *
 * It mattered most for exactly the articles that can never be scored. YP's
 * packaging lines - stickers, gloves, bags, napkins - carry no MC theoretical
 * in ANY month, so every one of them scored 6 of 6 and filled the "High all 6"
 * worklist with articles nobody can act on.
 */
const FLOOR = 0.5
const TOLERANCE = 0.01

/** Can this month be judged at all? No theoretical, no judgement. */
const monthIsScored = (point) =>
  point?.pct !== null && point?.pct !== undefined && Number.isFinite(Number(point.pct))

const monthIsHigh = (point) => {
  if (!monthIsScored(point)) return false
  const v = Number(point?.variance)
  if (!Number.isFinite(v) || Math.abs(v) <= FLOOR) return false
  return Math.abs(Number(point.pct)) > TOLERANCE
}

export function persistentVarianceArticles(rows, months, { rank = 'persistence', limit = 25 } = {}) {
  if (!months?.length) return []
  const wanted = new Set(months)
  const out = []

  for (const r of rows ?? []) {
    if (!Array.isArray(r.Variance_Trend)) continue

    const points = r.Variance_Trend.filter((p) => wanted.has(p.month))
    if (!points.length) continue

    let monthsHigh = 0
    let over = 0
    let under = 0
    let variance = 0
    for (const p of points) {
      variance += Number(p.variance) || 0
      if (!monthIsHigh(p)) continue
      monthsHigh += 1
      if (Number(p.variance) > 0) over += 1
      else under += 1
    }
    if (!monthsHigh) continue

    out.push({
      key: `${r['Item No.']}|${r.CHAINID ?? ''}`,
      article: String(r['Item No.'] ?? ''),
      brand: String(r.CHAINID ?? ''),
      name: String(r.Item ?? r['Item No.'] ?? ''),
      monthsHigh,
      monthsSeen: points.length,
      monthsWindow: months.length,
      everyMonth: monthsHigh === points.length,
      /*
       * Whether Oracle has a theoretical to compare against at all.
       *
       * Where it has none every month counts as high by the no-denominator
       * rule, and the finding is "no recipe exists" rather than "the outlets
       * ran from the recipe" - napkins, tissue and gloves. Measured 9 Nov 2026:
       * 7,112 of 9,302 article-brands. The heatmap leaves them out, because a
       * share of nothing cannot be put on a scale of shares.
       */
      hasTheoretical: points.some((p) => p.pct !== null && p.pct !== undefined),
      variance,
      latest: Number(points[points.length - 1].variance) || 0,
      direction: over && under ? 'Mixed' : over ? 'Used more' : 'Used less',
      trend: points,
    })
  }

  /*
   * Two rankings, because they answer two questions and neither is "the" order.
   *
   *   persistence - how many months it happened in, then how big. The list's
   *                 order: "which articles do this every month".
   *   size        - the six-month total, then persistence. The overview's
   *                 order: "where is the quantity going".
   *
   * Both are over the PERIOD, which is the point - the page's table ranks by
   * the window on screen, so a steady six-month gap loses to one bad October.
   */
  out.sort((a, b) =>
    rank === 'size'
      ? Math.abs(b.variance) - Math.abs(a.variance) || b.monthsHigh - a.monthsHigh
      : b.monthsHigh - a.monthsHigh || Math.abs(b.variance) - Math.abs(a.variance)
  )
  return out.slice(0, limit)
}

/**
 * PM theoretical against MC theoretical, month by month - 15 Nov 2026.
 *
 * The PM view's answer to the MC view's monthly table. Same shape, same two
 * readings, and deliberately the same arithmetic: one fold carries both the
 * quantity and the percentage so the two cannot disagree about which articles
 * are in the table.
 *
 * It reads `Engine_Trend`, which the server pairs month for month - see
 * `engineTrendFor`. A month present on only one side is already absent from
 * that series, so nothing here has to decide what a missing side means.
 *
 * THE SIX-MONTH PERCENTAGE IS SUMMED OVER SUMMED, and over the MATCHED months
 * only - the same rule, and the same trap, as `monthlyVarianceByArticle`.
 * Dividing six months of difference by the months MC happens to have priced
 * produced +424,518% there; it would do the same here.
 */
export function engineVarianceByArticle(rows, months) {
  if (!months?.length) return []
  const wanted = new Set(months)
  const out = []

  for (const r of rows ?? []) {
    if (!Array.isArray(r.Engine_Trend)) continue
    const points = r.Engine_Trend.filter((p) => wanted.has(p.month) && p.diff !== null)
    if (!points.length) continue

    const row = {
      key: `${r['Item No.']}|${r.CHAINID ?? ''}`,
      article: String(r['Item No.'] ?? ''),
      brand: String(r.CHAINID ?? '') || '(unmapped)',
      name: String(r.Item ?? r['Item No.'] ?? ''),
      unit: r.Unit ?? 'Unknown',
      monthsWindow: months.length,
      monthsPaired: points.length,
      total: 0,
      pmTotal: 0,
      mcTotal: 0,
    }

    let mcScored = 0
    let diffScored = 0
    for (const p of points) {
      const diff = Number(p.diff) || 0
      /*
       * FOUR FIELDS PER MONTH - 15 Nov 2026, on request.
       *
       * The table shows each month as a group of columns - MC theoretical, PM
       * theoretical, variance, variance % - rather than one column per month
       * in whichever reading was toggled. So both sides are carried, not only
       * their difference.
       *
       * Suffixed keys, because DataTable keys its hidden set, its colgroup and
       * its React children on the column key: the bare month is the variance,
       * and the other three hang off it.
       */
      row[`${p.month}__mc`] = p.mc === null || p.mc === undefined ? null : Number(p.mc)
      row[`${p.month}__pm`] = p.pm === null || p.pm === undefined ? null : Number(p.pm)
      row[p.month] = diff
      row[`${p.month}__pct`] = p.pct === null || p.pct === undefined ? null : Number(p.pct)
      row.total += diff
      row.pmTotal += Number(p.pm) || 0
      row.mcTotal += Number(p.mc) || 0
      // Only the months MC priced can carry a percentage, and the numerator
      // has to cover exactly those months.
      if (Number(p.mc) > 0) {
        mcScored += Number(p.mc)
        diffScored += diff
      }
    }

    row.totalTheoretical = mcScored
    row.scoredVariance = mcScored > 0 ? diffScored : null

    /*
     * THE MEAN OF THE MONTHLY PERCENTAGES - 15 Nov 2026, on request.
     *
     * The same change as the MC table's, for the same reason and by the same
     * rule: every valid month carries equal weight, and a month MC did not
     * price is excluded rather than counted as 0%. `__pct` is already null for
     * those, so the filter matches exactly what the month columns show.
     *
     * Note this is NOT the `avg` field below. That one averages the QUANTITY
     * over the months both engines costed; this averages the PERCENTAGES over
     * the months MC priced. The two populations differ - a month MC priced at
     * nothing is in one and not the other - and so do the answers.
     */
    const monthlyPcts = points
      .map((p) => (p.pct === null || p.pct === undefined ? null : Number(p.pct)))
      .filter((v) => v !== null && Number.isFinite(v))
    row.monthsInPct = monthlyPcts.length
    row.totalPct = monthlyPcts.length
      ? monthlyPcts.reduce((a, v) => a + v, 0) / monthlyPcts.length
      : null
    /*
     * THE AVERAGE MONTHLY GAP - 15 Nov 2026, on request.
     *
     * "For six months variance, take average of 6 months variance, not sum."
     *
     * DIVIDED BY THE MONTHS THAT ACTUALLY HAVE A FIGURE, not by six. An
     * article the two engines both costed in two months has a two-month
     * average; dividing its gap by six would quietly scale it down by a third
     * and rank it below articles with less wrong with them. The months are not
     * missing data to be averaged over - they are months the comparison does
     * not exist for, and the Months paired column says which is which.
     *
     * The sum is KEPT as `total`. It is what the column footer adds up and
     * what the costing threshold reads, and losing it to make room for the
     * average would be trading one reading for another rather than adding one.
     */
    row.avg = points.length > 0 ? row.total / points.length : null
    out.push(row)
  }

  return out.sort(
    (a, b) => a.brand.localeCompare(b.brand) || Math.abs(b.total) - Math.abs(a.total)
  )
}

/**
 * The same comparison folded the other way: one row per MONTH - 15 Nov 2026.
 *
 * The per-article table answers "which articles disagree"; this answers "is
 * the gap steady, and which way". Six rows above a thousand, so the shape of
 * the thing is readable before anyone starts scrolling.
 *
 * MATCHED PAIRS ONLY, per month. An article with a PM figure and no MC figure
 * that month is left out of BOTH sums rather than added to one of them -
 * including it would inflate the variance by the whole of its PM quantity and
 * make the month look like a disagreement when it is a coverage difference.
 * `diff !== null` is exactly that test, already decided by the server.
 *
 * `articles` carries how many pairs each month's figures rest on, because six
 * months resting on wildly different counts is itself the finding sometimes.
 */
export function engineMonthlyTotals(rows, months) {
  if (!months?.length) return []
  const wanted = new Set(months)
  const byMonth = new Map()
  for (const m of months) byMonth.set(m, { month: m, pm: 0, mc: 0, articles: 0 })

  for (const r of rows ?? []) {
    if (!Array.isArray(r.Engine_Trend)) continue
    for (const p of r.Engine_Trend) {
      if (!wanted.has(p.month) || p.diff === null || p.diff === undefined) continue
      const held = byMonth.get(p.month)
      held.pm += Number(p.pm) || 0
      held.mc += Number(p.mc) || 0
      held.articles += 1
    }
  }

  const out = []
  for (const m of months) {
    const held = byMonth.get(m)
    // A month no article paired in is not a month of agreement; it is absent.
    if (!held.articles) continue
    const diff = held.pm - held.mc
    out.push({
      ...held,
      key: m,
      variance: diff,
      // Against MC, the side being checked. No denominator, no percentage.
      pct: held.mc > 0 ? diff / held.mc : null,
    })
  }
  return out
}

/**
 * MC's own two sides, folded one row per MONTH - 15 Nov 2026, on request.
 *
 * The MC tab's counterpart to `engineMonthlyTotals`: how much the outlets
 * actually consumed each month, against what MC's recipes said, for the whole
 * selection rather than article by article.
 *
 * CONSUMPTION IS RECONSTRUCTED, not carried. The trend points hold the
 * variance and the theoretical, and consumption is the sum of the two by
 * definition - `variance = consumption - theoretical` is how the server builds
 * them. Adding a third number to every point of every article would be a
 * payload cost for an identity.
 *
 * TWO PERCENTAGES, because one would mislead whichever way it was chosen:
 *
 *   `pct`        over everything. Honest about the whole month, and it runs
 *                high - roughly half MC's consumption is articles it holds no
 *                theoretical for, so their quantity lands in the numerator
 *                with nothing in the denominator.
 *   `pctPriced`  over the articles MC actually priced that month. This is the
 *                recipe question, and it is the one comparable with the MC
 *                Match % card.
 *
 * Both are offered rather than one being picked here, because they answer
 * different questions and the column hints say which is which.
 */
export function mcMonthlyTotals(rows, months) {
  if (!months?.length) return []
  const wanted = new Set(months)
  const byMonth = new Map()
  for (const m of months) {
    byMonth.set(m, {
      month: m,
      theoretical: 0,
      consumption: 0,
      articles: 0,
      theoreticalPriced: 0,
      consumptionPriced: 0,
      articlesPriced: 0,
    })
  }

  for (const r of rows ?? []) {
    if (!Array.isArray(r.Variance_Trend)) continue
    for (const p of r.Variance_Trend) {
      if (!wanted.has(p.month)) continue
      const held = byMonth.get(p.month)
      const variance = Number(p.variance) || 0
      const theoretical = Number(p.theoretical) || 0
      const consumption = variance + theoretical
      held.theoretical += theoretical
      held.consumption += consumption
      held.articles += 1
      if (theoretical > 0) {
        held.theoreticalPriced += theoretical
        held.consumptionPriced += consumption
        held.articlesPriced += 1
      }
    }
  }

  const out = []
  for (const m of months) {
    const held = byMonth.get(m)
    // A month no article reported in is absent, not a row of zeroes.
    if (!held.articles) continue
    const variance = held.consumption - held.theoretical
    const variancePriced = held.consumptionPriced - held.theoreticalPriced
    out.push({
      ...held,
      key: m,
      variance,
      // No denominator, no percentage - never a zero, which reads as agreement.
      pct: held.theoretical > 0 ? variance / held.theoretical : null,
      pctPriced:
        held.theoreticalPriced > 0 ? variancePriced / held.theoreticalPriced : null,
      variancePriced,
    })
  }
  return out
}
