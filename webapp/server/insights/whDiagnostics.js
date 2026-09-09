/**
 * Why the warehouse forecast misses, article by article.
 *
 * The operational pages answer "what do I need?"; this answers "why should I
 * believe it?" — and, where the answer is "you should not", which property of
 * the article is responsible.
 *
 * Every figure here is derived from the same two things the Stock Article page
 * uses: `constantsFor`, which is the six-month rate and the monthly detail
 * behind it, and the outbound copy for the window on screen. Nothing is
 * recomputed a second way, so a diagnosis cannot disagree with the number it is
 * diagnosing.
 *
 * The thresholds below are not invented. They come from measuring the whole
 * population on 6 Sep 2026, over 1,131 scored articles:
 *
 *   volatility of the monthly rate     share scoring 60% or better
 *     CV < 0.3   (steady)                       87%
 *     CV 0.3-0.6 (moderate)                     57%
 *     CV 0.6-1.0 (volatile)                     38%
 *     CV > 1.0   (erratic)                      30%
 *
 * That is the finding the whole page rests on: accuracy tracks how *stable* an
 * article's demand is, and barely tracks how much history it has (3-4 months
 * and 5-6 months both score 64%). Averaging six monthly ratios is a good method
 * for a steady article and the wrong method for a spiky one, and the current
 * forecast applies it to both.
 */
import * as cube from '../cube/query.js'
import { constantsFor, forecastFromConstants } from './whConstant.js'
import { classifyArticles, classifyOne, statusOf, summarise } from './whClassify.js'
import { shippingPatterns } from './whPatterns.js'
import { OTHER_BUCKET } from '../powerbi/warehouse.js'

/** Where the volatility bands sit — see the measurements in the file comment. */
const CV_STEADY = 0.3
const CV_VOLATILE = 0.6
const CV_ERRATIC = 1.0

/** Below this many units in the window, a percentage error is mostly noise. */
const THIN_VOLUME = 100

/** Fewer months than this and the mean is fitted to a couple of deliveries. */
const THIN_HISTORY = 3

/** Accuracy at or above this is treated as a forecast that worked. */
const GOOD = 0.6

const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)

/**
 * How unstable an article's monthly rate is, as a coefficient of variation.
 *
 * The rate, not the raw quantity: an article whose outbound doubles because the
 * brand sold twice as much is perfectly predictable, and dividing by sales is
 * what separates that from an article that genuinely jumps about.
 */
function volatility(detail) {
  const rates = detail.map((d) => d.constant)
  const m = mean(rates)
  if (!(m > 0) || rates.length < 2) return 0
  const sd = Math.sqrt(mean(rates.map((r) => (r - m) ** 2)))
  return sd / m
}

/**
 * The best score any forecast could get on an article that swings this much.
 *
 * A forecast landing exactly on the article's own average is still marked down
 * every month the article misses that average, and how far it misses is what
 * `cv` measures. Working the accuracy formula through for a swing of `cv` gives
 * 1 − 0.8cv / (1 + 0.4cv).
 *
 * Checked against the population on 8 Sep 2026: the typical article swings ±67%
 * and scored 58.9% when given a perfect knowledge of its own level, against
 * 57.7% predicted here. Close enough to publish.
 *
 * This is the number that separates "the forecast is wrong" from "the article
 * cannot be forecast", which is the only distinction this panel exists to make.
 */
const reachable = (cv) => (cv > 0 ? Math.max(0, 1 - (0.8 * cv) / (1 + 0.4 * cv)) : 1)

/**
 * One named reason, chosen in the order that matters to somebody acting on it.
 *
 * Ordered by what to do about it rather than by size: an article that stopped
 * shipping needs delisting whatever else is true of it, and saying "volatile
 * demand" about a discontinued line sends somebody to tune a forecast for a
 * product nobody sells any more.
 */
function diagnose(r) {
  if (r.dormant) {
    return {
      code: 'dormant',
      label: 'No recent history',
      detail:
        'The warehouse has not issued this article in the six months the rate is built from, so there is no rate and nothing is forecast for it. Its status says how long it has been quiet.',
    }
  }
  if (r.stopped) {
    return {
      code: 'stopped',
      label: 'Stopped shipping',
      detail: `Shipped in ${r.activeMonths} of the last six months but nothing in the last two. The rate still forecasts it.`,
    }
  }
  if (r.months < THIN_HISTORY) {
    return {
      code: 'thin-history',
      label: 'Too little history',
      detail: `${r.months} month${r.months === 1 ? '' : 's'} of deliveries. A mean of one or two months is fitted to single events.`,
    }
  }
  if (r.cv >= CV_ERRATIC) {
    return {
      code: 'erratic',
      label: 'Erratic demand',
      detail: `The monthly rate varies by ${Math.round(r.cv * 100)}% around its own average. Only 30% of articles this unstable forecast well.`,
    }
  }
  if (r.cv >= CV_VOLATILE) {
    return {
      code: 'volatile',
      label: 'Volatile demand',
      detail: `The monthly rate varies by ${Math.round(r.cv * 100)}% around its own average, which a six-month mean cannot follow.`,
    }
  }
  if (r.outbound > 0 && r.outbound < THIN_VOLUME) {
    return {
      code: 'low-volume',
      label: 'Low volume',
      detail: `${Math.round(r.outbound)} units moved. At this size a single case changes the percentage completely.`,
    }
  }
  if (r.spike) {
    return {
      code: 'spike',
      label: 'One month distorts the average',
      detail: `One month is ${r.spike.toFixed(1)}x the median of the others, and an unweighted mean carries it forward for six months.`,
    }
  }
  if (r.accuracy !== null && r.accuracy < GOOD) {
    return {
      code: 'drift',
      label: 'Demand has moved',
      detail:
        r.trend > 0
          ? 'Recent months run above the six-month average, so the rate lags the trend.'
          : 'Recent months run below the six-month average, so the rate is still carrying old demand.',
    }
  }
  return { code: 'ok', label: 'No issue found', detail: 'Forecast and outbound agree within the tolerance used here.' }
}

/**
 * Every article the warehouse has history for, scored and explained.
 *
 * One pass per brand, then merged on the article: the constants are per brand
 * and so is outbound, but a diagnosis is about the article.
 */
export async function warehouseDiagnostics(parts, { today = new Date() } = {}) {
  /*
   * Statuses are cut to the end of the window on screen, not to today.
   *
   * Every part of one request carries the same slicer, so the latest dateTo is
   * that window's end. Look at March and an article that went quiet in April is
   * Active, because in March it was.
   */
  const asAt =
    parts
      .map((p) => p.f?.dateTo)
      .filter(Boolean)
      .sort()
      .pop() ?? new Date(today).toISOString().slice(0, 10)

  const [names, recipeArticles, classes, patterns] = await Promise.all([
    cube.articleMaster().catch(() => new Map()),
    cube.recipeArticles().catch(() => new Set()),
    classifyArticles({ asAt }).catch(() => new Map()),
    shippingPatterns({ asAt }).catch(() => null),
  ])

  const merged = new Map()

  for (const { brand, f } of parts) {
    const code = brand.code ?? brand
    const [constants, forecasts, outbound] = await Promise.all([
      constantsFor(code, { today }).catch(() => new Map()),
      forecastFromConstants(code, f, { today }).catch(() => new Map()),
      cube.outboundByArticle(code, f).catch(() => null),
    ])

    for (const [article, held] of constants) {
      const forecast = forecasts.get(article) ?? 0
      const moved = outbound?.get(article) ?? null
      const row =
        merged.get(article) ??
        {
          article,
          forecast: 0,
          outbound: null,
          months: held.months,
          activeMonths: 0,
          cv: 0,
          trend: 0,
          spike: 0,
          stopped: false,
          brands: new Set(),
          series: [],
        }

      row.forecast += forecast
      if (moved !== null) row.outbound = (row.outbound ?? 0) + moved
      row.brands.add(code)

      /*
       * The shape figures come from whichever brand has the longest history.
       *
       * They describe the article's demand pattern, not one brand's share of
       * it, and averaging two brands' volatility would describe neither.
       */
      if (held.months >= row.months) {
        const detail = held.detail ?? []
        row.months = held.months
        row.activeMonths = detail.filter((d) => d.outbound > 0).length
        row.cv = volatility(detail)
        /*
         * The months themselves, so a reader can see the shape rather than
         * being told about it. "100 → 20 → 250 → 50" argues the case for
         * unpredictability better than any coefficient does.
         */
        row.series = detail.map((d) => ({ month: d.month, qty: d.outbound }))

        const recent = detail.slice(-2).map((d) => d.constant)
        const earlier = detail.slice(0, -2).map((d) => d.constant)
        const em = mean(earlier)
        row.trend = em > 0 ? mean(recent) / em - 1 : 0
        row.stopped = detail.length >= 3 && detail.slice(-2).every((d) => d.outbound === 0)

        const rates = [...detail.map((d) => d.constant)].sort((a, b) => a - b)
        const median = rates.length ? rates[Math.floor(rates.length / 2)] : 0
        const top = rates[rates.length - 1] ?? 0
        row.spike = median > 0 && top / median >= 3 ? top / median : 0
      }

      merged.set(article, row)
    }
  }

  /*
   * The articles that have gone quiet, which the loop above cannot see.
   *
   * `constantsFor` builds from the last six whole months and drops anything
   * with no delivery in them — so an article silent for seven months has no
   * rate, and until now had no row here either. That is exactly backwards for a
   * status ladder whose whole purpose is to find articles that have stopped:
   * the ones furthest down it were the ones missing.
   *
   * Added with no forecast and no outbound, so they are unscored by
   * construction and cannot move the accuracy figures. They are here to be
   * counted and listed, not to be graded.
   */
  for (const article of classes.keys()) {
    if (merged.has(article)) continue
    merged.set(article, {
      article,
      forecast: 0,
      outbound: null,
      months: 0,
      activeMonths: 0,
      cv: 0,
      trend: 0,
      spike: 0,
      stopped: false,
      brands: new Set(),
      series: [],
      dormant: true,
    })
  }

  const rows = []
  for (const r of merged.values()) {
    const o = r.outbound
    const measured = o !== null && o > 0
    // 1 − |Forecast − Actual| / MAX(Forecast, Actual) — the same expression the
    // pages use, so a diagnosis cannot disagree with the score it explains.
    const accuracy = measured && Math.max(o, r.forecast) > 0
      ? 1 - Math.abs(r.forecast - o) / Math.max(o, r.forecast)
      : null
    const known = names.get(r.article)
    const row = {
      ...r,
      name: known?.name || r.article,
      unit: known?.unit || '',
      recipe: recipeArticles.has(r.article),
      variance: measured ? r.forecast - o : null,
      errorPct: measured ? (r.forecast - o) / o : null,
      accuracy,
      // A Set does not survive JSON, and the page groups on this.
      brands: [...r.brands].sort().join(', '),
      avgMonthly: r.series.length ? mean(r.series.map((d) => d.qty)) : null,
      reachable: reachable(r.cv),
      // Never null: an article with no shipping record at all is "never
      // shipped", which is a status rather than the absence of one.
      classification: classes.get(r.article) ?? classifyOne(null, asAt),
    }
    row.issue = diagnose(row)
    rows.push(row)
  }

  /* ------------------------------------------------ the headline ---------- */
  const scored = rows.filter((r) => r.accuracy !== null)
  const totalForecast = scored.reduce((s, r) => s + r.forecast, 0)
  const totalOutbound = scored.reduce((s, r) => s + r.outbound, 0)

  const over = scored.filter((r) => r.errorPct > 0.1)
  const under = scored.filter((r) => r.errorPct < -0.1)

  const byIssue = new Map()
  for (const r of scored) {
    const held = byIssue.get(r.issue.code) ?? { code: r.issue.code, label: r.issue.label, count: 0, forecast: 0, outbound: 0 }
    held.count += 1
    held.forecast += r.forecast
    held.outbound += r.outbound
    byIssue.set(r.issue.code, held)
  }

  const band = (lo, hi) => scored.filter((r) => r.accuracy >= lo && r.accuracy < hi).length

  /*
   * Accuracy cut by the things that might explain it.
   *
   * Computed live rather than quoted from a one-off analysis, so the page keeps
   * agreeing with itself as the data moves — and so the claim "volatility is
   * what matters, history is not" can be checked on any window rather than
   * taken on trust.
   */
  const segment = (bands, pick) =>
    bands.map((b) => {
      const group = scored.filter((r) => {
        const v = pick(r)
        return v >= b.lo && v < b.hi
      })
      return {
        key: b.key,
        label: b.label,
        count: group.length,
        good: group.filter((r) => r.accuracy >= GOOD).length,
        share: group.length ? group.filter((r) => r.accuracy >= GOOD).length / group.length : null,
      }
    })

  const segments = {
    volatility: segment(
      [
        { key: 'steady', label: 'Steady · under ±30%', lo: 0, hi: CV_STEADY },
        { key: 'moderate', label: 'Moderate · ±30–60%', lo: CV_STEADY, hi: CV_VOLATILE },
        { key: 'volatile', label: 'Volatile · ±60–100%', lo: CV_VOLATILE, hi: CV_ERRATIC },
        { key: 'erratic', label: 'Erratic · over ±100%', lo: CV_ERRATIC, hi: Infinity },
      ],
      (r) => r.cv
    ),
    volume: segment(
      [
        { key: 'tiny', label: 'Under 100 units', lo: 0, hi: 100 },
        { key: 'small', label: '100 – 1,000', lo: 100, hi: 1000 },
        { key: 'mid', label: '1,000 – 10,000', lo: 1000, hi: 10000 },
        { key: 'large', label: 'Over 10,000', lo: 10000, hi: Infinity },
      ],
      (r) => r.outbound
    ),
    history: segment(
      [
        { key: 'thin', label: '1–2 months', lo: 1, hi: 3 },
        { key: 'some', label: '3–4 months', lo: 3, hi: 5 },
        { key: 'full', label: '5–6 months', lo: 5, hi: Infinity },
      ],
      (r) => r.months
    ),
    recipe: [
      {
        key: 'recipe',
        label: 'Recipe articles',
        count: scored.filter((r) => r.recipe).length,
        good: scored.filter((r) => r.recipe && r.accuracy >= GOOD).length,
        share: scored.filter((r) => r.recipe).length
          ? scored.filter((r) => r.recipe && r.accuracy >= GOOD).length /
            scored.filter((r) => r.recipe).length
          : null,
      },
      {
        key: 'non-recipe',
        label: 'Non-recipe articles',
        count: scored.filter((r) => !r.recipe).length,
        good: scored.filter((r) => !r.recipe && r.accuracy >= GOOD).length,
        share: scored.filter((r) => !r.recipe).length
          ? scored.filter((r) => !r.recipe && r.accuracy >= GOOD).length /
            scored.filter((r) => !r.recipe).length
          : null,
      },
    ],
  }
  const share = (list) => (scored.length ? list.length / scored.length : 0)

  /*
   * Which group each article belongs to, decided once here.
   *
   * The page lets a reader click any bar and see the articles behind it, and
   * that only stays honest if the bar and the list are cut by the same rule.
   * Computing the keys server-side means there is one definition of "volatile"
   * rather than one for the chart and another for the filter.
   */
  const keysFor = (r) => ({
    band:
      r.accuracy === null
        ? null
        : r.accuracy < 0.2
          ? 'under-20'
          : r.accuracy < 0.4
            ? '20-40'
            : r.accuracy < 0.6
              ? '40-60'
              : r.accuracy < 0.85
                ? '60-85'
                : '85-100',
    direction:
      r.errorPct === null ? null : r.errorPct > 0.1 ? 'over' : r.errorPct < -0.1 ? 'under' : 'close',
    volatility:
      r.cv < CV_STEADY
        ? 'steady'
        : r.cv < CV_VOLATILE
          ? 'moderate'
          : r.cv < CV_ERRATIC
            ? 'volatile'
            : 'erratic',
    volume:
      r.outbound === null
        ? null
        : r.outbound < 100
          ? 'tiny'
          : r.outbound < 1000
            ? 'small'
            : r.outbound < 10000
              ? 'mid'
              : 'large',
    history: r.months < 3 ? 'thin' : r.months < 5 ? 'some' : 'full',
    recipe: r.recipe ? 'recipe' : 'non-recipe',
    issue: r.issue?.code ?? null,
    status: r.classification?.status ?? null,
  })

  const shape = (r) => ({
    article: r.article,
    name: r.name,
    unit: r.unit,
    brands: r.brands,
    forecast: r.forecast,
    outbound: r.outbound,
    variance: r.variance,
    accuracy: r.accuracy,
    errorPct: r.errorPct,
    months: r.months,
    activeMonths: r.activeMonths,
    cv: r.cv,
    trend: r.trend,
    recipe: r.recipe,
    issue: r.issue,
    series: r.series,
    avgMonthly: r.avgMonthly,
    reachable: r.reachable,
    status: r.classification?.status ?? null,
    // Labelled here rather than on the page: one definition of what "Slow-Moving"
    // is called, so a rename cannot leave the table and the ladder disagreeing.
    statusLabel: statusOf(r.classification?.status)?.label ?? '—',
    statusTone: statusOf(r.classification?.status)?.tone ?? 'slate',
    daysIdle: r.classification?.daysIdle ?? null,
    lastShipped: r.classification?.lastShipped ?? null,
    thinEvidence: r.classification?.thinEvidence ?? false,
    keys: keysFor(r),
  })

  const top = (list, n = 15) => list.slice(0, n).map((r) => ({
    article: r.article,
    name: r.name,
    unit: r.unit,
    forecast: r.forecast,
    outbound: r.outbound,
    variance: r.variance,
    accuracy: r.accuracy,
    errorPct: r.errorPct,
    months: r.months,
    activeMonths: r.activeMonths,
    cv: r.cv,
    trend: r.trend,
    recipe: r.recipe,
    issue: r.issue,
  }))

  const stopped = rows.filter((r) => r.stopped)

  /*
   * Articles nobody could forecast well, and what they cost.
   *
   * `reachable` is the honest ceiling for each one, so the panel can say "these
   * score 22% and the best possible is 31%" — which is a statement about the
   * article, not about the method. `averageWithout` is the counterfactual the
   * reader actually wants: what the headline would be if these were planned by
   * a rule instead of a forecast.
   */
  const hard = scored.filter((r) => r.cv >= CV_VOLATILE)
  const rest = scored.filter((r) => r.cv < CV_VOLATILE)
  const avgAcc = (list) =>
    list.length ? list.reduce((s, r) => s + Math.max(0, r.accuracy), 0) / list.length : null

  const unpredictable = {
    count: hard.length,
    share: scored.length ? hard.length / scored.length : 0,
    averageAccuracy: avgAcc(hard),
    reachable: hard.length ? mean(hard.map((r) => r.reachable)) : null,
    forecast: hard.reduce((s, r) => s + r.forecast, 0),
    outbound: hard.reduce((s, r) => s + r.outbound, 0),
    unitsAtStake: hard.reduce((s, r) => s + Math.abs(r.variance ?? 0), 0),
    // What the typical article would score if these were set aside.
    averageWithout: avgAcc(rest),
    restCount: rest.length,
    threshold: CV_VOLATILE,
  }

  /*
   * What the target is actually up against.
   *
   * `reachable` per article, averaged the same way the accuracy card averages —
   * so this is, in the card's own units, the score a forecast would get if it
   * knew every article's true average and nothing else. It is not a prediction
   * of what we will achieve; it is the line above which no method of any kind
   * can go while these articles are the ones being scored.
   *
   * Cut three ways, because the difference between them is the whole argument:
   * the population decides the ceiling far more than the method does.
   */
  const median = (xs) => {
    if (!xs.length) return null
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  const activeScored = scored.filter((r) => r.classification?.status === 'active')
  const steadyScored = scored.filter((r) => r.cv < CV_STEADY)
  const avg = (list, pick) => (list.length ? mean(list.map(pick)) : null)

  const ceiling = {
    all: avg(scored, (r) => r.reachable),
    allCount: scored.length,
    active: avg(activeScored, (r) => r.reachable),
    activeCount: activeScored.length,
    steady: avg(steadyScored, (r) => r.reachable),
    steadyCount: steadyScored.length,
    typicalSwing: median(scored.map((r) => r.cv)),
    /*
     * The relationship itself, so the page can show why rather than assert it.
     * Same expression `reachable` uses, evaluated at readable swing values.
     */
    curve: [0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5].map((cv) => ({
      cv,
      best: reachable(cv),
    })),
    /** The swing an article must be under for 85% to be possible at all. */
    swingFor85: 0.2,
  }

  return {
    unpredictable,
    ceiling,
    patterns,
    /*
     * The five statuses with their counts, in ladder order.
     *
     * Carries each status's own definition and intended treatment alongside the
     * count, so the page, the guide and anything printed from them describe the
     * policy in the words `whClassify.js` holds rather than their own.
     */
    statuses: summarise(rows.map((r) => r.classification)),
    classifiedAt: asAt,
    summary: {
      articles: rows.length,
      scored: scored.length,
      unscored: rows.length - scored.length,
      totalForecast,
      totalOutbound,
      totalVariance: totalForecast - totalOutbound,
      biasPct: totalOutbound > 0 ? (totalForecast - totalOutbound) / totalOutbound : null,
      overCount: over.length,
      overShare: share(over),
      underCount: under.length,
      underShare: share(under),
      closeShare: 1 - share(over) - share(under),
      lowAccuracy: scored.filter((r) => r.accuracy < 0.4).length,
      goodShare: share(scored.filter((r) => r.accuracy >= GOOD)),
      // The average article, floored per article exactly as the cards do it, so
      // this page cannot report a different headline from the pages it explains.
      averageAccuracy: scored.length
        ? scored.reduce((s, r) => s + Math.max(0, r.accuracy), 0) / scored.length
        : null,
      bands: [
        { key: 'under-20', label: 'Under 20%', count: band(-Infinity, 0.2) },
        { key: '20-40', label: '20–40%', count: band(0.2, 0.4) },
        { key: '40-60', label: '40–60%', count: band(0.4, 0.6) },
        { key: '60-85', label: '60–85%', count: band(0.6, 0.85) },
        { key: '85-100', label: '85–100%', count: band(0.85, Infinity) },
      ],
      stoppedCount: stopped.length,
      stoppedForecast: stopped.reduce((s, r) => s + r.forecast, 0),
    },
    /*
     * Every article, so the page can filter without asking again.
     *
     * About sixteen hundred small rows. Sending them once is far cheaper than a
     * round trip per click, and a selection then responds instantly rather than
     * putting a spinner over a chart somebody is still reading.
     */
    articles: rows.map(shape),
    segments,
    issues: [...byIssue.values()].sort((a, b) => b.count - a.count),
    /*
     * Ranked by the size of the miss, not by the percentage.
     *
     * A 40,000-unit over-forecast on one article costs more than a hundred
     * articles that are 20% out on a handful of units, and a page meant to be
     * acted on should put the expensive problems first.
     */
    overForecast: top([...scored].filter((r) => r.variance > 0).sort((a, b) => b.variance - a.variance)),
    underForecast: top([...scored].filter((r) => r.variance < 0).sort((a, b) => a.variance - b.variance)),
    worstAccuracy: top([...scored].sort((a, b) => a.accuracy - b.accuracy)),
    mostVolatile: top([...scored].filter((r) => r.cv >= CV_VOLATILE).sort((a, b) => b.cv - a.cv)),
    thinHistory: top([...rows].filter((r) => r.months < THIN_HISTORY).sort((a, b) => b.forecast - a.forecast)),
    stopped: top([...stopped].sort((a, b) => b.forecast - a.forecast)),
    /*
     * One table of everything worth looking at, ranked by how many units the
     * miss is worth. A reader wants "which articles are causing this", not four
     * separate leaderboards to reconcile.
     */
    problems: top(
      [...scored]
        .filter((r) => r.accuracy < GOOD || Math.abs(r.errorPct ?? 0) > 0.25)
        .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance)),
      25
    ),
  }
}
