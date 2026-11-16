/**
 * The outlets' own consumption, out of the FM Sales model.
 *
 * WHAT THIS TABLE IS
 *
 * `Consumption Qty` is seven monthly Oracle extracts appended into one table -
 * April to October 2026, 259,912 rows, 4,870 articles, 205 cost centres. Each
 * row is one article at one outlet for one month, and it carries three figures
 * that must not be confused with one another:
 *
 *   Potential COS QTY   Oracle's THEORETICAL consumption - its own recipe
 *                       explosion over sales. Stored NEGATIVE.
 *   CONSUMPTION         Oracle's ACTUAL consumption, reconciled from stock:
 *                       Opening + Transfers + Purchase - Closing + Usage.
 *                       It therefore carries waste, over-portioning and
 *                       shrinkage, which a theoretical figure cannot.
 *   the difference      what the business loses between the two.
 *
 * WHY BOTH ARE RETURNED
 *
 * The page compares OUR theoretical (QtyBU x actual product qty) against
 * Oracle's theoretical, because that is the only like-for-like pair - two
 * recipe engines answering the same question. Reading ours against CONSUMPTION
 * instead mixes a recipe fault and a waste problem into one number with no way
 * to tell them apart. Both are carried so the page can show the decomposition.
 *
 * SCOPE IS THE MAP, AND NOTHING ELSE
 *
 * `Brand` and `Branch` on that table are RELATED() lookups into `KST MAP`, a
 * 98-row table mapping Oracle's cost centres to CHAINID and LocationID. Of the
 * 205 cost centres in the data only those 98 resolve; staff meal canteens,
 * warehouses, head office, FM and Lovebird come back BLANK and are excluded
 * here by the brand filter. That is deliberate - see `KST MAP` itself.
 *
 * WHOLE MONTHS, ALWAYS
 *
 * The grain is a calendar month and nothing finer: Oracle produces one figure
 * per article per outlet per month and nothing in it says which day anything
 * moved. So a window is widened to the months it touches, and `months` says
 * which those are. A reader asking for 1-15 September gets September, and the
 * page says so rather than quietly comparing half a month of forecast against a
 * whole month of consumption.
 */
import { config } from '../config.js'
import { executeQuery } from './client.js'
import { cached } from '../cache.js'

const val = (r, k) => r[k] ?? r[`[${k}]`]

/** The FM Sales model, which is where the auxiliary tables live. */
const source = () => config.salesOnly?.find((b) => b.code === 'FM') ?? null

const lit = (v) => `"${String(v).replace(/"/g, '""')}"`

const daxDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}

/** The first of the month a date falls in, as ISO. */
export const monthStartOf = (iso) => `${String(iso).slice(0, 7)}-01`

/**
 * The brand key for a row Oracle has not mapped to one.
 *
 * `'Consumption Qty'[Brand]` comes from the hand-maintained KST MAP, and it does
 * not cover every outlet: measured 9 Nov 2026 over October, 4,073 article-rows
 * carry a blank brand - FM's own sites and the outlets left unresolved - and
 * they hold 11.7% of the table's consumption. The reads below used to filter
 * them out with `NOT ISBLANK`, which is why they had never appeared.
 *
 * A sentinel rather than an empty string, because the keys are `article|BRAND`
 * and `"100|"` is both ugly and ambiguous. The client is given a blank brand
 * cell, which is the honest answer: this row belongs to no brand we know.
 */
export const UNMAPPED_BRAND = '__UNMAPPED__'

/**
 * Branches whose THEORETICAL the Variance Analysis page ignores.
 *
 * 15 Nov 2026, on request: "Don't consider branch CAT, for MC theoretical for
 * any brands." CAT is catering - the KST MAP calls it Just Catering, MM-
 * Catering and Pattie-Pattie Catering - and only BUR, MM and PAT have one.
 *
 * THE THEORETICAL ONLY, which is what was asked and is worth being explicit
 * about: the consumption from these branches is STILL COUNTED. Measured over
 * October 2026 that is 33,749 units of consumption kept against 11,875 of
 * theoretical dropped - 0.2% and 0.1% of their sides - so the variance rises
 * by 11,875, a tenth of a per cent. A row filter would have removed both
 * sides; this removes one, deliberately.
 *
 * Passed in by the caller rather than applied here, so only the page that
 * asked for it gets it. Stock Article and Procurement read the same functions
 * and are unchanged.
 */
export const CATERING_BRANCHES = ['CAT']

/**
 * How close the two engines have to be before they count as agreeing.
 *
 * One per cent. Two independent recipe explosions over the same sales will not
 * land on the same figure to the gram - they round at different points and
 * Oracle rounds its own inputs to three decimals in SQL - so an exact-match
 * test would mark almost every article as disagreeing and say nothing.
 */
export const VARIANCE_TOLERANCE = 0.01

/**
 * Half a unit, below which a percentage says nothing.
 *
 * An article where Oracle recorded 0.4 and we say 0.9 is 125% out and it is
 * noise: both figures are a rounding away from each other in absolute terms.
 * The ratio test alone flags every one of those, which is how a tolerance
 * built only on percentages ends up being ignored.
 */
const VARIANCE_FLOOR = 0.5

/* ------------------------------------------- MC classification & scoring --
 *
 * Added 11 Nov 2026 for the Article-Level Variance Reconciliation brief.
 *
 * These four functions are the whole of the page's arithmetic and they are
 * pure, so every rule below is tested rather than inspected on screen. They
 * replace three rules that were wrong in ways that moved the headline:
 *
 *   1. An article with NO MC theoretical was flagged `Variance`. That is the
 *      definition of a non-recipe article, not a recipe failure - measured
 *      over October 2026, 1,048 article-brand pairs carrying 47.6% of the
 *      consumption quantity were being reported as recipe errors.
 *
 *   2. An article with NOTHING on either side scored `Match`, because the
 *      difference of two zeroes is inside the half-unit floor. 2,493 of the
 *      4,832 pairs - 51.6% - were empty rows counted as perfect agreement.
 *
 *   3. `plainWhScore` is unbounded below once a figure goes negative, and 991
 *      pairs carry net-negative consumption (reversals exceeding usage). A
 *      theoretical of 100 against a consumption of -50 scored -50%, which is
 *      not a percentage of anything.
 */

/**
 * Does MC hold a theoretical quantity for this article?
 *
 * RENAMED FROM `mcRecipeClass` - 12 Nov 2026, on request, and the rename is
 * the point rather than tidying.
 *
 * It returned 'Recipe' / 'Non-recipe', which claimed more than the test can
 * support. The test is `Potential COS QTY > 0` and nothing else. An article
 * with no theoretical is NOT thereby a non-recipe article - MC may simply not
 * have produced a figure for it this month, the recipe may be missing, the
 * article may be new. And an article WITH a theoretical is not proof of a
 * recipe either. Naming the output after a conclusion the data does not reach
 * is how a reader ends up investigating the wrong thing.
 *
 * So the values now say what was actually measured:
 *
 *   'Has theoretical'  MC holds a positive Potential COS QTY.
 *   'No theoretical'   It holds none, but something was consumed. Could be a
 *                      genuine non-recipe article, could be a gap in MC. The
 *                      column does not guess, and either way it is never
 *                      scored as a recipe failure.
 *   'Empty'            Neither side holds anything. The row exists because the
 *                      article is in the table; there is nothing to judge.
 *
 * Three values rather than two so `Empty` can be left out of the scored
 * population without being deleted from the data, which is what the brief
 * means by "preserve their underlying MC Consumption values and records".
 */
export function mcTheoreticalClass(theoretical, consumption) {
  const t = Number(theoretical)
  const c = Number(consumption)
  if (Number.isFinite(t) && t > 0) return 'Has theoretical'
  // No theoretical. Did anything move at all?
  if (Number.isFinite(c) && c !== 0) return 'No theoretical'
  return 'Empty'
}

/**
 * The symmetric agreement score, bounded 0-1.
 *
 *   1 - |a - b| / MAX(a, b)
 *
 * The brief's formula, with the two cases it names handled explicitly:
 *
 *   both zero     -> null, "Not Scored". A score of 100% for two figures that
 *                    do not exist is the single most misleading number this
 *                    page could print, and it was printing it for half the
 *                    rows.
 *   missing       -> null, "Missing Data". Never zero: an article the
 *                    warehouse has no record of has not been shipped badly,
 *                    it has not been measured.
 *
 * NEGATIVES ARE FLOORED AT ZERO, NOT PASSED THROUGH. A net reversal makes a
 * quantity negative, and the formula is only meaningful on magnitudes - with a
 * negative on one side the ratio exceeds 1 and the "percentage" goes below
 * zero. Flooring says "these do not agree at all", which is true and is the
 * least the score can mean. The quantities themselves are untouched; only the
 * score is bounded.
 */
export function mcScore(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null
  const x = Number(a)
  const y = Number(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const worst = Math.max(x, y)
  // Both zero, or both negative: nothing to score against.
  if (worst <= 0) return null
  const score = 1 - Math.abs(x - y) / worst
  return score < 0 ? 0 : score
}

/**
 * The signed variance percentage, against the side being checked.
 *
 * Null rather than zero where the denominator is absent: a percentage of
 * nothing is not a percentage, and the brief is explicit that a missing value
 * is Missing Data rather than a zero.
 */
export function variancePct(measured, baseline) {
  if (measured === null || measured === undefined) return null
  if (baseline === null || baseline === undefined) return null
  const m = Number(measured)
  const b = Number(baseline)
  if (!Number.isFinite(m) || !Number.isFinite(b) || b <= 0) return null
  return (m - b) / b
}

/**
 * The MC status a row carries, which is what every KPI counts on.
 *
 * One field, so the page never re-derives the rule and the table can sort and
 * export it. The order of the tests is the rule:
 *
 *   'Missing Data'    a side is absent entirely.
 *   'Not Scored'      both sides are zero - the row exists, nothing happened.
 *   'No theoretical'  consumed, with no MC theoretical. NOT a variance, and
 *                     deliberately NOT called "non-recipe": the test cannot
 *                     tell a genuine non-recipe article from a gap in MC.
 *   'Data Exception'  the caller independently knows MC treats this as a
 *                     recipe article, yet MC holds no theoretical while
 *                     consumption moved. Surfaced for investigation rather
 *                     than scored. It cannot arise from the classifier above,
 *                     only from a caller passing that knowledge in, which is
 *                     why the parameter is optional.
 *   'Match'           inside the half-unit floor or the 1% tolerance.
 *   'Variance'        a real recipe disagreement, which is the only thing the
 *                     flagged count should ever contain.
 */
export function mcStatus(theoretical, consumption, { knownRecipe = null } = {}) {
  if (theoretical === null || theoretical === undefined) return 'Missing Data'
  if (consumption === null || consumption === undefined) return 'Missing Data'
  const t = Number(theoretical)
  const c = Number(consumption)
  if (!Number.isFinite(t) || !Number.isFinite(c)) return 'Missing Data'

  const klass = mcTheoreticalClass(t, c)
  if (klass === 'Empty') return 'Not Scored'
  if (klass === 'No theoretical') {
    // An article the caller independently knows to be a recipe article has no
    // business lacking a theoretical. Surfaced, never scored.
    return knownRecipe ? 'Data Exception' : 'No theoretical'
  }

  const diff = c - t
  if (Math.abs(diff) <= VARIANCE_FLOOR) return 'Match'
  return Math.abs(diff) / t <= VARIANCE_TOLERANCE ? 'Match' : 'Variance'
}

/** Is this status one that belongs in a recipe accuracy figure? */
export const isScored = (status) => status === 'Match' || status === 'Variance'

/**
 * Does this article's disagreement deserve attention?
 *
 * Returns 'Variance', 'Match', or null where there is nothing to compare.
 *
 * WHAT IS BEING COMPARED CHANGED ON 9 NOV 2026, ON REQUEST.
 *
 * It used to score OUR theoretical against Oracle's - a question about whether
 * the two recipe explosions agree. The page now scores Oracle's ACTUAL
 * consumption against Oracle's OWN theoretical, which is a question about the
 * outlets rather than about recipes, and is the one the business actually
 * asked. The arithmetic is unchanged; only the two figures handed in are.
 *
 * One consequence worth knowing: both figures now come from Oracle, so neither
 * can be missing and the null case below effectively stops arising on this
 * page. It is kept because the function is generic and the null rule is still
 * right - a figure that does not exist is unmeasured, not a miss.
 *
 * Null rather than 'Variance' when the measured side has no figure at all: an
 * article with nothing on that side has no quantity to compare, and calling
 * that a disagreement would report coverage as if it were accuracy.
 *
 * NOW A VIEW OF `mcStatus` - 11 Nov 2026.
 *
 * It kept its own copy of the threshold rule and the two drifted: this said
 * `Variance` for an article with no theoretical, which is a non-recipe article
 * and not a disagreement, and `Match` for an article with nothing on either
 * side. Both are the brief's explicit cases. Rather than fix the rule twice,
 * the flag is now derived from the status, so the slicer, the flagged count
 * and the status column cannot disagree about what a variance is.
 *
 * Only the two scored statuses map to a flag. Everything else - Non-recipe,
 * Not Scored, Missing Data, Data Exception - is null, which the slicer already
 * treats as "the question does not arise here" and never returns.
 */
export function varianceFlag(ours, theirs) {
  const status = mcStatus(theirs, ours)
  return isScored(status) ? status : null
}

/**
 * One article number, written one way.
 *
 * `ART_NUMMER` is text in Oracle and `'RECIPE TABLE'[Item No.]` is an integer
 * in the semantic models, so "0102000003" and "102000003" are one article
 * written two ways. `recipeMasterArticles` holds BOTH forms because it is a
 * membership test; this is a sum, and holding both would split one article's
 * quantity across two keys or double it, depending on which spelling each side
 * used. So every number collapses to its canonical form on the way in, and
 * every lookup collapses the same way - measured, this is what takes the
 * article join to 1,871 of the master's 1,889 articles.
 */
export function canonArticle(article) {
  const raw = String(article ?? '').trim()
  if (!raw) return ''
  const n = Number(raw)
  return Number.isFinite(n) ? String(n) : raw
}

/**
 * The same figures a month at a time, for the trend.
 *
 * ALL MONTHS THE TABLE HOLDS, NOT THE PAGE'S WINDOW - 9 Nov 2026, on request.
 *
 * A trend cannot be drawn inside the selected range: the page is usually set to
 * one month, and one month is one point. So this deliberately ignores the date
 * filter and reads every month `'Consumption Qty'` carries, which is what makes
 * "is this article getting worse" answerable at all.
 *
 * Brand IS honoured, because an article's variance in one brand says nothing
 * about the same article in another.
 *
 *   series  Map('<article>|<BRAND>' -> Map('<YYYY-MM-01>' -> { consumption, potential }))
 *   byMonth Map('<article>'         -> Map('<YYYY-MM-01>' -> { consumption, potential }))
 *   months  every month present, ascending
 *
 * Cached apart from the window read: its key has no dates in it, so one fetch
 * serves every date the reader moves the page to.
 */
export async function oracleConsumptionTrend({
  brands = null,
  includeUnmapped = false,
  noTheoreticalFrom = [],
} = {}) {
  const fm = source()
  if (!fm?.datasetId) return null

  const wanted = (brands ?? []).map((b) => String(b).trim().toUpperCase()).filter(Boolean).sort()

  const noTheo = [...new Set(
    (noTheoreticalFrom ?? []).map((b) => String(b).trim().toUpperCase()).filter(Boolean)
  )].sort()

  return cached(
    `consumption-trend:${wanted.join(',') || 'all'}:${includeUnmapped ? 'withUnmapped' : 'mappedOnly'}` +
      `:noTheo=${noTheo.join('+') || 'none'}`,
    async () => {
      /*
       * `includeUnmapped` also admits the rows whose Brand the KST MAP never
       * set. Without it the filter is exactly the old one, so a caller asking
       * for a brand's own figures sees no change.
       */
      const brandTest = wanted.length
        ? `'Consumption Qty'[Brand] IN {${wanted.map(lit).join(', ')}}`
        : `NOT ISBLANK('Consumption Qty'[Brand])`
      const orBlank = includeUnmapped ? ` || ISBLANK('Consumption Qty'[Brand])` : ''
      const brandFilter = `\n  FILTER(ALL('Consumption Qty'[Brand]), ${brandTest}${orBlank}),`

      /*
       * THE EXCLUDED BRANCHES COME BACK AS A SECOND MEASURE - 15 Nov 2026.
       *
       * The page ignores catering's THEORETICAL while keeping its consumption,
       * and this query has no Branch in its grouping - adding one would turn
       * 9,460 article-brand-months into roughly 243,000 article-brand-branch-
       * months to be folded straight back up.
       *
       * So the branch's own theoretical is asked for alongside, as its own
       * column, and subtracted below. One query, exact, and the result is the
       * same figure the window read produces by skipping those rows - which is
       * what lets the monthly table and the cards above it agree.
       */
      const potExcluded = noTheo.length
        ? `,
  "potExcl", CALCULATE(SUM('Consumption Qty'[Potential COS QTY]),
` +
          `    FILTER(ALL('Consumption Qty'[Branch]), ` +
          `'Consumption Qty'[Branch] IN {${noTheo.map(lit).join(', ')}}))`
        : ''

      const dax = `EVALUATE
SUMMARIZECOLUMNS(
  'Consumption Qty'[ART_NUMMER],
  'Consumption Qty'[Brand],
  'Consumption Qty'[Month_Start],${brandFilter}
  "cons", SUM('Consumption Qty'[CONSUMPTION]),
  "pot", SUM('Consumption Qty'[Potential COS QTY])${potExcluded}
)`

      const rows = await executeQuery(dax, fm.datasetId, {
        bulk: true,
        workspace: fm.workspaceId || undefined,
      }).catch((err) => {
        console.warn(`  [consumption-trend] read failed: ${String(err.message).slice(0, 90)}`)
        return null
      })
      if (!rows) return null

      const series = new Map()
      const byMonth = new Map()
      const monthSet = new Set()
      const add = (map, k, month, cons, pot) => {
        let inner = map.get(k)
        if (!inner) {
          inner = new Map()
          map.set(k, inner)
        }
        const held = inner.get(month) ?? { consumption: 0, potential: 0 }
        held.consumption += cons
        held.potential += pot
        inner.set(month, held)
      }

      for (const r of rows) {
        const article = canonArticle(val(r, 'ART_NUMMER'))
        if (!article) continue
        const raw = String(val(r, 'Brand') ?? '').trim().toUpperCase()
        // A blank brand is a real row whose owner is unknown, not a bad row. It
        // is dropped only when the caller did not ask for those.
        if (!raw && !includeUnmapped) continue
        const brand = raw || UNMAPPED_BRAND
        const month = monthStartOf(String(val(r, 'Month_Start') ?? '').slice(0, 10))
        if (!/^\d{4}-\d{2}-01$/.test(month)) continue
        const cons = Number(val(r, 'cons')) || 0
        // Negated for the same reason as the window read above - see the note
        // there on reversals. The two must agree or the trend's last point
        // would not match the table's figure.
        const rawPot = -(Number(val(r, 'pot')) || 0)
        /*
         * The excluded branches' theoretical, taken back off - 15 Nov 2026.
         *
         * Negated the same way as `pot` above, so the subtraction is between
         * two figures of the same sign convention. Without the second negation
         * an excluded branch would be ADDED rather than removed, which is the
         * kind of sign error that reads as a plausible number.
         *
         * Absent when nothing is excluded, and `|| 0` then leaves `pot`
         * exactly as it was.
         */
        const potExcl = -(Number(val(r, 'potExcl')) || 0)
        const pot = rawPot - potExcl
        monthSet.add(month)
        add(series, `${article}|${brand}`, month, cons, pot)
        add(byMonth, article, month, cons, pot)
      }

      const months = [...monthSet].sort()
      console.log(
        `  [consumption-trend] ${wanted.length ? `(${wanted.join(',')}) ` : ''}` +
          `${series.size} article-brands over ${months.length} month(s)` +
          `${months.length ? ` ${months[0]}..${months[months.length - 1]}` : ''}`
      )
      return { series, byMonth, months }
    },
    { seconds: 600 }
  )
}

/**
 * Consumption for a window, by article and by article x brand.
 *
 * Returns null when the model cannot be reached - null meaning "unknown", so
 * the caller leaves the columns blank rather than asserting an article was
 * never consumed.
 *
 *   byKey       Map('<article>|<BRAND>'        -> { consumption, potential })
 *   byArticle   Map('<article>'                -> { consumption, potential })
 *   names       Map('<article>'                -> Oracle's own ART_NAME)
 *   months      the calendar months actually covered, ISO month starts
 *   partial     true when the caller's window is not whole calendar months
 *   byBranch    Map('<article>|<BRAND>|<CODE>' -> { consumption, potential })
 *   branchNames Map('<BRAND>|<CODE>'           -> the outlet's KST_NAME)
 *   unplaced    { consumption, potential, rows } for outlets the KST MAP does
 *               not place - the amount by which branch rows fall short of the
 *               brand total, stated rather than left to be discovered
 *
 * The branch code is the Product Mix LocationID. A branch is identified by
 * BRAND AND CODE together, never code alone - the codes repeat across brands.
 *
 * `byArticle` is summed over EXACTLY the brands this request asked for, so a
 * single-brand page cannot accidentally be compared against all nine.
 */
export async function oracleConsumptionByArticle({
  from,
  to,
  brands = null,
  includeUnmapped = false,
  noTheoreticalFrom = [],
} = {}) {
  const fm = source()
  if (!fm?.datasetId || !from || !to) return null

  const wanted = (brands ?? []).map((b) => String(b).trim().toUpperCase()).filter(Boolean).sort()
  const firstMonth = monthStartOf(from)
  const lastMonth = monthStartOf(to)
  /*
   * Was the caller asking for whole months?
   *
   * The window starts on a first and ends on a month end. Anything else is a
   * partial window, which the page has to say out loud: the consumption side
   * cannot be cut finer than a month, so a part-month request is being answered
   * with more consumption than the forecast beside it covers.
   */
  const endsMonth = (() => {
    const [y, m, d] = String(to).slice(0, 10).split('-').map(Number)
    return d === new Date(Date.UTC(y, m, 0)).getUTCDate()
  })()
  const partial = !(String(from).slice(8, 10) === '01' && endsMonth)

  /*
   * Branch codes whose theoretical is ignored, upper-cased and sorted so the
   * cache key is stable however the caller wrote them. IN THE KEY, because two
   * callers asking with and without the exclusion want different answers and a
   * shared entry would serve one of them the other's.
   */
  const noTheo = new Set(
    (noTheoreticalFrom ?? []).map((b) => String(b).trim().toUpperCase()).filter(Boolean)
  )

  const key =
    `consumption:${firstMonth}:${lastMonth}:${wanted.join(',') || 'all'}` +
    `:${includeUnmapped ? 'withUnmapped' : 'mappedOnly'}` +
    `:noTheo=${[...noTheo].sort().join('+') || 'none'}`

  return cached(
    key,
    async () => {
      /*
       * `includeUnmapped` also admits the rows whose Brand the KST MAP never
       * set. Without it the filter is exactly the old one, so a caller asking
       * for a brand's own figures sees no change.
       */
      const brandTest = wanted.length
        ? `'Consumption Qty'[Brand] IN {${wanted.map(lit).join(', ')}}`
        : `NOT ISBLANK('Consumption Qty'[Brand])`
      const orBlank = includeUnmapped ? ` || ISBLANK('Consumption Qty'[Brand])` : ''
      const brandFilter = `\n  FILTER(ALL('Consumption Qty'[Brand]), ${brandTest}${orBlank}),`

      /*
       * ART_NAME joins the grouping so an article Oracle consumes but no recipe
       * names can still be shown by name rather than by number alone. Grouping
       * on it can split one article into two rows where the source spells the
       * name two ways; `add` below sums them, so the quantities are unaffected
       * and only the first spelling is kept.
       */
      /*
       * BRANCH JOINS THE GROUPING - 10 Nov 2026, on request.
       *
       * `[Branch]` is the KST MAP's branch CODE and it is the same code the
       * Product Mix page slices on - `Forecast_Product_Table[LocationID]`.
       * Validated rather than assumed: every one of the 38 PM location codes
       * appears in MC, and MC's codes are the same three-letter forms (ARD,
       * SAD, MNF). `[KST_NAME]` comes too, because a code alone is not a
       * branch anybody recognises.
       *
       * THE CODES REPEAT ACROSS BRANDS - ARD is a branch of BBT, PAT, SS, SLC
       * and MM - so a branch is only ever identified by brand AND code. 75 of
       * 96 outlet names collide once normalised, which is exactly the wrong
       * match the request warned about.
       *
       * Adding the two columns multiplies the rows Power BI returns, but
       * `byKey` and `byArticle` are built by SUMMING, so every existing caller
       * - Stock Article, Procurement - sees figures identical to before. The
       * branch detail is additive.
       */
      const dax = `EVALUATE
SUMMARIZECOLUMNS(
  'Consumption Qty'[ART_NUMMER],
  'Consumption Qty'[ART_NAME],
  'Consumption Qty'[Brand],
  'Consumption Qty'[Branch],
  'Consumption Qty'[KST_NAME],${brandFilter}
  FILTER(
    ALL('Consumption Qty'[Month_Start]),
    'Consumption Qty'[Month_Start] >= ${daxDate(firstMonth)}
      && 'Consumption Qty'[Month_Start] <= ${daxDate(lastMonth)}
  ),
  "cons", SUM('Consumption Qty'[CONSUMPTION]),
  "pot", SUM('Consumption Qty'[Potential COS QTY])
)`

      const rows = await executeQuery(dax, fm.datasetId, {
        bulk: true,
        workspace: fm.workspaceId || undefined,
      }).catch((err) => {
        console.warn(`  [consumption] read failed: ${String(err.message).slice(0, 90)}`)
        return null
      })
      if (!rows) return null

      const byKey = new Map()
      const byArticle = new Map()
      /** Article number -> the name Oracle holds for it. First spelling wins. */
      const names = new Map()
      /**
       * The branch detail, added 10 Nov 2026.
       *
       *   byBranch     Map('<article>|<BRAND>|<CODE>' -> { consumption, potential })
       *   branchNames  Map('<BRAND>|<CODE>'           -> KST_NAME)
       *   unplaced     what carried no branch code at all, so the reader can
       *                see that branch rows do NOT sum to the brand total and
       *                by exactly how much, rather than finding it out from a
       *                figure that silently fails to reconcile.
       */
      const byBranch = new Map()
      const branchNames = new Map()
      const unplaced = { consumption: 0, potential: 0, rows: 0 }
      /**
       * Rows MC holds with no article number at all - 11 Nov 2026.
       *
       * Separate from `unplaced`, which is about the BRANCH being unknown on a
       * row whose article is perfectly good. This is the article itself being
       * absent, so the row cannot join to anything and cannot be scored; it is
       * kept only so the page's totals reconcile with the model's.
       */
      const unidentified = { consumption: 0, potential: 0, rows: 0 }
      /** Article number -> every distinct name MC writes it under. */
      const nameVariants = new Map()
      const add = (map, k, cons, pot) => {
        const held = map.get(k) ?? { consumption: 0, potential: 0 }
        held.consumption += cons
        held.potential += pot
        map.set(k, held)
      }

      for (const r of rows) {
        const article = canonArticle(val(r, 'ART_NUMMER'))
        /*
         * A row with no article number at all - counted, not silently dropped.
         *
         * MEASURED 11 Nov 2026. October 2026 holds 10 such rows carrying 1,382
         * consumption and 283 theoretical, and `continue` alone made the page's
         * totals disagree with the model's own by exactly that much. It is
         * 0.008% of the quantity, so nothing visible moves - but a total that
         * silently differs from its source is how a reader stops trusting every
         * other figure on the page, and the brief asks for unidentifiable
         * records to carry a status rather than to disappear.
         *
         * There is nowhere truthful to put them: with no article number they
         * join to nothing, so they are summed into their own bucket which the
         * page reports beside the table as an Unidentified mapping status.
         */
        if (!article) {
          unidentified.consumption += Number(val(r, 'cons')) || 0
          unidentified.potential += -(Number(val(r, 'pot')) || 0)
          unidentified.rows += 1
          continue
        }
        const raw = String(val(r, 'Brand') ?? '').trim().toUpperCase()
        // A blank brand is a real row whose owner is unknown, not a bad row. It
        // is dropped only when the caller did not ask for those.
        if (!raw && !includeUnmapped) continue
        const brand = raw || UNMAPPED_BRAND
        const cons = Number(val(r, 'cons')) || 0
        /*
         * Oracle books the theoretical NEGATIVE, so it is negated once here
         * rather than at every reader.
         *
         * NEGATED, NOT MADE ABSOLUTE, and the difference is real. Measured
         * 8 Nov 2026 over the whole table: 70,663 rows are negative and 254 are
         * positive, the positive ones totalling +277.4. They are reversals, and
         * a reversal has to REDUCE an article's consumption. `Math.abs` added
         * them instead, which put the September total 55 units above what the
         * model itself reports - small, and wrong in the direction that hides
         * a correction. Negating nets them out and the two agree exactly.
         *
         * A group that nets positive is kept as a negative figure rather than
         * flipped: it means more was reversed than consumed, which is a real
         * answer and not something to tidy away.
         */
        const rawPot = -(Number(val(r, 'pot')) || 0)
        /*
         * THE BRANCH IS READ HERE, BEFORE ANYTHING IS ADDED - 15 Nov 2026.
         *
         * It used to be read further down, after the totals were already in.
         * The theoretical of an excluded branch has to be dropped before it
         * reaches `byKey`, `byArticle` AND `byBranch`, or the page's three
         * grains would disagree about the same article.
         *
         * The CONSUMPTION is untouched, which is what was asked: this drops
         * one side of the comparison, not the row.
         */
        const code = String(val(r, 'Branch') ?? '').trim().toUpperCase()
        const pot = code && noTheo.has(code) ? 0 : rawPot
        add(byKey, `${article}|${brand}`, cons, pot)
        add(byArticle, article, cons, pot)
        const name = String(val(r, 'ART_NAME') ?? '').trim()
        if (name) {
          if (!names.has(article)) names.set(article, name)
          /*
           * One article number written under two names - 11 Nov 2026.
           *
           * The brief asks for an Ambiguous mapping status, and this is the
           * only ambiguity the source actually contains: `canonArticle`
           * collapses the two SPELLINGS of a number, so a number reaching two
           * different ART_NAMEs is master data disagreeing with itself rather
           * than a formatting difference. Recorded instead of guessed at - the
           * first spelling still wins for display, exactly as before, so
           * nothing moves except that the row can now say it is uncertain.
           */
          const held = nameVariants.get(article)
          if (held) held.add(name)
          else nameVariants.set(article, new Set([name]))
        }

        /*
         * The branch, where the KST MAP resolved one.
         *
         * An outlet the map does not place has no code, and there is nowhere
         * truthful to put it: attributing it to a branch would be a plainly
         * wrong number rather than a missing one. It is counted in `unplaced`
         * so the gap between the branch rows and the brand total is a figure
         * the page can state rather than a discrepancy somebody discovers.
         */
        // `code` is read above, before the totals, so an excluded branch's
        // theoretical never reaches any of the three grains.
        if (code) {
          add(byBranch, `${article}|${brand}|${code}`, cons, pot)
          const bk = `${brand}|${code}`
          if (!branchNames.has(bk)) {
            const outlet = String(val(r, 'KST_NAME') ?? '').trim()
            if (outlet) branchNames.set(bk, outlet)
          }
        } else {
          unplaced.consumption += cons
          unplaced.potential += pot
          unplaced.rows += 1
        }
      }

      const months = []
      for (let d = new Date(`${firstMonth}T00:00:00Z`); ; d.setUTCMonth(d.getUTCMonth() + 1)) {
        const iso = d.toISOString().slice(0, 10)
        if (iso > lastMonth) break
        months.push(iso)
      }

      console.log(
        `  [consumption] ${firstMonth}..${lastMonth}` +
          `${wanted.length ? ` (${wanted.join(',')})` : ''}: ` +
          `${byArticle.size} article forms, ${months.length} month(s), ` +
          `${branchNames.size} branches` +
          `${unplaced.rows ? `, ${unplaced.rows} rows with no branch code` : ''}` +
          `${unidentified.rows ? `, ${unidentified.rows} rows with no article number` : ''}`
      )
      /* Only the numbers that genuinely carry more than one name. */
      const ambiguous = new Set()
      for (const [article, variants] of nameVariants) {
        if (variants.size > 1) ambiguous.add(article)
      }

      return {
        byKey,
        byArticle,
        names,
        months,
        partial,
        byBranch,
        branchNames,
        unplaced,
        unidentified,
        ambiguous,
      }
    },
    { seconds: 600 }
  ).then((held) => (held ? { ...held, partial } : null))
}
