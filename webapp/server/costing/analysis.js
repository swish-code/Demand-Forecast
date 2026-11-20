/**
 * Monthly MC Analysis - the figures behind the Costing Department's page.
 * 19 Nov 2026.
 *
 * NOTHING HERE IS A NEW CALCULATION. Every number comes from the same place,
 * through the same functions, as the Variance Analysis page's MC view:
 *
 *   MC theoretical, actual    `oracleConsumptionTrend` - MC's Consumption Qty
 *                             per article per brand per month, catering's
 *                             theoretical excluded (CATERING_BRANCHES), exactly
 *                             the call that page makes for its monthly table.
 *   Variance %                `variancePct(actual, theoretical)` =
 *                             (actual - theoretical) / theoretical; null when
 *                             the theoretical is 0 or missing.
 *   Accuracy %                `mcScore(theoretical, actual)` =
 *                             1 - |actual - theoretical| / larger of the two,
 *                             the page's "MC Match %" - only for rows whose
 *                             `mcStatus` is Match or Variance, as on that page.
 *
 * MONTHS ARE CALENDAR MONTHS (asked for on 19 Nov 2026): Current = the month
 * selected (today's month by default), Previous = the one before it. MC loads
 * a month once it closes, so the current month is usually empty; a month MC
 * holds no row for is shown as missing - never as zero.
 *
 * GRAIN: one row per article per brand, as on the Variance page. The
 * classification belongs to the article and is the same on every brand row.
 */
import { executeQuery } from '../powerbi/client.js'
import { config } from '../config.js'
import { cached } from '../cache.js'
import {
  canonArticle,
  CATERING_BRANCHES,
  mcScore,
  mcStatus,
  oracleConsumptionTrend,
  variancePct,
} from '../powerbi/consumption.js'

const TTL = 3600

const val = (r, name) => {
  const want = String(name).toLowerCase()
  for (const key of Object.keys(r)) {
    const bare = key.replace(/^.*\[/, '').replace(/\]$/, '').toLowerCase()
    if (bare === want) return r[key]
  }
  return undefined
}

/* -------------------------------------------------------------- months -- */

const monthOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`

/** 'YYYY-MM-01' for a valid month string, else null. */
export function cleanMonth(m) {
  const s = String(m ?? '').slice(0, 7)
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? `${s}-01` : null
}

/** The month before a 'YYYY-MM-01'. */
export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number)
  // Month index m - 2: m is 1-based, and we want the month before it.
  return monthOf(new Date(Date.UTC(y, m - 2, 1)))
}

/** Current and previous month for a selection (or for today). */
export function monthPair(selected, now = new Date()) {
  const current = cleanMonth(selected) ?? monthOf(new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)))
  return { current, previous: previousMonth(current) }
}

/* ----------------------------------------------------- source lookups -- */

/** Article number -> MC's own name for it. */
export function mcArticleNames() {
  const fm = config.salesOnly?.find((b) => b.code === 'FM')
  return cached(
    'costing:mc-names',
    async () => {
      if (!fm?.datasetId) return new Map()
      const rows = await executeQuery(
        `EVALUATE SUMMARIZECOLUMNS('Consumption Qty'[ART_NUMMER], 'Consumption Qty'[ART_NAME])`,
        fm.datasetId,
        { bulk: true, workspace: fm.workspaceId || undefined }
      )
      const out = new Map()
      for (const r of rows) {
        const a = canonArticle(val(r, 'ART_NUMMER'))
        const n = String(val(r, 'ART_NAME') ?? '').trim()
        if (a && n && !out.has(a)) out.set(a, n)
      }
      return out
    },
    { seconds: TTL }
  )
}

/**
 * Every article number in Recipe File SWiSH.
 *
 * Read from 'RECIPE TABLE', which every brand model loads straight from that
 * file (RECIPIE FILE SWISH.xlsx, table FULL_BREAKDOWN_RECIPIE) and which is
 * company-wide - identical in every model - so one model answers for all.
 * An article on ANY recipe line, at any level, is in the file. PREP lines carry
 * no article number and are not articles.
 */
export function recipeArticles() {
  const brand = config.brands[0]
  return cached(
    'costing:recipe-articles',
    async () => {
      const rows = await executeQuery(
        `EVALUATE DISTINCT(SELECTCOLUMNS('RECIPE TABLE', "art", 'RECIPE TABLE'[Item No.]))`,
        brand.datasetId,
        { bulk: true, workspace: brand.workspaceId || undefined }
      )
      const out = new Set()
      for (const r of rows) {
        const a = canonArticle(val(r, 'art'))
        if (a) out.add(a)
      }
      if (out.size === 0) throw new Error('Recipe File SWiSH returned no article numbers')
      return out
    },
    { seconds: TTL }
  )
}

/* ----------------------------------------------------------- the rows -- */

/** One month's figures for one article-brand, by the Variance page's rules. */
export function monthFigures(held) {
  if (!held) return { theoretical: null, actual: null, accuracy: null, variancePct: null, status: 'Missing Data' }
  const t = held.potential
  const a = held.consumption
  const status = mcStatus(t, a)
  return {
    theoretical: t,
    actual: a,
    accuracy: status === 'Match' || status === 'Variance' ? mcScore(t, a) : null,
    variancePct: variancePct(a, t),
    status,
  }
}

/**
 * The page's rows. Pure, so it can be tested without Power BI or Snowflake.
 *
 *   series      Map('<article>|<BRAND>' -> Map('<YYYY-MM-01>' -> {consumption, potential}))
 *   names       Map(article -> name)
 *   recipe      Set(article) - Recipe File SWiSH
 *   overrides   Map(article -> stored classification row)
 *   months      { current, previous }
 *   brands      Set of brand codes this account may see, or null for all
 */
export function buildRows({ series, names, recipe, overrides, months, brands = null }) {
  const out = []
  for (const [key, byMonth] of series) {
    const cut = key.lastIndexOf('|')
    const article = key.slice(0, cut)
    const brand = key.slice(cut + 1)
    if (brands && !brands.has(brand)) continue
    const cur = byMonth.get(months.current)
    const prev = byMonth.get(months.previous)
    // An article MC holds nothing for in either month is not part of this page.
    if (!cur && !prev) continue

    const initial = recipe.has(article) ? 'Recipe' : 'Non-Recipe'
    const stored = overrides.get(article)
    const overridden = Boolean(stored?.overridden)
    out.push({
      key,
      articleId: article,
      articleName: names.get(article) ?? stored?.articleName ?? article,
      brand,
      initialClassification: initial,
      classification: overridden ? stored.current : initial,
      overridden,
      version: stored?.version ?? 0,
      lastUpdatedBy: stored?.updatedBy ?? null,
      lastUpdatedByName: stored?.updatedByName ?? stored?.updatedBy ?? null,
      lastUpdatedAt: stored?.updatedAt ?? null,
      current: monthFigures(cur),
      previous: monthFigures(prev),
    })
  }
  return out.sort(
    (a, b) =>
      a.brand.localeCompare(b.brand) ||
      Math.abs(b.current.variancePct ?? b.previous.variancePct ?? 0) -
        Math.abs(a.current.variancePct ?? a.previous.variancePct ?? 0)
  )
}

/** Everything the page and the alert job need, from the live sources. */
export async function loadAnalysis({ month, brands = null, overrides }) {
  const months = monthPair(month)
  const [trend, names, recipe] = await Promise.all([
    oracleConsumptionTrend({ brands: brands ? [...brands] : null, noTheoreticalFrom: CATERING_BRANCHES }),
    mcArticleNames(),
    recipeArticles(),
  ])
  if (!trend) {
    const err = new Error('MC consumption could not be read from the FM Sales model. Try again in a moment.')
    err.status = 503
    throw err
  }
  return {
    months,
    available: trend.months,
    rows: buildRows({ series: trend.series, names, recipe, overrides, months, brands }),
  }
}

/* ------------------------------------------------------------ alerts -- */

export const ALERT_THRESHOLD = 0.2

/**
 * Article-brand-months whose |variance %| is above the threshold.
 *
 * Only where MC holds a theoretical above zero: variance % has no denominator
 * otherwise, and the Variance page leaves it blank rather than inventing one.
 * Strictly greater than the threshold, in either direction.
 */
export function selectAlerts(rows, months, threshold = ALERT_THRESHOLD) {
  const out = []
  for (const r of rows) {
    for (const [slot, month] of [
      ['current', months.current],
      ['previous', months.previous],
    ]) {
      const f = r[slot]
      if (f.variancePct === null || !(f.theoretical > 0)) continue
      if (Math.abs(f.variancePct) <= threshold) continue
      out.push({
        articleId: r.articleId,
        articleName: r.articleName,
        brand: r.brand,
        month,
        theoretical: f.theoretical,
        actual: f.actual,
        variancePct: f.variancePct,
        threshold,
        classification: r.classification,
      })
    }
  }
  return out
}
