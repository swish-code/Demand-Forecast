import { useMemo, useState } from 'react'
import { api, fmtQty, fmtPct, fmtSignedPct, fmtInt, downloadCsv } from '../api.js'
/*
 * The Stock Article scoring formula, imported rather than rewritten, so the
 * two pages cannot drift apart. See the file for what it is and for the stock
 * rule this page deliberately does not apply.
 */
import { plainWhScore } from '../whAccuracy.js'
import { useData } from '../useData.js'
import { exportFileName } from '../exportName.js'
import {
  monthStartOf,
  monthEndOf,
  isWholeMonths,
  monthLabel,
  dayLabel,
} from '../consumptionWindow.js'
import { Panel, ErrorBanner, Empty, InfoBanner, KpiCard, Pill } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { ArticleUsage } from '../components/ArticleUsage.jsx'
import { IconDownload } from '../components/Icons.jsx'
import {
  VarianceHeatmap,
  persistentVarianceArticles,
  monthlyVarianceByArticle,
  engineVarianceByArticle,
  engineMonthlyTotals,
  mcMonthlyTotals,
  completeMonths,
} from '../components/charts/consumptionInsights.jsx'

/**
 * How far the outlets ran from the recipe.
 *
 * WHAT IS BEING COMPARED - CHANGED 9 NOV 2026, ON REQUEST
 *
 * Oracle explodes its own recipe over the sales that happened and books the
 * answer as `Potential COS QTY`. It also reconciles what was ACTUALLY consumed
 * from stock - Opening + Transfers + Purchase - Closing + Usage - and books that
 * as `CONSUMPTION`. The page differences those two:
 *
 *   Variance = CONSUMPTION - Potential COS QTY
 *
 * which is an OPERATIONAL finding: what disappeared beyond what the recipe
 * explains - waste, over-portioning, shrinkage, mis-keyed stock counts.
 *
 * It used to difference OUR theoretical against Oracle's, both theoretical,
 * which answered a different question - whether the two recipe engines agree.
 * That was the original brief and it was changed on request; the business wanted
 * the operational figure, not the recipe one.
 *
 * A second reason to prefer it, found the same day. Both sides now come from
 * Oracle, so the column cannot be moved by the local copy being stale - and it
 * was stale: PAT read 412,765 of ours against Oracle's 195,488 because the copy
 * still held doubled quantities, while this variance was correct throughout.
 *
 * Our own theoretical is KEPT as a cross-check column. It is the only
 * independent read on Oracle's theoretical, and it is what made the doubling
 * visible in the first place - but it is no longer differenced.
 *
 * ARTICLES WITH NO RECIPE ARE SIMPLY ABSENT
 *
 * Measured over April-October 2026, 2,999 of the 4,870 articles Oracle records
 * consuming carry no recipe line at all - 36.3% of the quantity. Our side is
 * recipe-driven, so no theoretical figure exists for them and none ever will.
 * They were listed on a second tab until 8 Nov 2026 and that tab was removed on
 * request; they are now left out entirely rather than scored, because a -100%
 * variance across a third of the volume would bury every row where the engines
 * genuinely disagree. The measurement is kept in `server/calculations.js` so
 * the figure is not lost with the tab.
 *
 * WHOLE MONTHS
 *
 * Oracle produces one figure per article per outlet per MONTH and nothing in it
 * says which day anything moved, so the consumption side cannot be cut finer.
 * A part-month window is still answered - with the whole month - and the banner
 * says so rather than letting a half-month forecast be read against a full
 * month of consumption.
 */

const dash = () => <span className="muted">–</span>

/*
 * A variance percentage that may be enormous - 12 Nov 2026.
 *
 * Where MC holds a theoretical of almost nothing and real quantity moved, the
 * ratio is correct and useless: one YP sticker line ran to +75,426% in August
 * on a theoretical of 892 against 673,693 consumed, and the six-month figure
 * overflowed its column as "+424518....".
 *
 * Two decimals at that magnitude are noise, so the precision drops as the
 * number grows and thousands are separated. The figure is NOT capped or
 * hidden: a percentage that large is a real finding about MC's theoretical,
 * and rounding it away would hide the thing worth investigating. The title
 * carries the exact value and says what a number like that means.
 */
const pctCell = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return dash()
  const n = Number(v) * 100
  if (Math.abs(n) < 1000) return <span className={n > 0 ? 'pos' : n < 0 ? 'neg' : ''}>{fmtSignedPct(v, 1)}</span>
  return (
    <span
      className={n > 0 ? 'pos' : 'neg'}
      title={`${n.toFixed(1)}% — MC holds almost no theoretical for this article, so the ratio is arithmetically correct but says more about the missing theoretical than about the outlets.`}
    >
      {n > 0 ? '+' : '−'}
      {fmtInt(Math.abs(Math.round(n)))}%
    </span>
  )
}

const qty = (v) => (v === null || v === undefined ? dash() : fmtQty(v))

/**
 * A variance, coloured by direction rather than by size.
 *
 * Over-stating and under-stating are different findings - one means our recipe
 * asks for more than Oracle's does, the other less - and a reader scanning for
 * a pattern needs the sign before the magnitude. `.pos` is amber and `.neg` is
 * blue in this theme, which is the same pairing the split bars already use for
 * over and under.
 */
const variance = (v) => {
  if (v === null || v === undefined) return dash()
  const sign = v > 0 ? '+' : ''
  return (
    <span className={v > 0 ? 'pos' : v < 0 ? 'neg' : ''}>
      {sign}
      {fmtQty(v)}
    </span>
  )
}

export const CONSUMPTION_COLUMNS = [
  {
    key: 'CHAINID',
    label: 'Brand',
    required: true,
    hint:
      'From the KST MAP in the source file. Outlets the map does not resolve — FM’s own sites and the ones still unresolved — are left off this page from 10 Nov 2026: that bucket is one row per article summed over every unresolved outlet, so its quantities are not comparable with a single brand’s.',
    render: (v, row) =>
      v ? (
        <Pill>{v}</Pill>
      ) : (
        <span
          className="muted"
          title={
            row?.Unmapped_Brand
              ? 'The KST MAP has no brand for this outlet, so Oracle’s own figures are shown without one.'
              : undefined
          }
        >
          –
        </span>
      ),
  },
  { key: 'Item No.', label: 'Article', required: true, autoWidth: true },
  { key: 'Item', label: 'Name', autoWidth: true },
  { key: 'BU', label: 'Unit', autoWidth: true },
  {
    key: 'Sys_Potential_COS',
    label: 'MC Theoretical',
    group: 'oracle',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint:
      'Potential COS QTY — what MC (Oracle Materials Control) says this article should have taken for the sales that happened. Stored negative in the source and negated once on the way in, so a reversal reduces consumption rather than adding to it.',
    render: qty,
  },
  {
    key: 'Sys_Consumption',
    label: 'Consumption',
    group: 'oracle',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint:
      'What Oracle reconciles from stock: Opening + Transfers + Purchase − Closing + Usage. MEASURED, not theoretical — it carries waste, over-portioning and shrinkage.',
    render: qty,
  },
  {
    /*
     * THE PAGE'S VARIANCE - CHANGED 9 NOV 2026, ON REQUEST.
     *
     * It was our theoretical minus Oracle's. It is now Oracle's actual minus
     * Oracle's own theoretical, which is what the business wanted: how far the
     * outlets ran from the recipe, not how far two recipe engines are apart.
     * This used to be the "Waste variance" column, which is now gone - it IS
     * this one, promoted.
     */
    key: 'Consumption_Variance',
    label: 'Variance',
    group: 'oracle',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint:
      'Oracle’s actual consumption minus Oracle’s own theoretical. Positive means the outlets used MORE than the recipe explains — waste, over-portioning or shrinkage. Negative means they used less. Both sides come from Oracle, so this column does not depend on our recipe copy at all.',
    render: variance,
  },
  {
    key: 'Consumption_Variance_Pct',
    label: 'Variance %',
    group: 'oracle',
    num: true,
    autoWidth: true,
    hint:
      'The variance as a share of Oracle’s theoretical, which is the side being checked against. Blank where Oracle’s theoretical is nothing — there is no denominator, and that is not a zero.',
    render: (v) => (v === null || v === undefined ? dash() : fmtSignedPct(v, 1)),
  },
  {
    /*
     * The same pair as the Variance column, scored - 10 Nov 2026, on request.
     *
     * Beside Variance % rather than replacing it, because the two say
     * different things and both get asked for: that one is signed and
     * unbounded and answers "which way, and by how much against the recipe";
     * this one is symmetric and bounded and answers "how close were they",
     * which is the form that can be averaged over articles of wildly
     * different sizes. Same formula as the other two scores on the page and as
     * Stock Article's WH ACC%.
     */
    /*
     * NOW READ FROM THE SERVER'S `MC_Match_Pct` - 11 Nov 2026.
     *
     * It was computed here with `plainWhScore`, which is unbounded below: 991
     * article-brand pairs in October 2026 carry net-negative consumption, and
     * a theoretical of 100 against a consumption of -50 scored -50%. It also
     * scored rows that should never have been scored at all. Both rules now
     * live in `mcScore`/`mcStatus` on the server, tested, and this column
     * simply renders what they decided.
     */
    key: 'MC_Match_Pct',
    label: 'MC Match %',
    group: 'oracle',
    num: true,
    autoWidth: true,
    hint:
      'How close MC’s theoretical came to MC’s measured consumption: 1 − |theoretical − consumption| ÷ the larger of the two. Symmetric and bounded 0–100%, so using double and using half both score 50%. Blank — not zero — for every row that is not a scored recipe comparison: non-recipe articles, rows with nothing on either side, and rows missing a side.',
    render: (v) => (v === null || v === undefined ? dash() : fmtPct(v, 1)),
  },
  {
    /*
     * THE STATUS EVERY KPI COUNTS ON - 11 Nov 2026, brief §3 and §4.
     *
     * One stamped field rather than a rule re-derived per card, so the table,
     * the cards and the export cannot disagree about what a variance is. The
     * two corrections it carries are the largest in the brief: a non-recipe
     * article is no longer a Variance, and a row with nothing on either side
     * is no longer a Match.
     */
    key: 'MC_Status',
    label: 'Status',
    group: 'oracle',
    autoWidth: true,
    hint:
      'Variance — MC holds a theoretical and consumption is more than 1% away from it. Match — within 1%, or within half a unit. No theoretical — consumed, but MC holds no theoretical: never scored, and NOT a claim that the article has no recipe. Not Scored — nothing on either side. Data Exception — MC is known to treat it as a recipe article yet holds no theoretical while consumption moved; worth investigating. Missing Data — a side is absent.',
    render: (v) =>
      v ? (
        <Pill
          tone={
            v === 'Variance'
              ? 'amber'
              : v === 'Match'
                ? 'green'
                : v === 'Data Exception'
                  ? 'red'
                  : 'slate'
          }
        >
          {v}
        </Pill>
      ) : (
        dash()
      ),
  },
  {
    key: 'MC_Theoretical_Class',
    label: 'MC theoretical',
    group: 'oracle',
    autoWidth: true,
    hiddenByDefault: true,
    hint:
      'Has theoretical where MC holds a positive Potential COS QTY for the article, No theoretical where it holds none but something was consumed, Empty where neither side holds anything. This is exactly what the MC theoretical slicer above filters on — and it says nothing about whether a recipe exists, only whether MC produced a figure.',
    render: (v) => (v ? <Pill tone="plain">{v}</Pill> : dash()),
  },
  {
    key: 'Mapping_Status',
    label: 'Mapping',
    group: 'oracle',
    autoWidth: true,
    hint:
      'Mapped — the outlet resolves to a brand and a recipe names the article. Unresolved — the KST MAP has no brand for the outlet; the record and its quantities are kept and are real, but whose they are is unknown. Ambiguous — MC writes this article number under more than one name. Not in PM — no recipe names the article, so there is no PM theoretical to compare.',
    render: (v) =>
      v ? (
        <Pill
          tone={
            v === 'Mapped'
              ? 'green'
              : v === 'Ambiguous'
                ? 'red'
                : v === 'Unresolved'
                  ? 'amber'
                  : 'slate'
          }
        >
          {v}
        </Pill>
      ) : (
        dash()
      ),
  },
  {
    key: 'Unit',
    label: 'Unit',
    group: 'oracle',
    autoWidth: true,
    hint:
      'From the recipe side — MC’s own table carries no unit column at all, verified against its columns on 11 Nov 2026. “Unknown” means no recipe names the article, so nothing in the data states its unit. It is never assumed to be Each.',
    render: (v) =>
      v === 'Unknown' ? <span className="muted">Unknown</span> : <Pill tone="plain">{v}</Pill>,
  },
  {
    /*
     * The marker, beside the two numbers it is drawn from.
     *
     * Stamped by the server so it sorts, searches and exports - see
     * `varianceFlag`. Within 1%, or half a unit in absolute terms, counts as
     * agreement: a tolerance built only on percentages flags every article
     * whose figures are a rounding apart, and then the column is ignored.
     */
    key: 'Variance_Flag',
    label: 'Flag',
    group: 'oracle',
    autoWidth: true,
    hint:
      'Variance where consumption is more than 1% away from Oracle’s theoretical — or where the theoretical is nothing at all and something was consumed. Match where they agree within 1%, or within half a unit, which is where a percentage stops meaning anything.',
    render: (v) =>
      v ? <Pill tone={v === 'Variance' ? 'amber' : 'slate'}>{v}</Pill> : dash(),
  },
  /*
   * The Trend COLUMN was removed on 9 Nov 2026, on request.
   *
   * A 112px sparkline in a table row was too small to read, which is what the
   * request for "visuals" was really about. The same monthly series now drives
   * the two chart panels above the table, where it has the room to be read.
   * `Variance_Trend` is still stamped on every row - it is what those panels are
   * drawn from, so nothing was removed from the data.
   */
  {
    /*
     * KEPT, deliberately, although it is no longer differenced.
     *
     * It is the only independent check on Oracle's theoretical, and it is what
     * showed the doubled PAT quantities on 9 Nov 2026. Moved out of the
     * comparison into its own group so nothing reads it as part of the
     * variance.
     */
    key: 'Our_Theoretical',
    label: 'PM Theoretical',
    group: 'ref',
    num: true,
    autoWidth: true,
    /*
     * OFF BY DEFAULT HERE from 11 Nov 2026 - it has its own view now.
     *
     * The MC table had grown to twenty columns across three comparisons, which
     * is what crowded the group headings and made the horizontal scrolling
     * painful. The PM columns are the full subject of the PM view, so on the
     * MC view they are available through Build view rather than present by
     * default. Nothing is removed from the data or from the export.
     */
    hiddenByDefault: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint:
      'Recipe quantity × the product quantity that actually sold, summed over every recipe line naming this article. Shown as a cross-check on Oracle’s theoretical beside it — it is NOT what the Variance column measures. Unlike the other columns it is read from the local copy, so a stale copy moves this one and nothing else. Blank where no recipe names the article: Oracle consumed it, we have no theoretical for it, and a zero would claim we did.',
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title={
            row?.Oracle_Only
              ? 'No recipe names this article, so there is no theoretical of ours to compare. Oracle’s own figures beside it are unaffected.'
              : 'No theoretical of ours for this article in the selected range.'
          }
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
  },
  {
    /*
     * What the warehouse actually ISSUED - 10 Nov 2026, on request.
     *
     * A third measurement, and the only one that is neither a recipe nor a
     * stock reconciliation: it is what physically left the central warehouse
     * for this brand's shops. Useful here because MC's consumption and this
     * figure disagree for different reasons - consumption carries waste and
     * counting error, outbound carries delivery timing and stock held at the
     * shop - so a row where all three diverge is a different story from one
     * where only the recipe is out.
     *
     * It is stamped on ONE row per article by the warehouse decorator, chosen
     * by largest forecast, which is not the row MC's figures land on. It is
     * gathered per article before the rows are narrowed; see `rowsAllBrands`.
     */
    key: 'Outbound_Qty',
    label: 'Outbound (actual)',
    group: 'ref',
    num: true,
    autoWidth: true,
    // Off by default here; the PM view is where outbound is the subject.
    hiddenByDefault: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint:
      'What the central warehouse actually issued to this brand’s shops in the window. Measured, and a different thing from MC’s Consumption beside it: that is reconciled from stock at the outlet and carries waste, this is what physically shipped. Blank where the warehouse has no record of the article at all.',
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title={
            row?.Outbound_Unknown
              ? 'The central warehouse has no shipping record for this article, so there is nothing to show — which is not the same as having shipped none of it.'
              : 'No outbound for this article in the selected range.'
          }
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
  },
  {
    /*
     * PM Theoretical against what actually shipped - 10 Nov 2026, on request,
     * "as done in stock article page".
     *
     * Same formula as that page, imported from `whAccuracy.js` rather than
     * copied: 1 - |theoretical - outbound| / MAX(the two), so it is symmetric
     * and reads as agreement. Stock Article's stock-cover rule is NOT applied
     * here - see the note where the field is computed - so this figure is
     * directly comparable in METHOD but will read lower than that page's
     * headline, by design.
     */
    key: 'Flow_Accuracy',
    label: 'Consumption vs Outbound',
    group: 'ref',
    num: true,
    autoWidth: true,
    hiddenByDefault: true,
    hint:
      'Two MEASUREMENTS against each other, which no other score here does: what the warehouse issued against what the outlet reconciled as consumed. Same formula — 1 − |a − b| ÷ the larger. They are not the same quantity even when both are right, because stock builds up or runs down at the shop between delivery and use, so read it over a long window rather than as a target. A persistent gap is stock moving at the shop, transfers recorded on one side only, or waste booked somewhere else.',
    render: (v) => (v === null || v === undefined ? dash() : fmtPct(v, 1)),
  },
  {
    key: 'Outbound_Accuracy',
    label: 'PM vs Outbound',
    group: 'ref',
    num: true,
    autoWidth: true,
    hiddenByDefault: true,
    hint:
      'How close PM Theoretical came to what the warehouse actually issued: 1 − |theoretical − outbound| ÷ the larger of the two, the same formula as Stock Article’s WH ACC%. Symmetric, so twice as much and half as much both score 50%. Stock Article additionally lifts a row to 100% where the shops already hold twice the forecast; that rule is about a shipping forecast and is not applied here, so this reads lower than that page by design. Blank where either side is missing — a forecast judged against a reading that does not exist is not a score of zero.',
    render: (v) => (v === null || v === undefined ? dash() : fmtPct(v, 1)),
  },
]

const GROUPS = { oracle: 'MC — theoretical vs actual', ref: 'PM and warehouse' }

/* ------------------------------------------- PM historical reconciliation --
 *
 * 11 Nov 2026. The §5 and §6 comparisons, as their own table.
 *
 * Grouped so the two questions never read as one: `engine` is PM against MC,
 * both theoretical; `flow` is PM against what physically shipped. The §7
 * adjusted scenario sits in a third group of its own and says "indicative" in
 * every hint, because the brief is emphatic that it is not the official
 * accuracy and must not be read as a correction to it.
 */
const PM_GROUPS = {
  id: 'Article',
  engine: 'PM vs MC theoretical',
  flow: 'PM vs warehouse outbound',
  scenario: 'MC-adjusted scenario (indicative)',
}

const PM_COLUMNS = [
  {
    key: 'CHAINID',
    label: 'Brand',
    group: 'id',
    required: true,
    render: (v) => (v ? <Pill>{v}</Pill> : <span className="muted">–</span>),
  },
  { key: 'Item No.', label: 'Article', group: 'id', required: true, autoWidth: true },
  { key: 'Item', label: 'Name', group: 'id', autoWidth: true },
  {
    key: 'Unit',
    label: 'Unit',
    group: 'id',
    autoWidth: true,
    hint:
      'From the recipe side — MC’s own table carries no unit column at all. “Unknown” is an article no recipe names, so nothing in the data states its unit; it is never assumed to be Each.',
    render: (v) =>
      v === 'Unknown' ? <span className="muted">Unknown</span> : <Pill tone="plain">{v}</Pill>,
  },
  {
    key: 'Our_Theoretical',
    label: 'PM Actual Theoretical',
    group: 'engine',
    num: true,
    autoWidth: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint:
      'Actual Product/PLU sales quantity × article quantity BU, summed over every recipe line naming this article. Read from the local copy of the Product Mix model.',
    render: qty,
  },
  {
    key: 'Sys_Potential_COS',
    label: 'MC Theoretical',
    group: 'engine',
    num: true,
    autoWidth: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint: 'Potential COS QTY — MC’s own recipe explosion over the same sales.',
    render: qty,
  },
  {
    key: 'Engine_Diff',
    label: 'Variance qty',
    group: 'engine',
    num: true,
    autoWidth: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint: 'PM Actual Theoretical − MC Theoretical. Positive means our explosion asks for more than MC’s.',
    render: variance,
  },
  {
    key: 'Engine_Diff_Pct',
    label: 'Variance %',
    group: 'engine',
    num: true,
    autoWidth: true,
    hint: 'Against MC Theoretical, the side being checked. Blank where MC holds no theoretical — there is no denominator.',
    render: (v) => (v === null || v === undefined ? dash() : fmtSignedPct(v, 1)),
  },
  {
    key: 'Engine_Accuracy',
    label: 'Match %',
    group: 'engine',
    num: true,
    autoWidth: true,
    hint: '1 − |PM − MC| ÷ the larger of the two. Symmetric, so twice as much and half as much both read 50%.',
    render: (v) => (v === null || v === undefined ? dash() : fmtPct(v, 1)),
  },
  {
    key: 'Outbound_Qty',
    label: 'Outbound (actual)',
    group: 'flow',
    num: true,
    autoWidth: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint:
      'What the central warehouse actually issued to this brand’s shops. Supply, NOT store consumption — stock builds up and draws down at the shop in between.',
    render: qty,
  },
  {
    key: 'Outbound_Variance',
    label: 'Variance qty',
    group: 'flow',
    num: true,
    autoWidth: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint:
      'Outbound − PM Actual Theoretical. Positive means the warehouse issued more than the recipe implies was needed.',
    render: variance,
  },
  {
    key: 'Outbound_Variance_Pct',
    label: 'Variance %',
    group: 'flow',
    num: true,
    autoWidth: true,
    hint: 'Against PM Actual Theoretical. Blank where PM has nothing to divide by.',
    render: (v) => (v === null || v === undefined ? dash() : fmtSignedPct(v, 1)),
  },
  {
    key: 'Outbound_Accuracy',
    label: 'Match %',
    group: 'flow',
    num: true,
    autoWidth: true,
    hint:
      'The original, unadjusted PM-to-outbound agreement: 1 − |PM − outbound| ÷ the larger. This is the official figure and the adjusted column beside it never replaces it.',
    render: (v) => (v === null || v === undefined ? dash() : fmtPct(v, 1)),
  },
  {
    key: 'MC_Adjust_Factor',
    label: 'MC factor',
    group: 'scenario',
    num: true,
    autoWidth: true,
    hint:
      'This article’s own MC Consumption ÷ MC Potential COS. Per article and brand — never a brand-wide or article-wide rate applied to its neighbours. Blank where MC holds no positive theoretical.',
    render: (v) => (v === null || v === undefined ? dash() : fmtQty(v, 3)),
  },
  {
    key: 'Adjusted_PM',
    label: 'Adjusted PM',
    group: 'scenario',
    num: true,
    autoWidth: true,
    hint:
      'INDICATIVE. PM Actual Theoretical × the MC factor, asking whether MC’s own variance explains part of the PM-to-outbound gap. Not the official PM theoretical.',
    render: qty,
  },
  {
    key: 'Adjusted_Accuracy',
    label: 'Adjusted match %',
    group: 'scenario',
    num: true,
    autoWidth: true,
    hint:
      'INDICATIVE ONLY — an MC-adjusted scenario, not the official PM accuracy. Shown as Not Available where any condition fails; hover the cell for which one.',
    render: (v, row) =>
      v === null || v === undefined ? (
        <span className="muted" title={row?.Adjust_Reason ?? undefined}>
          Not Available
        </span>
      ) : (
        fmtPct(v, 1)
      ),
  },
]

/**
 * THE TWO RECIPE ENGINES, SIDE BY SIDE - 10 Nov 2026, on request.
 *
 * This is the comparison the page was originally built to make, and it was
 * taken off the front on 9 Nov when the business asked for the operational
 * figure instead - MC's own theoretical against MC's own consumption. It comes
 * back here as its own table rather than as a column, because it answers a
 * different question from everything else on the page: not "did the outlets
 * follow the recipe" but "do our recipe and theirs agree about what the recipe
 * IS".
 *
 * Both sides are theoretical, so neither carries waste, portioning or counting
 * error. A gap here is a difference in the recipes themselves, in the unit of
 * measure, or in which products the sales were attributed to - and it is the
 * only column on the page that can be moved by our local copy being stale,
 * which is exactly how the doubled PAT quantities were caught on 9 Nov 2026.
 */
/**
 * ARTICLE x BRAND x BRANCH - 10 Nov 2026, on request.
 *
 * The other tables are one row per article per brand; this is the same figures
 * opened out to the branch they came from. It is a separate table rather than
 * extra columns because a branch cannot be a column on a row that already sums
 * eleven of them - and because splitting the main table to this grain would
 * cost it Outbound, which the warehouse read cannot yet give per branch.
 *
 * A branch is BRAND + CODE. The codes repeat - ARD belongs to BBT, PAT, SS,
 * SLC and MM - so the server indexes them per article and brand together and
 * nothing here can attribute a branch to the wrong brand.
 */
export const BRANCH_COLUMNS = [
  {
    key: 'brand',
    label: 'Brand',
    render: (v) => (v ? <Pill>{v}</Pill> : <span className="muted">–</span>),
  },
  { key: 'code', label: 'Branch code', autoWidth: true, render: (v) => <Pill tone="plain">{v}</Pill> },
  {
    key: 'name',
    label: 'Branch',
    autoWidth: true,
    hint: 'The outlet’s own name in MC. The code beside it is the same LocationID the Product Mix page slices on.',
  },
  { key: 'article', label: 'Article', required: true, autoWidth: true },
  { key: 'item', label: 'Name', autoWidth: true },
  {
    key: 'potential',
    label: 'MC Theoretical',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    render: qty,
  },
  {
    key: 'consumption',
    label: 'MC Consumption',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    render: qty,
  },
  {
    key: 'variance',
    label: 'Variance',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint: 'MC consumption minus MC theoretical, for this article at this branch.',
    render: variance,
  },
  {
    key: 'pct',
    label: 'Variance %',
    num: true,
    autoWidth: true,
    render: (v) => (v === null || v === undefined ? dash() : fmtSignedPct(v, 1)),
  },
  {
    key: 'accuracy',
    label: 'MC Match %',
    num: true,
    autoWidth: true,
    hint:
      'The same score as the MC view, from the same server-side rule: 1 − |theoretical − consumption| ÷ the larger of the two, bounded 0–100%. Blank — not zero — wherever the row is not a scored recipe comparison, so a branch grain and an article grain can never classify the same article differently.',
    render: (v) => (v === null || v === undefined ? dash() : fmtPct(v, 1)),
  },
  {
    /* The same status the article grain carries, stamped by the same rule. */
    key: 'status',
    label: 'Status',
    autoWidth: true,
    hint:
      'Classified at the branch grain by the rule the article grain uses. No theoretical and Not Scored rows carry no score here either, which is what lets the branch detail reconcile with the article summary above it.',
    render: (v) =>
      v ? (
        <Pill
          tone={
            v === 'Variance'
              ? 'amber'
              : v === 'Match'
                ? 'green'
                : v === 'Data Exception'
                  ? 'red'
                  : 'slate'
          }
        >
          {v}
        </Pill>
      ) : (
        dash()
      ),
  },
  {
    key: 'unit',
    label: 'Unit',
    autoWidth: true,
    hiddenByDefault: true,
    hint: 'From the recipe side. “Unknown” where no recipe names the article.',
    render: (v) =>
      v === 'Unknown' ? <span className="muted">Unknown</span> : <Pill tone="plain">{v}</Pill>,
  },
  {
    key: 'mapping',
    label: 'Mapping',
    autoWidth: true,
    hiddenByDefault: true,
    render: (v) => (v ? <Pill tone={v === 'Mapped' ? 'green' : 'amber'}>{v}</Pill> : dash()),
  },
]

export const ENGINE_COLUMNS = [
  {
    key: 'CHAINID',
    label: 'Brand',
    render: (v) => (v ? <Pill>{v}</Pill> : <span className="muted">–</span>),
  },
  { key: 'Item No.', label: 'Article', required: true, autoWidth: true },
  { key: 'Item', label: 'Name', autoWidth: true },
  {
    key: 'Our_Theoretical',
    label: 'PM Theoretical',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint: 'Recipe quantity × the product quantity that actually sold, summed over every recipe line naming this article. Read from the local copy.',
    render: qty,
  },
  {
    key: 'Sys_Potential_COS',
    label: 'MC Theoretical',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint: 'Potential COS QTY — what MC’s own recipes say should have been used for the same sales.',
    render: qty,
  },
  {
    key: 'Engine_Diff',
    label: 'Difference',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint:
      'PM Theoretical minus MC Theoretical. Positive means our recipe asks for more than theirs. Both sides are theoretical, so this is a disagreement about the recipe — not waste, portioning or counting.',
    render: variance,
  },
  {
    key: 'Engine_Accuracy',
    label: 'Agreement',
    num: true,
    autoWidth: true,
    hint:
      'How close the two engines are: 1 − |PM − MC| ÷ the larger of the two, the same formula Stock Article scores the warehouse forecast with. 100% is exact agreement; 50% means one is double the other. Blank where either side has no figure.',
    render: (v) => (v === null || v === undefined ? dash() : fmtPct(v, 1)),
  },
]

/**
 * The persistent-offenders list - 9 Nov 2026, on request.
 *
 * Deliberately short. It answers "which articles do this every month", and the
 * table below answers everything else about them, so repeating the two sides of
 * the comparison here would only make the reader compare two tables.
 */
export const PERSISTENT_COLUMNS = [
  {
    key: 'brand',
    label: 'Brand',
    render: (v) => (v ? <Pill>{v}</Pill> : <span className="muted">–</span>),
  },
  { key: 'article', label: 'Article', autoWidth: true },
  { key: 'name', label: 'Name', autoWidth: true },
  {
    /*
     * Months high, over months SEEN - not over the window.
     *
     * An article Oracle only started recording in August is not an article
     * that was in agreement until then, and "3 of 6" would say it was. So the
     * denominator is how many months it appears in at all, and the window is
     * named once in the panel rather than implied wrongly on every row.
     */
    key: 'monthsHigh',
    label: 'Months high',
    num: true,
    autoWidth: true,
    strong: true,
    hint:
      'How many of the months this article appears in were beyond 1% of Oracle’s theoretical, out of how many it appears in at all. A month with no row for the article is not counted either way — it is not evidence of agreement.',
    render: (v, row) => (
      <span>
        <Pill tone={row.everyMonth ? 'amber' : 'slate'}>
          {v} of {row.monthsSeen}
        </Pill>
        {row.monthsSeen < row.monthsWindow && (
          <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
            of {row.monthsWindow} months
          </span>
        )}
      </span>
    ),
  },
  {
    key: 'direction',
    label: 'Direction',
    autoWidth: true,
    hint:
      '“Used more” — every high month was over the recipe. “Used less” — every one was under. “Mixed” — both, which more often points at stock counts landing in the wrong month than at steady waste.',
    render: (v) => <Pill tone={v === 'Mixed' ? 'slate' : 'plain'}>{v}</Pill>,
  },
  {
    key: 'variance',
    label: 'Variance over the window',
    num: true,
    autoWidth: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    hint: 'The article’s variance summed over the months shown, so a steady monthly gap adds up and a single spike does not dominate.',
    render: variance,
  },
  {
    key: 'latest',
    label: 'Latest month',
    num: true,
    autoWidth: true,
    hint: 'The most recent month’s variance on its own — whether it is still happening.',
    render: variance,
  },
]

export function ConsumptionVariance({ filters, ready, refreshNonce, onLoaded }) {
  /*
   * Split by brand, because the brand is a column here.
   *
   * Oracle's figures are per brand, so a row merged across brands would be
   * compared against every brand's consumption at once. The same reason
   * Warehouse Insights pins this grain, and it shares the cache entry with it.
   */
  /*
   * `consumptionView` asks the server to append every article in
   * 'Consumption Qty' that no recipe row carried - 9 Nov 2026, on request.
   *
   * The same route serves Stock Article and Procurement, which are recipe views
   * and must not grow those rows, and the client sends no page id - so this
   * page says who it is. It changes only what is appended, never what is
   * queried, so it is not part of the filters.
   */
  /*
   * `oracleRecipes` is deliberately NOT sent.
   *
   * It narrows on `Sys_Potential_COS`, which is already in the response, so
   * sending it would re-query Power BI for rows the page is about to drop and
   * make a toggle cost a round trip. Stripped here and applied below, which
   * also means the two values are a free switch between views of one fetch.
   */
  const request = useMemo(() => {
    const { oracleRecipes: _dropped, ...rest } = filters ?? {}
    return { ...rest, grain: ['brand'], consumptionView: true }
  }, [filters])

  /*
   * Which article's menu items are open, or null.
   *
   * The same panel Stock Article opens on a row click, reused rather than
   * rebuilt: it already answers "which menu items use this article, and how
   * much of it does each take", including the recipe PATH down to the article,
   * which is exactly the question a disagreement about quantity raises. It
   * takes the whole row, because it needs both `Item No.` and `Item` - a prep
   * step has no article number and is matched by name.
   */
  const [usage, setUsage] = useState(null)

  const { data, error, loading, reload } = useData(api.componentLevel, request, {
    enabled: ready,
    nonce: refreshNonce,
    onLoaded,
  })

  /*
   * Only the rows the server stamped.
   *
   * Oracle's figures belong to an ARTICLE, and an article is spread over one
   * row per recipe group, so `withOracleConsumption` stamps them on the first
   * row of each article and brand and leaves the rest alone - the same rule the
   * warehouse columns follow. Taking only the stamped rows is therefore
   * precisely one row per article per brand, with our side already summed
   * across that article's recipe lines.
   */
  const rowsAllBrands = useMemo(() => {
    const all = data?.rows ?? []

    /*
     * OUTBOUND, GATHERED BEFORE THE ROWS ARE NARROWED.
     *
     * It cannot simply be read off the row the MC figures landed on, because
     * the two are stamped by different rules:
     *
     *   MC        stamps the FIRST row of each article and brand
     *   Outbound  stamps the LARGEST row by Component_Forecast_Qty
     *
     * An article spread over several recipe groups usually has those two on
     * different rows, so reading Outbound off an MC-stamped row would show a
     * dash for most of the table and nobody would know the figure existed.
     * It is therefore folded here, over EVERY row, before the narrowing.
     *
     * A PM Forecast Qty column was folded here too for part of 10 Nov 2026
     * and removed the same day on request; its fold went with it rather than
     * being left to compute a field nothing reads.
     */
    const canon = (v) => {
      const s = String(v ?? '').trim()
      if (!s) return ''
      const n = Number(s)
      return Number.isFinite(n) ? String(n) : s
    }
    const keyOf = (r) => {
      const article = canon(r['Item No.'])
      const brand = String(r.CHAINID ?? '').trim().toUpperCase()
      return article && brand ? `${article}|${brand}` : null
    }

    const extras = new Map()
    for (const r of all) {
      const k = keyOf(r)
      if (!k) continue
      const held = extras.get(k) ?? { outbound: null, unknown: false }


      // Stamped once per article, so the first non-null is the figure. Adding
      // them would double it if the stamp rule ever changed.
      if (held.outbound === null && r.Consumed_Qty !== null && r.Consumed_Qty !== undefined) {
        held.outbound = Number(r.Consumed_Qty)
      }
      if (r.Consumed_Unknown) held.unknown = true

      extras.set(k, held)
    }

    const stamped = all
      .filter((r) => r.Sys_Potential_COS !== null && r.Sys_Potential_COS !== undefined)
      .map((r) => {
        const held = extras.get(keyOf(r))
        const outbound = held?.outbound ?? null

        /*
         * Two scores, both the Stock Article formula - 10 Nov 2026.
         *
         *   1 - |a - b| / MAX(a, b)
         *
         * `plainWhScore` is that formula, kept in `whAccuracy.js` so the pages
         * cannot drift apart. Symmetric and bounded 0-1: twice as much and
         * half as much both score 50%, which is what makes it readable as
         * agreement rather than as a direction.
         *
         * THE STOCK RULE IS DELIBERATELY NOT APPLIED. On Stock Article a row
         * is lifted to 100% when the shops already hold twice the forecast,
         * because the warehouse declining to ship is then correct. That
         * argument is about a SHIPPING FORECAST; PM Theoretical is what the
         * recipe implies the sales consumed, and a full shop does not make the
         * recipe right. Applying it anyway would move the figure by about
         * forty points - measured in `whAccuracy.js` - for a reason that does
         * not hold here. So this is the plain score, and it is a harder one
         * than Stock Article's headline.
         */
        const pm = r.Our_Theoretical

        /*
         * The MC-adjusted scenario - 11 Nov 2026, brief §7.
         *
         * MC's own consumption ran at a ratio to MC's own theoretical. If that
         * ratio is a real operational effect - waste, over-portioning - then
         * PM's theoretical, which is a recipe figure like MC's, should be
         * expected to understate what actually moved by the same proportion.
         * This asks only that question: does applying MC's observed ratio to
         * PM's theoretical bring it closer to what the warehouse shipped?
         *
         * EVERY CONDITION THE BRIEF SETS IS ENFORCED, and all of them on THIS
         * row - the factor is the row's own MC ratio, never a brand-wide or
         * article-wide rate borrowed from its neighbours:
         *
         *   - MC Potential COS positive       `MC_Adjust_Factor` is null
         *                                     otherwise, stamped server-side.
         *   - article mapped to PM            `pm` is absent for MC-only rows.
         *   - brand and branch comparable     the row is one article in one
         *                                     brand; unresolved rows carry no
         *                                     brand and are refused below.
         *   - recipe classification right     non-recipe rows have no factor.
         *   - something to compare against    no outbound, no scenario.
         *
         * The ORIGINAL accuracy is computed first and never overwritten. The
         * adjusted figure is an additional column that says "indicative" in
         * its own hint and is excluded from every headline KPI.
         */
        const factor = r.MC_Adjust_Factor
        const adjustable =
          factor !== null &&
          factor !== undefined &&
          Number.isFinite(Number(factor)) &&
          pm !== null &&
          pm !== undefined &&
          outbound !== null &&
          r.Mapping_Status === 'Mapped'
        const adjustedPm = adjustable ? Number(pm) * Number(factor) : null
        /*
         * Why an adjustment was refused, in the row, so the table can say
         * "Not Available" and explain rather than showing an empty cell.
         */
        const adjustReason = adjustable
          ? null
          : pm === null || pm === undefined
            ? 'No PM theoretical: no recipe names this article.'
            : factor === null || factor === undefined
              ? 'MC holds no positive theoretical for this article, so there is no ratio to apply.'
              : outbound === null
                ? 'No warehouse outbound to compare the adjusted figure against.'
                : 'The outlet is unresolved, so brand and branch are not comparable.'

        return {
          ...r,
          Outbound_Qty: outbound,
          Outbound_Unknown: held?.unknown && outbound === null,
          Outbound_Accuracy: plainWhScore(pm, outbound),
          /*
           * The variance the brief asks for in §6, which the page did not have
           * - it carried the match score and no quantity or percentage.
           *
           * Signed as the brief specifies: OUTBOUND minus PM, so positive
           * means the warehouse issued more than the recipe implies was
           * needed. Percentage against PM, the side being checked.
           */
          Outbound_Variance:
            pm === null || pm === undefined || outbound === null
              ? null
              : Number(outbound) - Number(pm),
          Outbound_Variance_Pct:
            pm === null || pm === undefined || outbound === null || Number(pm) <= 0
              ? null
              : (Number(outbound) - Number(pm)) / Number(pm),
          Adjusted_PM: adjustedPm,
          Adjusted_Accuracy: adjustable ? plainWhScore(adjustedPm, outbound) : null,
          Adjust_Reason: adjustReason,
          /*
           * MC's own two sides, scored the same way - 10 Nov 2026.
           *
           * The page's headline pair, as a score rather than a quantity: the
           * Variance column says HOW MUCH the outlets ran from the recipe, and
           * this says how far that is in proportion, symmetrically. It is not
           * Variance % restated - that divides by the theoretical and is
           * unbounded and signed, so using twice as much reads as +100% and
           * using nothing reads as -100%. This is bounded and direction-free,
           * which is what makes it averageable across articles of different
           * sizes and comparable with the two scores beside it.
           */
          /*
           * `Mc_Accuracy` was computed here and is GONE - 11 Nov 2026.
           *
           * The server now stamps `MC_Match_Pct` with the bounded rule, so
           * recomputing it here could only ever reintroduce the two faults it
           * was built to fix: a negative percentage where consumption nets
           * below zero, and a score on rows that should not be scored at all.
           */
          /*
           * The only pair on the page where BOTH sides are measured - 10 Nov
           * 2026, on request.
           *
           * Every other score has a theoretical on one side, so it asks
           * whether a calculation matched reality. This asks whether two
           * independent readings of reality agree: what the warehouse issued
           * against what the outlet reconciled as consumed. They are not the
           * same quantity even when everything is correct - stock builds up or
           * draws down at the shop between the two - so this is read as
           * "roughly, over a long enough window" rather than as a target.
           */
          Flow_Accuracy: plainWhScore(r.Sys_Consumption, outbound),
          // PM against MC: the two recipe engines on the same article.
          Engine_Accuracy: plainWhScore(pm, r.Sys_Potential_COS),
          Engine_Diff:
            pm === null || pm === undefined || r.Sys_Potential_COS === null
              ? null
              : Number(pm) - Number(r.Sys_Potential_COS),
          /* §5 asks for the percentage too, against MC as the baseline. */
          Engine_Diff_Pct:
            pm === null || pm === undefined || !(Number(r.Sys_Potential_COS) > 0)
              ? null
              : (Number(pm) - Number(r.Sys_Potential_COS)) / Number(r.Sys_Potential_COS),
          /*
           * The unit, as a field the page can filter and group on - §9.
           *
           * `BU` comes from the RECIPE side and is the only unit the data
           * holds: 'Consumption Qty' carries no unit column at all, verified
           * against the table's own columns on 11 Nov 2026. So an article no
           * recipe names has no unit anywhere, and that is reported as
           * 'Unknown' rather than guessed at or silently folded in with Each.
           */
          Unit: String(r.BU ?? '').trim() || 'Unknown',
        }
      })

    /*
     * The Oracle recipe slicer - 9 Nov 2026, on request.
     *
     * "For those with Oracle theoretical 0, those are non-recipe; add a slicer
     * filter so I can filter these out, so those don't affect the variance."
     *
     * Applied HERE, at the top, so it reaches everything: the cards, the three
     * charts, the list, the table and the CSV all read `rows`. Filtering lower
     * down would leave a card and a chart disagreeing about what is on screen.
     *
     * `> 0` and not `!== 0`: a theoretical of nothing is nothing however it is
     * written, and the column is negated on the way in, so a reversal can land
     * on the wrong side of zero.
     */
    const wanted = filters?.oracleRecipes
    if (!wanted?.length || wanted.length === 2) return stamped

    /*
     * THREE GENERATIONS OF NAMES, ALL STILL UNDERSTOOD.
     *
     *   until 10 Nov 2026   "Has recipe"  / "No recipe"
     *   until 12 Nov 2026   "Recipe"      / "Non-recipe"
     *   now                 "Has theoretical" / "No theoretical"
     *
     * Filter state is saved in the browser and shared across pages, so a
     * selection made before a rename comes back as the old word. Matching
     * strictly would mean the saved filter matched NOTHING and emptied the
     * page, with a pill on screen still naming a value - which reads as the
     * data having vanished rather than a vocabulary change.
     *
     * The latest rename is the one that matters: the earlier names claimed the
     * article had or lacked a RECIPE, and the test only ever asked whether MC
     * holds a theoretical. Those are different things, and real non-recipe
     * articles land on both sides of the line.
     */
    const canonChoice = (v) => {
      const s = String(v).trim()
      if (s === 'Has recipe' || s === 'Recipe') return 'Has theoretical'
      if (s === 'No recipe' || s === 'Non-recipe') return 'No theoretical'
      return s
    }

    const want = new Set(wanted.map(canonChoice))
    if (want.size === 2) return stamped
    return stamped.filter((r) =>
      want.has(Number(r.Sys_Potential_COS) > 0 ? 'Has theoretical' : 'No theoretical')
    )
  }, [data, filters?.oracleRecipes])

  /*
   * UNRESOLVED OUTLETS ARE KEPT - 11 Nov 2026, reversing the 10 Nov change.
   *
   * They were shown until 10 Nov, dropped that day on request, and the brief of
   * 11 Nov asks for them back: "Do not drop unresolved records from the
   * analysis... Preserve the MC data and identify unresolved location mappings
   * separately."
   *
   * Both positions were right about different things. The reason for dropping
   * them stands - the unmapped bucket is one row per article summed over EVERY
   * unresolved outlet, so its quantity is not comparable with a single brand's
   * and it took the largest group in a table meant to be read brand by brand.
   * The answer is therefore NOT to put them back in the same pile: they are
   * kept in the data, carry `Mapping_Status` of their own, and are excluded
   * from the scored population by STATUS rather than by deletion. A reader who
   * wants only comparable rows filters to Mapped; a reader auditing coverage
   * can see exactly what is unresolved and how much it holds.
   *
   * Measured October 2026, all nine brands: 3,546 of the 8,378 article-brand
   * pairs are unresolved, and the page used to show none of them.
   */
  /*
   * DECLARED HERE, ABOVE EVERY MEMO THAT READS THEM - fixed 12 Nov 2026.
   *
   * These three sat below the memos that depend on them, which threw
   * "Cannot access 'Q' before initialization" the moment the page
   * rendered: `const` bindings are in the temporal dead zone until their
   * own line runs, and `unitOptions`, `rows` and `branchShown` all read
   * them first. The build cannot catch this - the module parses and
   * bundles perfectly - so only loading the page finds it.
   */
  /*
   * THE THREE VIEWS - 11 Nov 2026, on request.
   *
   * The page had grown to six panels and a table twenty columns wide holding
   * three unrelated comparisons side by side, which is what made the headings
   * crowd and the last KPI card clip. They are three different questions with
   * three different audiences, so they are three views rather than one scroll:
   *
   *   mc      MC's own theoretical against MC's own consumption. The
   *           operational question, and the one the manager asked first.
   *   pm      PM's theoretical against MC's, and against what the warehouse
   *           actually issued. The reconciliation question.
   *   branch  The same MC figures opened out to brand + branch + article.
   *
   * State, not routes: the data is one fetch and switching must not re-query.
   */
  const [view, setView] = useState('mc')

  /*
   * Unit of measurement - §9, page-local rather than in the shared FilterBar.
   *
   * The header slicers are shared by ten pages and their option lists are
   * fetched; a unit list is derived from the rows already on screen, so
   * putting it here costs no round trip and cannot change any other page's
   * behaviour. The brief says "where appropriate", and this is where.
   */
  const [units, setUnits] = useState([])
  /*
   * Branch - also page-local, and deliberately applied ONLY to Branch Detail.
   *
   * An article row in the other two views is a BRAND aggregate. Narrowing it
   * by branch would leave the row's quantity unchanged while implying it had
   * been filtered, which is the "do not multiply or misattribute records"
   * failure the brief warns about in a quieter form. Branch Detail is at
   * branch grain and can answer the question honestly, so that is the only
   * place the control appears.
   *
   * TWO LINKED DROPDOWNS, NOT A ROW OF PILLS - 12 Nov 2026, on request.
   *
   * The first build laid every branch out as a toggle, which worked while the
   * data was imagined and fell over on contact with it: 106 branches wrapped
   * to six rows and pushed the table off the screen. Brand first, then that
   * brand's branches, which is also how a reader thinks about it - nobody
   * looks for "QTB" without knowing whose QTB they mean.
   *
   * The branch value stays the COMPOSITE `BRAND|CODE`. The codes repeat
   * across brands - ARD belongs to five - so a bare code has never been a
   * usable identifier here and still is not, even though the brand dropdown
   * above it now makes the choice look unambiguous.
   */
  const [branchBrand, setBranchBrand] = useState('')
  const [branchKey, setBranchKey] = useState('')

  /*
   * Every unit present, with how much each holds - §9.
   *
   * Built from the unfiltered rows so the control does not shrink as the
   * reader uses it, and ordered by quantity so the units that matter are at
   * the top rather than alphabetically.
   */
  const unitOptions = useMemo(() => {
    const held = new Map()
    for (const r of rowsAllBrands) {
      const u = r.Unit || 'Unknown'
      const n = held.get(u) ?? { unit: u, rows: 0, consumption: 0 }
      n.rows += 1
      n.consumption += Number(r.Sys_Consumption) || 0
      held.set(u, n)
    }
    return [...held.values()].sort((a, b) => b.consumption - a.consumption)
  }, [rowsAllBrands])

  const rows = useMemo(() => {
    if (!units.length) return rowsAllBrands
    const want = new Set(units)
    return rowsAllBrands.filter((r) => want.has(r.Unit || 'Unknown'))
  }, [rowsAllBrands, units])

  /*
   * Is a combined quantity meaningful for what is selected? - §9.
   *
   * "Do not sum quantities across incompatible units and present the result as
   * a meaningful overall consumption total." One unit selected, or only one
   * unit present at all, and a total is a real quantity. Otherwise every
   * quantity KPI is suppressed and the per-unit breakdown is shown in its
   * place - the figure is NOT silently printed with a footnote, because a
   * number on a card is read long before its footnote is.
   */
  const unitsShown = useMemo(() => {
    const want = units.length ? new Set(units) : null
    return unitOptions.filter((u) => !want || want.has(u.unit))
  }, [unitOptions, units])
  const singleUnit = unitsShown.length <= 1
  const unitLabel = unitsShown.length === 1 ? unitsShown[0].unit : null

  const mappingCounts = useMemo(() => {
    const out = { Mapped: 0, Unresolved: 0, Ambiguous: 0, 'Not in PM': 0 }
    for (const r of rows) {
      const s = r.Mapping_Status
      if (s && out[s] !== undefined) out[s] += 1
    }
    return out
  }, [rows])
  const unmappedRows = mappingCounts.Unresolved

  const months = useMemo(() => {
    const from = filters?.dateFrom
    const to = filters?.dateTo
    if (!from || !to) return []
    const out = []
    for (let m = monthStartOf(from); m <= monthStartOf(to); ) {
      out.push(m)
      const d = new Date(`${m}T00:00:00Z`)
      d.setUTCMonth(d.getUTCMonth() + 1)
      m = d.toISOString().slice(0, 10)
    }
    return out
  }, [filters?.dateFrom, filters?.dateTo])

  const partial = !isWholeMonths(filters?.dateFrom, filters?.dateTo)

  /*
   * The population every KPI counts on - rebuilt 11 Nov 2026.
   *
   * WHAT WAS WRONG. `flagged` counted `Variance_Flag === 'Variance'`, and that
   * flag was returned for every article MC holds no theoretical for - which is
   * the definition of a non-recipe article, 1,048 pairs carrying 47.6% of
   * October's quantity. The companion error was quieter and larger: an article
   * with nothing on either side differenced to zero, landed inside the
   * half-unit floor and was counted a Match. 2,493 of 4,832 pairs - 51.6% -
   * were empty rows scored as perfect agreement.
   *
   * So the headline match rate was mostly made of rows that held no data, and
   * the flagged count was mostly made of articles that were never going to
   * have a theoretical. Both are now decided by `MC_Status`, stamped on the
   * server by one tested rule, and the scored population is exactly the rows
   * where a recipe comparison is possible.
   *
   * EXPECT THE MATCH RATE TO FALL when this ships. It is not a regression -
   * the old figure was counting absence as agreement.
   */
  const totals = useMemo(() => {
    let ours = 0
    let theirs = 0
    let actual = 0
    let pmRows = 0
    let scored = 0
    let flagged = 0
    let matched = 0
    let noTheoretical = 0
    let notScored = 0
    let exceptions = 0
    for (const r of rows) {
      const o = Number(r.Our_Theoretical)
      const t = Number(r.Sys_Potential_COS)
      const a = Number(r.Sys_Consumption)
      if (Number.isFinite(t)) theirs += t
      if (Number.isFinite(a)) actual += a
      if (Number.isFinite(o)) {
        ours += o
        pmRows += 1
      }
      switch (r.MC_Status) {
        case 'Variance':
          flagged += 1
          scored += 1
          break
        case 'Match':
          matched += 1
          scored += 1
          break
        case 'No theoretical':
          noTheoretical += 1
          break
        case 'Data Exception':
          exceptions += 1
          break
        case 'Not Scored':
          notScored += 1
          break
        default:
          break
      }
    }
    return {
      ours,
      theirs,
      actual,
      pmRows,
      scored,
      flagged,
      matched,
      noTheoretical,
      notScored,
      exceptions,
    }
  }, [rows])

  /*
   * The MC match rate over the SCORED population only.
   *
   * Weighted by the article's own theoretical rather than averaged across
   * articles, so a napkin and a beef portion do not carry equal weight in a
   * single headline. Computed from the quantities of the scored rows, which is
   * the same thing the Variance card differences - so the two cards cannot
   * tell different stories about the same rows.
   *
   * Null, not zero, when nothing is scored: an empty selection has no match
   * rate, and 0% would read as total disagreement.
   */
  /*
   * The PM table's population: rows that have a PM theoretical at all.
   *
   * An article no recipe names has no PM side, so it belongs on the MC view
   * and not here - listing it with a dash in every PM column would be three
   * hundred rows of nothing. It is NOT dropped from the page; it is on the
   * view that can say something about it.
   */
  const pmRows = useMemo(
    () => rows.filter((r) => r.Our_Theoretical !== null && r.Our_Theoretical !== undefined),
    [rows]
  )

  const mcMatchPct = useMemo(() => {
    let theoretical = 0
    let gap = 0
    for (const r of rows) {
      if (r.MC_Status !== 'Match' && r.MC_Status !== 'Variance') continue
      const t = Number(r.Sys_Potential_COS)
      const c = Number(r.Sys_Consumption)
      if (!Number.isFinite(t) || !Number.isFinite(c)) continue
      theoretical += Math.max(t, c)
      gap += Math.abs(c - t)
    }
    if (theoretical <= 0) return null
    return Math.max(0, 1 - gap / theoretical)
  }, [rows])

  /*
   * The PM view's paired totals - §5, §6 and §7.
   *
   * EVERY FIGURE IS OVER THE ROWS THAT CARRY BOTH SIDES, never over the whole
   * table. Summing PM across every article and outbound across every article
   * and then comparing the two sums compares different populations: 1,048
   * articles have MC consumption and no PM theoretical at all, and including
   * them on one side only makes the gap look like a measurement when it is a
   * coverage difference.
   *
   * Three separate pairings, kept apart exactly as the brief asks:
   *   engine*    PM against MC theoretical  - rows where both exist.
   *   outbound*  PM against outbound        - rows where both exist.
   *   adjusted*  the MC-adjusted scenario   - rows that meet every condition.
   */
  const pmPaired = useMemo(() => {
    let mc = 0
    let pmForMc = 0
    let engineRows = 0
    let engineWorst = 0
    let engineGap = 0

    let outbound = 0
    let pmForOutbound = 0
    let outboundRows = 0
    let outboundWorst = 0
    let outboundGap = 0

    let adjustedRows = 0
    let adjustedWorst = 0
    let adjustedGap = 0

    for (const r of rows) {
      const pm = Number(r.Our_Theoretical)
      if (!Number.isFinite(pm)) continue

      const t = Number(r.Sys_Potential_COS)
      if (Number.isFinite(t) && Math.max(pm, t) > 0) {
        mc += t
        pmForMc += pm
        engineRows += 1
        engineWorst += Math.max(pm, t)
        engineGap += Math.abs(pm - t)
      }

      const ob = Number(r.Outbound_Qty)
      if (r.Outbound_Qty !== null && Number.isFinite(ob) && Math.max(pm, ob) > 0) {
        outbound += ob
        pmForOutbound += pm
        outboundRows += 1
        outboundWorst += Math.max(pm, ob)
        outboundGap += Math.abs(pm - ob)

        const adj = Number(r.Adjusted_PM)
        if (r.Adjusted_PM !== null && Number.isFinite(adj) && Math.max(adj, ob) > 0) {
          adjustedRows += 1
          adjustedWorst += Math.max(adj, ob)
          adjustedGap += Math.abs(adj - ob)
        }
      }
    }

    const rate = (gap, worst) => (worst > 0 ? Math.max(0, 1 - gap / worst) : null)
    return {
      mc,
      pmForMc,
      engineRows,
      engineMatch: rate(engineGap, engineWorst),
      outbound,
      pmForOutbound,
      outboundRows,
      outboundMatch: rate(outboundGap, outboundWorst),
      adjustedRows,
      adjustedMatch: rate(adjustedGap, adjustedWorst),
    }
  }, [rows])

  /*
   * The months worth drawing, and the last six of them.
   *
   * MEASURED 9 Nov 2026, after the FM Sales Dashboard was republished. May 2026
   * arrived that day holding 1% of a median month's consumption and no
   * theoretical at all; drawn as a month it reads as consumption collapsing.
   * `completeMonths` counts rather than names it, so the next partial load
   * drops out without an edit here.
   */
  const { months: scoredMonths, partial: partialMonths } = useMemo(
    () => completeMonths(rows),
    [rows]
  )
  const sixMonths = useMemo(() => scoredMonths.slice(-6), [scoredMonths])

  /*
   * The articles that ran from the recipe month after month - asked for on
   * 9 Nov 2026, in place of the small multiples removed the same day.
   *
   * ONE fold over the period, three views of it. Ranked by the six-month total
   * rather than by the window on screen, which is the whole point of the
   * request: "so I can get the articles that have high variance during this
   * period, instead of just considering October". The table below still answers
   * for the window - that boundary is named in each panel rather than left to
   * be inferred.
   */
  const period = useMemo(
    () => persistentVarianceArticles(rows, sixMonths, { rank: 'size', limit: 60 }),
    [rows, sixMonths]
  )

  /*
   * The matrix leaves out articles Oracle has no theoretical for - its colour
   * is a SHARE of that theoretical, and a share of nothing cannot go on the
   * scale. They are a different finding (no recipe exists) and they are still
   * in the list and the table below.
   */
  const heat = useMemo(() => period.filter((d) => d.hasTheoretical).slice(0, 20), [period])

  /*
   * The rows where BOTH engines have a figure - 10 Nov 2026.
   *
   * An article only one side knows cannot be a disagreement about the recipe,
   * it is an absence, and scoring it would read as the engines differing by
   * 100% on thousands of consumables MC simply has no recipe for. Those are
   * counted and named instead.
   */
  const engine = useMemo(
    () =>
      rows
        .filter((r) => r.Engine_Diff !== null && r.Engine_Diff !== undefined)
        .sort((a, b) => Math.abs(b.Engine_Diff) - Math.abs(a.Engine_Diff)),
    [rows]
  )
  const engineUnscored = rows.length - engine.length

  /*
   * The branch rows, unfolded from what the server attached - 10 Nov 2026.
   *
   * Built from `rows`, so every slicer the page carries has already been
   * applied and this table cannot disagree with the cards. One row per
   * article per brand per branch; the brand total is the sum of its branches
   * plus whatever the KST MAP could not place, which the panel states.
   */
  const branchRows = useMemo(() => {
    const out = []
    for (const r of rows) {
      if (!Array.isArray(r.MC_By_Branch)) continue
      for (const b of r.MC_By_Branch) {
        const pot = Number(b.potential) || 0
        const cons = Number(b.consumption) || 0
        out.push({
          key: `${r['Item No.']}|${r.CHAINID}|${b.code}`,
          brand: String(r.CHAINID ?? ''),
          code: b.code,
          name: b.name,
          article: String(r['Item No.'] ?? ''),
          item: String(r.Item ?? ''),
          unit: r.Unit ?? 'Unknown',
          potential: pot,
          consumption: cons,
          variance: cons - pot,
          /*
           * The same rules as the article grain, from the same functions -
           * 11 Nov 2026. A branch row used `plainWhScore` and a bare `pot > 0`
           * test, so it could show a negative accuracy and could score a
           * branch where nothing happened. Reconciliation across grains is
           * only meaningful if both grains classify the same way.
           */
          pct: b.pct ?? null,
          accuracy: b.accuracy ?? null,
          status: b.status ?? null,
          mapping: r.Mapping_Status ?? null,
        })
      }
    }
    return out.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
  }, [rows])

  /*
   * Every brand + branch present, for the Branch Detail control.
   *
   * Keyed and labelled by BRAND AND CODE together, never code alone: the codes
   * repeat across brands - ARD is a branch of BBT, PAT, SS, SLC and MM - and
   * 75 of the 96 outlet names collide once normalised. A control offering
   * "ARD" alone would be a filter nobody could use correctly.
   */
  const branchOptions = useMemo(() => {
    const held = new Map()
    for (const b of branchRows) {
      const k = `${b.brand}|${b.code}`
      const n = held.get(k) ?? { key: k, brand: b.brand, code: b.code, name: b.name, rows: 0 }
      n.rows += 1
      held.set(k, n)
    }
    return [...held.values()].sort(
      (a, b) => a.brand.localeCompare(b.brand) || a.code.localeCompare(b.code)
    )
  }, [branchRows])

  /** The brands that actually have branch rows, for the first dropdown. */
  const branchBrands = useMemo(
    () => [...new Set(branchOptions.map((b) => b.brand))].sort(),
    [branchOptions]
  )

  /*
   * The branches offered, narrowed to the chosen brand.
   *
   * Showing all 106 under "All brands" would be the pill row again in a
   * dropdown, so with no brand chosen the second control is disabled and says
   * so rather than listing everything.
   */
  const branchChoices = useMemo(
    () => (branchBrand ? branchOptions.filter((b) => b.brand === branchBrand) : []),
    [branchOptions, branchBrand]
  )

  const branchShown = useMemo(() => {
    if (branchKey) return branchRows.filter((b) => `${b.brand}|${b.code}` === branchKey)
    if (branchBrand) return branchRows.filter((b) => b.brand === branchBrand)
    return branchRows
  }, [branchRows, branchBrand, branchKey])

  /*
   * What the branch rows do NOT cover, so the shortfall is stated rather than
   * discovered. Outlets the KST MAP does not place have no branch to sit on.
   */
  const branchGap = useMemo(() => {
    let placed = 0
    let total = 0
    for (const r of rows) {
      total += Number(r.Sys_Consumption) || 0
      if (Array.isArray(r.MC_By_Branch)) {
        for (const b of r.MC_By_Branch) placed += Number(b.consumption) || 0
      }
    }
    return { placed, total, missing: total - placed }
  }, [rows])

  const branchCount = useMemo(
    () => new Set(branchRows.map((b) => `${b.brand}|${b.code}`)).size,
    [branchRows]
  )

  const noRecipe = useMemo(() => period.filter((d) => !d.hasTheoretical).length, [period])

  /*
   * EVERY article, a column per month - 10 Nov 2026, on request.
   *
   * The same shape as the Power BI view it replaces, with the months
   * aggregated instead of the days. Built from `rows`, which is what the cards
   * and the charts are built from, so the page cannot disagree with itself:
   * every slicer, including the Oracle recipe one, has already been applied.
   */
  const monthly = useMemo(
    () => monthlyVarianceByArticle(rows, sixMonths),
    [rows, sixMonths]
  )

  /*
   * HOW OFTEN IT HAPPENED, not how big it was - 10 Nov 2026, on request.
   *
   * A median-of-the-selection cut was tried first and removed the same day.
   * It answered "which half moved more", which is a relative statement that
   * cannot say whether the articles it keeps matter: half the rows survive by
   * construction, and when the median landed at 20 units over six months the
   * surviving half was still mostly noise.
   *
   * This asks a question the data can actually answer: in how many months did
   * the article go beyond the page's own threshold? The button selects the
   * QUIET ones - none at all, or a single month. One month is an event: a
   * delivery booked late, a stock count on the wrong side of a month end. It
   * is the group to check off rather than investigate, and separating it is
   * what leaves a worklist behind.
   *
   * No new threshold is introduced: "high" is the Flag rule the whole page
   * uses, counted a month at a time.
   */

  /** 'all' | 'quiet' | 'high6'. */
  const [mode, setMode] = useState('all')

  /*
   * MC's own two sides, one row per month - 15 Nov 2026, on request.
   *
   * The MC tab's summary: each month's total consumption against what MC's
   * recipes said. Sits above the per-article table because six rows say
   * whether the gap is steady before anyone scrolls a thousand.
   */
  const mcByMonth = useMemo(() => mcMonthlyTotals(rows, sixMonths), [rows, sixMonths])

  const mcMonthColumns = useMemo(
    () => [
      {
        key: 'month',
        label: 'Month',
        required: true,
        autoWidth: true,
        render: (v) => <strong>{monthLabel(v)}</strong>,
      },
      {
        key: 'theoretical',
        label: 'MC theoretical',
        num: true,
        autoWidth: true,
        total: 'sum',
        renderTotal: fmtQty,
        hint: 'Potential COS QTY — what MC’s recipes say should have been used, summed over every article in the selection.',
        render: qty,
      },
      {
        key: 'consumption',
        label: 'Consumption',
        num: true,
        autoWidth: true,
        total: 'sum',
        renderTotal: fmtQty,
        hint:
          'What stock says was actually used, summed over every article in the selection. Reconciled from Opening + Transfers + Purchase − Closing + Usage, so it carries waste, over-portioning and counting error.',
        render: qty,
      },
      {
        key: 'variance',
        label: 'Variance',
        num: true,
        autoWidth: true,
        strong: true,
        total: 'sum',
        renderTotal: fmtQty,
        hint: 'Consumption minus MC theoretical. Positive means more was used than the recipes explain.',
        render: variance,
      },
      {
        key: 'pct',
        label: 'Variance %',
        num: true,
        autoWidth: true,
        strong: true,
        hint:
          'The month’s variance over the month’s theoretical, across EVERY article. It reads high on purpose: roughly half of MC’s consumption is articles it holds no theoretical for, so their quantity sits in the numerator with nothing under it. The priced-only column beside it is the recipe question.',
        render: pctCell,
      },
      {
        key: 'pctPriced',
        label: 'Variance % (priced only)',
        num: true,
        autoWidth: true,
        hint:
          'The same month, over ONLY the articles MC actually priced. This is the recipe question and the figure comparable with the MC Match % card above — articles MC holds no theoretical for are excluded from both sides rather than inflating the numerator.',
        render: pctCell,
      },
      {
        key: 'articles',
        label: 'Articles',
        num: true,
        autoWidth: true,
        total: 'none',
        hint: 'How many article-brand rows reported in that month.',
        render: (v) => fmtInt(v),
      },
      {
        key: 'articlesPriced',
        label: 'Articles priced',
        num: true,
        autoWidth: true,
        total: 'none',
        hiddenByDefault: true,
        hint: 'Of those, how many MC holds a theoretical for — the basis of the priced-only percentage.',
        render: (v) => fmtInt(v),
      },
    ],
    []
  )

  /*
   * PM against MC, article by article, month by month - 15 Nov 2026.
   *
   * Built from the same six complete months the MC table uses, so the two
   * views cannot be read against different spans.
   */
  const engineMonthly = useMemo(
    () => engineVarianceByArticle(pmRows, sixMonths),
    [pmRows, sixMonths]
  )

  /*
   * THE SAME TABLE PER BRANCH - 18 Nov 2026, on request.
   *
   * "I want to see branch level variance, so add a tab in the table showing
   * branch level monthly variance between MC theoretical and PM theoretical."
   *
   * Fetched only while the branch tab is open: it is a read of its own (one
   * query per brand per month, see server/insights/branchVariance.js) and the
   * page should not pay for it until somebody asks.
   *
   * Folded by the SAME function as the article table, so a month, a variance
   * and a variance % mean exactly the same thing on both tabs. And narrowed to
   * the article-brand pairs the article table is showing, so the page's other
   * filters - unit, category, the MC theoretical slicer - apply here too
   * without the server having to know about any of them.
   */
  const [engineTab, setEngineTab] = useState('article')
  const branchRequest = useMemo(() => {
    const { oracleRecipes: _dropped, ...rest } = filters ?? {}
    return { ...rest, months: sixMonths }
  }, [filters, sixMonths])
  const branchData = useData(api.branchVariance, branchRequest, {
    enabled: Boolean(ready) && view === 'pm' && engineTab === 'branch' && sixMonths.length > 0,
    nonce: refreshNonce,
  })
  const branchMonthly = useMemo(() => {
    const src = branchData.data?.rows
    if (!src?.length) return []
    const canon = (a) => {
      const s = String(a ?? '').trim()
      const n = Number(s)
      return s && Number.isFinite(n) ? String(n) : s
    }
    const shown = new Set(engineMonthly.map((r) => `${canon(r.article)}|${r.brand}`))
    return engineVarianceByArticle(
      src.filter((r) => shown.has(`${canon(r['Item No.'])}|${r.CHAINID}`)),
      sixMonths
    )
  }, [branchData.data, engineMonthly, sixMonths])

  /*
   * The same comparison folded the other way: one row per month.
   *
   * Sits above the per-article table because it is the question people ask
   * first - is the gap steady, and which way does it run?
   */
  const engineByMonth = useMemo(
    () => engineMonthlyTotals(pmRows, sixMonths),
    [pmRows, sixMonths]
  )

  const engineMonthColumns = useMemo(
    () => [
      {
        key: 'month',
        label: 'Month',
        required: true,
        autoWidth: true,
        render: (v) => <strong>{monthLabel(v)}</strong>,
      },
      {
        key: 'mc',
        label: 'MC theoretical',
        num: true,
        autoWidth: true,
        total: 'sum',
        renderTotal: fmtQty,
        hint: 'MC’s own Potential COS QTY, summed over the articles both engines costed that month.',
        render: qty,
      },
      {
        key: 'pm',
        label: 'PM theoretical',
        num: true,
        autoWidth: true,
        total: 'sum',
        renderTotal: fmtQty,
        hint: 'Our recipe explosion over actual PLU sales, summed over the same articles.',
        render: qty,
      },
      {
        key: 'variance',
        label: 'Variance',
        num: true,
        autoWidth: true,
        strong: true,
        total: 'sum',
        renderTotal: fmtQty,
        hint: 'PM theoretical minus MC theoretical. Positive means our explosion asks for more than MC’s.',
        render: variance,
      },
      {
        key: 'pct',
        label: 'Variance %',
        num: true,
        autoWidth: true,
        strong: true,
        hint:
          'The month’s variance as a share of the month’s MC theoretical. Blank where MC priced nothing that month — there is no denominator, and a zero would read as the two engines agreeing.',
        render: pctCell,
      },
      {
        key: 'articles',
        label: 'Articles',
        num: true,
        autoWidth: true,
        total: 'none',
        hint:
          'How many articles carry a figure from BOTH engines that month. The two quantities beside it rest on exactly these articles — an article only one engine costed is excluded from both sides, so the variance is never inflated by a coverage gap.',
        render: (v) => fmtInt(v),
      },
    ],
    []
  )

  /*
   * The engine export, carrying every column for the same reason the MC one
   * does: a file has no Build view.
   */
  const engineExportColumns = useMemo(
    () => [
      { key: 'brand', label: 'Brand' },
      { key: 'article', label: 'Article' },
      { key: 'name', label: 'Name' },
      { key: 'unit', label: 'Unit' },
      ...sixMonths.flatMap((m) => [
        { key: `${m}__mc`, label: `${monthLabel(m)} MC theoretical` },
        { key: `${m}__pm`, label: `${monthLabel(m)} PM theoretical` },
        { key: m, label: `${monthLabel(m)} variance` },
        { key: `${m}__pctOut`, label: `${monthLabel(m)} variance %` },
      ]),
      { key: 'mcTotal', label: `${sixMonths.length} months MC theoretical` },
      { key: 'pmTotal', label: `${sixMonths.length} months PM theoretical` },
      { key: 'avg', label: 'Avg variance per paired month' },
      { key: 'total', label: `${sixMonths.length} months total variance` },
      { key: 'totalPctOut', label: `${sixMonths.length} months variance %` },
      { key: 'monthsPaired', label: 'Months both engines costed' },
    ],
    [sixMonths]
  )

  const engineExportRows = useMemo(() => {
    const pct = (v) =>
      v === null || v === undefined || Number.isNaN(Number(v))
        ? ''
        : Math.round(Number(v) * 1000) / 10
    return engineMonthly.map((d) => {
      const out = { ...d, totalPctOut: pct(d.totalPct) }
      for (const m of sixMonths) out[`${m}__pctOut`] = pct(d[`${m}__pct`])
      return out
    })
  }, [engineMonthly, sixMonths])

  /* The branch tab's export: the same columns, with the branch after the brand. */
  const branchExportColumns = useMemo(() => {
    const [brandCol, ...rest] = engineExportColumns
    return [
      brandCol,
      { key: 'branch', label: 'Branch' },
      { key: 'branchName', label: 'Branch name' },
      ...rest,
    ]
  }, [engineExportColumns])

  const branchExportRows = useMemo(() => {
    const pct = (v) =>
      v === null || v === undefined || Number.isNaN(Number(v))
        ? ''
        : Math.round(Number(v) * 1000) / 10
    return branchMonthly.map((d) => {
      const out = { ...d, totalPctOut: pct(d.totalPct) }
      for (const m of sixMonths) out[`${m}__pctOut`] = pct(d[`${m}__pct`])
      return out
    })
  }, [branchMonthly, sixMonths])

  /*
   * ONE GROUP OF COLUMNS PER MONTH - 15 Nov 2026, on request.
   *
   * Each month carries MC theoretical, PM theoretical, the variance and the
   * variance % under a heading of its own, the way the Article Detail page
   * lays out Forecast qty / Actual qty / ACC% per month.
   *
   * This REPLACED a Variance / Variance % toggle. With both readings and both
   * sides on screen at once the toggle had nothing left to switch, and a
   * control that changes nothing is worse than no control.
   *
   * All four show by default, as the reference table does. That is a wide
   * table - six months of four columns - and width is the price of the layout
   * that was asked for: Freeze holds the article still while the months
   * scroll, and Build view drops any column a reader does not want.
   */
  const engineGroups = useMemo(() => {
    const out = { id: 'Article', total: `${sixMonths.length} months` }
    for (const m of sixMonths) out[m] = monthLabel(m)
    return out
  }, [sixMonths])

  const engineColumns = useMemo(
    () => [
      {
        key: 'brand',
        label: 'Brand',
        group: 'id',
        render: (v) => (v === '(unmapped)' ? <span className="muted">{v}</span> : <Pill>{v}</Pill>),
      },
      { key: 'article', label: 'Article', group: 'id', required: true, autoWidth: true },
      { key: 'name', label: 'Name', group: 'id', autoWidth: true },
      {
        key: 'unit',
        label: 'Unit',
        group: 'id',
        autoWidth: true,
        hiddenByDefault: true,
        render: (v) =>
          v === 'Unknown' ? <span className="muted">Unknown</span> : <Pill tone="plain">{v}</Pill>,
      },
      ...sixMonths.flatMap((m) => [
        {
          key: `${m}__mc`,
          label: 'MC theoretical',
          group: m,
          num: true,
          autoWidth: true,
          total: 'sum',
          renderTotal: fmtQty,
          hint: `MC's own Potential COS QTY for ${monthLabel(m)}.`,
          render: qty,
        },
        {
          key: `${m}__pm`,
          label: 'PM theoretical',
          group: m,
          num: true,
          autoWidth: true,
          total: 'sum',
          renderTotal: fmtQty,
          hint: `Our recipe explosion over the sales that actually happened in ${monthLabel(m)}.`,
          render: qty,
        },
        {
          key: m,
          label: 'Variance',
          group: m,
          num: true,
          autoWidth: true,
          total: 'sum',
          renderTotal: fmtQty,
          hint: 'PM theoretical minus MC theoretical. Positive means our explosion asks for more than MC’s. Blank where only one engine costed the article that month — not a zero, which would claim they agreed.',
          render: (v) => (v === null || v === undefined ? dash() : variance(v)),
        },
        {
          key: `${m}__pct`,
          label: 'Variance %',
          group: m,
          num: true,
          autoWidth: true,
          hint: 'The month’s variance over that month’s MC theoretical. Blank where MC priced nothing — there is no denominator.',
          render: pctCell,
        },
      ]),
      {
        key: 'mcTotal',
        label: 'MC theoretical',
        group: 'total',
        num: true,
        autoWidth: true,
        hiddenByDefault: true,
        total: 'sum',
        renderTotal: fmtQty,
        render: qty,
      },
      {
        key: 'pmTotal',
        label: 'PM theoretical',
        group: 'total',
        num: true,
        autoWidth: true,
        hiddenByDefault: true,
        total: 'sum',
        renderTotal: fmtQty,
        render: qty,
      },
      {
        /*
         * THE AVERAGE MONTH, not the sum - 15 Nov 2026, on request.
         *
         * Divided by the months both engines actually costed, not by six: an
         * article paired in two months has a two-month average, and dividing
         * it by six would scale it down by a third for months the comparison
         * does not exist in. Months paired beside it says what the divisor
         * was.
         */
        key: 'avg',
        label: 'Avg variance / month',
        group: 'total',
        num: true,
        autoWidth: true,
        strong: true,
        total: 'sum',
        renderTotal: fmtQty,
        hint:
          'PM minus MC averaged over the months both engines costed — the typical month, not the six-month total. Over- and under-statement still cancel within an article, so one that swings either way can average near nothing; Months paired says how many months it rests on.',
        render: (v) => (v === null || v === undefined ? dash() : variance(v)),
      },
      {
        key: 'total',
        label: 'Total variance',
        group: 'total',
        num: true,
        autoWidth: true,
        hiddenByDefault: true,
        total: 'sum',
        renderTotal: fmtQty,
        hint:
          'The same gap summed rather than averaged, over the months both engines costed. Kept because it is what the quantity actually was; the average beside it is what a typical month looked like.',
        render: variance,
      },
      {
        key: 'totalPct',
        label: 'Variance %',
        group: 'total',
        num: true,
        autoWidth: true,
        strong: true,
        hint:
          'The plain average of the monthly Variance % figures beside it. Every month MC priced counts equally, whatever its size. A month MC priced nothing in is left out rather than counted as 0% — blank where no month qualifies.',
        render: pctCell,
      },
      {
        key: 'monthsPaired',
        label: 'Months paired',
        group: 'total',
        num: true,
        autoWidth: true,
        hint:
          'How many months carry a figure from BOTH engines. A month only one of them costed is left out rather than shown as a zero.',
        render: (v, row) => (
          <Pill tone="slate">
            {v} of {row.monthsWindow}
          </Pill>
        ),
      },
    ],
    [sixMonths]
  )

  /* The branch tab: the article table's columns with the branch after the brand. */
  const branchColumns = useMemo(() => {
    const [brandCol, ...rest] = engineColumns
    return [
      brandCol,
      {
        key: 'branch',
        label: 'Branch',
        group: 'id',
        required: true,
        autoWidth: true,
        render: (v) => <Pill tone="plain">{v}</Pill>,
      },
      { key: 'branchName', label: 'Branch name', group: 'id', autoWidth: true },
      ...rest,
    ]
  }, [engineColumns])

  /*
   * THE COSTING LIST - 12 Nov 2026, on request.
   *
   * "Articles having variance% greater than 20%, along with their monthly
   * variance% and variance, to share to costing."
   *
   * ABSOLUTE, not signed. A recipe that overstates by 40% distorts a cost just
   * as much as one that understates by 40% - the costing team is reconciling
   * standard cost against what actually moved, and the sign tells them which
   * way to look, not whether to look. The direction is in every figure they
   * get, so nothing is lost by including both.
   *
   * Measured on the SIX-MONTH figure, not on any single month, because that is
   * the one weighted by what each month actually held - see `totalPct`. An
   * article judged on its worst month would put a line that moved four units
   * on the same list as one that moved forty thousand.
   *
   * Articles MC holds no theoretical for are absent by construction: their
   * `totalPct` is null, never a number, so they cannot clear a threshold. That
   * is the right outcome and worth stating - a packaging line consuming
   * 3.8 million against no theoretical is not a 20% variance, it is an
   * unmeasured article, and sending it to costing as a variance would start
   * the wrong investigation.
   */
  const COSTING_THRESHOLD = 0.2
  const overThreshold = (d) =>
    d.totalPct !== null && d.totalPct !== undefined && Math.abs(d.totalPct) > COSTING_THRESHOLD

  const monthlyShown = useMemo(() => {
    if (mode === 'high6') return monthly.filter((d) => d.everyMonth)
    if (mode === 'quiet') return monthly.filter((d) => d.monthsHigh <= 1)
    if (mode === 'over20') return monthly.filter(overThreshold)
    return monthly
  }, [monthly, mode])

  const counts = useMemo(
    () => ({
      all: monthly.length,
      quiet: monthly.filter((d) => d.monthsHigh <= 1).length,
      high6: monthly.filter((d) => d.everyMonth).length,
      over20: monthly.filter(overThreshold).length,
    }),
    [monthly]
  )

  /*
   * THE EXPORT CARRIES BOTH READINGS, ALWAYS - 12 Nov 2026.
   *
   * On screen the Variance / Variance % toggle is right: two readings of the
   * same months, one at a time, in a table you can switch. A FILE has no
   * toggle. Whoever opens it in costing gets whatever was selected when it was
   * saved and no way to see the other half, and a percentage with no quantity
   * beside it cannot be costed - 40% of nothing and 40% of forty thousand are
   * the same number and a different problem.
   *
   * So the export interleaves them: for each month, the quantity then the
   * percentage, then both six-month figures — the same set whichever columns
   * the reader happens to have open in Build view.
   */
  const monthlyExportColumns = useMemo(
    () => [
      { key: 'brand', label: 'Brand' },
      { key: 'article', label: 'Article' },
      { key: 'name', label: 'Name' },
      ...sixMonths.flatMap((m) => [
        { key: `${m}__theo`, label: `${monthLabel(m)} MC theoretical` },
        { key: `${m}__cons`, label: `${monthLabel(m)} consumption` },
        { key: m, label: `${monthLabel(m)} variance` },
        { key: `${m}__pctOut`, label: `${monthLabel(m)} variance %` },
      ]),
      { key: 'totalTheoretical', label: `${sixMonths.length} months MC theoretical` },
      { key: 'consumptionTotal', label: `${sixMonths.length} months consumption` },
      { key: 'total', label: `${sixMonths.length} months variance` },
      { key: 'totalPctOut', label: `${sixMonths.length} months variance %` },
      { key: 'monthsHigh', label: 'Months high' },
      { key: 'monthsScored', label: 'Months scored' },
    ],
    [sixMonths]
  )

  /*
   * Percentages written as NUMBERS OF PER CENT, not as fractions.
   *
   * The CSV writes whatever the field holds, and the fields hold 0.25 for 25%.
   * A column headed "variance %" containing 0.25 is read by a human as a
   * quarter of a per cent, and by Excel as the number 0.25 - neither is what
   * it means. Rounded to one decimal, which is the precision shown on screen;
   * anything finer is noise on a figure derived from a monthly stock count.
   */
  const monthlyExportRows = useMemo(() => {
    const pct = (v) =>
      v === null || v === undefined || Number.isNaN(Number(v))
        ? ''
        : Math.round(Number(v) * 1000) / 10
    return monthlyShown.map((d) => {
      const out = { ...d, totalPctOut: pct(d.totalPct) }
      for (const m of sixMonths) out[`${m}__pctOut`] = pct(d[`${m}__pct`])
      return out
    })
  }, [monthlyShown, sixMonths])

  /*
   * ONE GROUP OF COLUMNS PER MONTH - 15 Nov 2026, on request.
   *
   * The same layout the PM table uses: each month carries MC's theoretical,
   * the consumption, the variance and the variance % under a heading of its
   * own, rather than one column per month in whichever reading was toggled.
   *
   * This REPLACED the Variance / Variance % toggle here. With both readings
   * and both sides on screen the toggle had nothing left to switch.
   *
   * The columns follow the months, so a seventh month or a lost one needs no
   * edit here. Width is handled as the PM table handles it: Freeze holds the
   * identifying columns while the months scroll, Build view drops any of them.
   */
  const monthlyGroups = useMemo(() => {
    const out = { id: 'Article', total: `${sixMonths.length} months` }
    for (const m of sixMonths) out[m] = monthLabel(m)
    return out
  }, [sixMonths])

  const monthlyColumns = useMemo(
    () => [
      {
        key: 'brand',
        label: 'Brand',
        group: 'id',
        render: (v) => (v === '(unmapped)' ? <span className="muted">{v}</span> : <Pill>{v}</Pill>),
      },
      { key: 'article', label: 'Article', group: 'id', required: true, autoWidth: true },
      { key: 'name', label: 'Name', group: 'id', autoWidth: true },
      ...sixMonths.flatMap((m) => [
        {
          key: `${m}__theo`,
          label: 'MC theoretical',
          group: m,
          num: true,
          autoWidth: true,
          total: 'sum',
          renderTotal: fmtQty,
          hint: `Potential COS QTY for ${monthLabel(m)} — what MC's recipes say should have been used.`,
          render: qty,
        },
        {
          key: `${m}__cons`,
          label: 'Consumption',
          group: m,
          num: true,
          autoWidth: true,
          total: 'sum',
          renderTotal: fmtQty,
          hint: `What stock says was actually used in ${monthLabel(m)}. Reconciled from Opening + Transfers + Purchase − Closing + Usage, so it carries waste and counting error.`,
          render: qty,
        },
        {
          key: m,
          label: 'Variance',
          group: m,
          num: true,
          autoWidth: true,
          total: 'sum',
          renderTotal: fmtQty,
          // Undefined is a month MC has no row for. A zero would claim the
          // outlets matched the recipe exactly that month.
          render: (v) => (v === null || v === undefined ? dash() : variance(v)),
        },
        {
          key: `${m}__pct`,
          label: 'Variance %',
          group: m,
          num: true,
          autoWidth: true,
          hint: 'That month’s variance over that month’s theoretical. Blank where MC holds no theoretical — there is no denominator, and a zero would read as agreement.',
          render: pctCell,
        },
      ]),
      {
        key: 'totalTheoretical',
        label: 'MC theoretical',
        group: 'total',
        num: true,
        autoWidth: true,
        hiddenByDefault: true,
        total: 'sum',
        renderTotal: fmtQty,
        render: qty,
      },
      {
        key: 'consumptionTotal',
        label: 'Consumption',
        group: 'total',
        num: true,
        autoWidth: true,
        hiddenByDefault: true,
        total: 'sum',
        renderTotal: fmtQty,
        render: qty,
      },
      {
        key: 'total',
        label: 'Variance',
        group: 'total',
        num: true,
        autoWidth: true,
        strong: true,
        total: 'sum',
        renderTotal: fmtQty,
        hint: 'The article’s variance summed over the months shown. Over-use and under-use cancel, so an article that swings either way can total near nothing — Months high is what says so.',
        render: variance,
      },
      {
        key: 'totalPct',
        label: 'Variance %',
        group: 'total',
        num: true,
        autoWidth: true,
        strong: true,
        hint:
          'The plain average of the monthly Variance % figures beside it. Every month MC priced counts equally, whatever its size. A month MC holds no theoretical for is left out rather than counted as 0% — blank where no month qualifies.',
        render: pctCell,
      },
      {
        key: 'monthsHigh',
        label: 'Months high',
        group: 'total',
        num: true,
        autoWidth: true,
        hint:
          'How many months were beyond 1% of MC’s theoretical AND beyond half a unit — the same rule as the Status column. Counted out of the months that could be JUDGED, not out of the window: a month where MC holds no theoretical cannot be high or low. An article with no theoretical in any month reads “not scored”.',
        render: (v, row) =>
          row.monthsScored > 0 ? (
            <Pill tone={row.everyMonth ? 'amber' : 'slate'}>
              {v} of {row.monthsScored}
            </Pill>
          ) : (
            <span className="muted" title="MC holds no theoretical for this article in any of these months, so none of them can be judged.">
              not scored
            </span>
          ),
      },
    ],
    [sixMonths]
  )

  /*
   * Clicking anything opens the article's MENU ITEMS - 10 Nov 2026.
   *
   * It used to select the article for a per-article chart, and that chart was
   * removed on request. A click that only moved an invisible selection would
   * be a dead control, so every table and the matrix now do what the main
   * table has always done: open the panel showing which menu items use the
   * article and how much of it each takes, which is the question a
   * disagreement about quantity actually raises.
   *
   * `ArticleUsage` takes a row, and the folds carry their own field names, so
   * the two identifying fields are put back into the shape it reads.
   */
  const openUsage = (d) =>
    setUsage({ 'Item No.': d.article, Item: d.name, CHAINID: d.brand === '(unmapped)' ? '' : d.brand })

  /*
   * The months left out, said in the panel rather than silently dropped.
   *
   * There are two ways a month can be missing from the trend and they are not
   * the same finding, so neither is guessed at: a month the source does not
   * hold at all, and a month it holds a fragment of. The second is what May
   * 2026 became when the FM Sales Dashboard was republished on 9 Nov 2026 -
   * 1,710 article-brands against roughly 8,500, and no theoretical.
   */
  const leftOut = useMemo(
    () =>
      partialMonths.map(
        (m) => `${monthLabel(m.month)} (${Math.round(m.share * 100)}% of a normal month)`
      ),
    [partialMonths]
  )

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  return (
    <div className="alvr">
      <header className="alvr__head">
        <div>
          <h2 className="alvr__title">Article-Level Variance Reconciliation</h2>
          <p className="alvr__sub">
            Material Control vs Product Mix — Theoretical and Actual Quantity Analysis
          </p>
        </div>
        <p className="alvr__lede">
          Three separate comparisons, deliberately not combined into one accuracy figure:
          MC’s own theoretical against its own consumption, PM’s theoretical against MC’s, and
          PM’s theoretical against what the warehouse actually issued.
        </p>
      </header>

      <div className="alvr__bar">
        <div className="alvr__views" role="tablist" aria-label="Comparison">
          {[
            ['mc', 'MC Reconciliation', 'MC theoretical vs MC consumption'],
            ['pm', 'PM Historical Reconciliation', 'PM theoretical vs MC and vs outbound'],
            ['branch', 'Branch Detail', 'Brand + branch + article'],
          ].map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              title={hint}
              className={`alvr__view${view === id ? ' alvr__view--on' : ''}`}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {/*
          * The unit control - §9. Every unit is a toggle rather than a
          * dropdown, because the reader's question is almost always "show me
          * only the kilos" and a two-click dropdown for a two-value choice is
          * the thing that made the old filters tiring.
          */}
        <div className="alvr__units">
          <span className="alvr__units-label">Unit</span>
          <button
            type="button"
            className={`alvr__unit${units.length === 0 ? ' alvr__unit--on' : ''}`}
            onClick={() => setUnits([])}
          >
            All
          </button>
          {unitOptions.map((u) => (
            <button
              key={u.unit}
              type="button"
              title={`${fmtInt(u.rows)} articles`}
              className={`alvr__unit${units.includes(u.unit) ? ' alvr__unit--on' : ''}${
                u.unit === 'Unknown' ? ' alvr__unit--muted' : ''
              }`}
              onClick={() =>
                setUnits((held) =>
                  held.includes(u.unit) ? held.filter((x) => x !== u.unit) : [...held, u.unit]
                )
              }
            >
              {u.unit}
            </button>
          ))}
        </div>
      </div>

      {!singleUnit && (
        <InfoBanner tone="warn">
          <strong>{unitsShown.length} units of measurement on screen.</strong> Quantity totals
          are not shown, because{' '}
          {unitsShown
            .slice(0, 3)
            .map((u) => u.unit)
            .join(', ')}
          {unitsShown.length > 3 ? ' and others' : ''} do not add up to anything meaningful.
          Percentages and match rates are unaffected — they are ratios within each article.
          Pick one unit above to see quantities.
        </InfoBanner>
      )}

      {partial && months.length > 0 && (
        <InfoBanner tone="warn">
          <strong>Whole months only.</strong> Oracle records consumption once per article per
          outlet per month, so the dates on screen have been widened to{' '}
          <strong>{months.map(monthLabel).join(', ')}</strong>. The forecast side still covers
          exactly the days you chose, so the two are not measuring the same span.{' '}
          {/*
            * Name the dates rather than saying "pick whole months".
            * 01 Oct - 30 Oct looks like a whole month until you remember
            * October has 31 days, and the reader should not have to.
            */}
          Set the range to{' '}
          <strong>
            {dayLabel(months[0])} – {dayLabel(monthEndOf(months[months.length - 1]))}
          </strong>{' '}
          to compare like for like.
        </InfoBanner>
      )}

      {/*
        * KPIS BY COMPARISON - 11 Nov 2026.
        *
        * Four wide cards used to carry one mixed set and the last one clipped.
        * Each view now gets the cards that belong to ITS question and nothing
        * else, which is the brief's "avoiding one misleading set of combined
        * figures" - and it is also what stops them clipping, because there are
        * never more than four in a row.
        *
        * A QUANTITY card is omitted entirely when more than one unit is on
        * screen - §9 forbids a combined quantity, and an empty card is worse
        * than none. Counts and percentages stay: a count of articles and a
        * ratio within an article are both unit-free.
        */}
      {view === 'mc' && (
        <div className="kpis">
          {/*
            * A SUPPRESSED QUANTITY IS NOT RENDERED AT ALL - 12 Nov 2026, on
            * request.
            *
            * These three used to draw as a dash with "Pick one unit to show
            * quantities" underneath, which gave three large empty cards most
            * of the time - mixed units is the usual state, not the exception.
            * An empty card still claims space and attention and says nothing.
            *
            * The InfoBanner above already explains why quantities are absent,
            * so the explanation is not lost; only the empty frames are. Pick a
            * single unit and all three come back.
            */}
          {singleUnit && (
            <>
              <KpiCard
                label="MC Theoretical"
                value={fmtQty(totals.theirs)}
                foot={`Potential COS QTY${unitLabel ? ` — ${unitLabel}` : ''}`}
                loading={loading}
              />
              <KpiCard
                label="MC Consumption"
                value={fmtQty(totals.actual)}
                foot="What stock says was actually used"
                loading={loading}
              />
              <KpiCard
                label="MC Variance"
                value={fmtQty(totals.actual - totals.theirs)}
                foot={
                  totals.theirs > 0
                    ? `${fmtSignedPct((totals.actual - totals.theirs) / totals.theirs, 1)} against the recipe`
                    : 'no theoretical to compare'
                }
                loading={loading}
              />
            </>
          )}
          <KpiCard
            label="MC Match %"
            value={mcMatchPct === null ? '—' : fmtPct(mcMatchPct, 1)}
            foot={`over ${fmtInt(totals.scored)} articles MC holds a theoretical for`}
            loading={loading}
          />
        </div>
      )}

      {view === 'mc' && (
        <div className="kpis kpis--sub">
          <KpiCard
            label="Articles scored"
            value={fmtInt(totals.scored)}
            foot={`${fmtInt(totals.matched)} match, ${fmtInt(totals.flagged)} beyond 1%`}
            loading={loading}
          />
          <KpiCard
            label="Flagged articles"
            value={fmtInt(totals.flagged)}
            foot="past the 1% tolerance against MC theoretical"
            loading={loading}
            accent={totals.flagged ? 'amber' : undefined}
          />
          <KpiCard
            label="No MC theoretical"
            value={fmtInt(totals.noTheoretical)}
            foot="consumed, but MC holds no figure — never scored"
            loading={loading}
          />
          <KpiCard
            label="Not scored"
            value={fmtInt(totals.notScored)}
            foot="nothing on either side"
            loading={loading}
          />
          <KpiCard
            label="Unresolved mappings"
            value={fmtInt(mappingCounts.Unresolved)}
            foot={`${fmtInt(mappingCounts.Ambiguous)} ambiguous, ${fmtInt(
              mappingCounts['Not in PM']
            )} not in PM`}
            loading={loading}
            accent={mappingCounts.Unresolved ? 'amber' : undefined}
          />
          {totals.exceptions > 0 && (
            <KpiCard
              label="Data exceptions"
              value={fmtInt(totals.exceptions)}
              foot="recipe article with no theoretical"
              loading={loading}
              accent="red"
            />
          )}
        </div>
      )}

      {view === 'pm' && (
        <div className="kpis">
          {/* Same rule as the MC row: no quantity to show, no card. */}
          {singleUnit && (
            <>
              <KpiCard
                label="PM Actual Theoretical"
                value={fmtQty(totals.ours)}
                foot={`actual PLU sales × article qty BU, ${fmtInt(totals.pmRows)} articles`}
                loading={loading}
              />
              <KpiCard
                label="MC Theoretical"
                value={fmtQty(pmPaired.mc)}
                foot="the same articles, MC’s own figure"
                loading={loading}
              />
            </>
          )}
          <KpiCard
            label="PM vs MC Match %"
            value={pmPaired.engineMatch === null ? '—' : fmtPct(pmPaired.engineMatch, 1)}
            foot={`over ${fmtInt(pmPaired.engineRows)} articles both engines cost`}
            loading={loading}
          />
          <KpiCard
            label="PM vs Outbound Match %"
            value={pmPaired.outboundMatch === null ? '—' : fmtPct(pmPaired.outboundMatch, 1)}
            foot={`over ${fmtInt(pmPaired.outboundRows)} articles — historical, not forecast`}
            loading={loading}
          />
        </div>
      )}

      {view === 'pm' && (
        <div className="kpis kpis--sub">
          {singleUnit && (
            <>
              <KpiCard
                label="Actual Warehouse Outbound"
                value={fmtQty(pmPaired.outbound)}
                foot="what the warehouse issued — supply, not consumption"
                loading={loading}
              />
              <KpiCard
                label="PM vs Outbound variance"
                value={fmtQty(pmPaired.outbound - pmPaired.pmForOutbound)}
                foot={
                  pmPaired.pmForOutbound > 0
                    ? `${fmtSignedPct(
                        (pmPaired.outbound - pmPaired.pmForOutbound) / pmPaired.pmForOutbound,
                        1
                      )} against PM theoretical`
                    : 'no PM theoretical to compare'
                }
                loading={loading}
              />
            </>
          )}
          <KpiCard
            label="MC-adjusted PM accuracy"
            value={pmPaired.adjustedMatch === null ? 'Not Available' : fmtPct(pmPaired.adjustedMatch, 1)}
            foot={
              pmPaired.adjustedRows
                ? `indicative — ${fmtInt(pmPaired.adjustedRows)} of ${fmtInt(
                    pmPaired.outboundRows
                  )} articles qualify`
                : 'no article meets every condition for an adjustment'
            }
            loading={loading}
            tint="slate"
          />
        </div>
      )}

      {view === 'mc' && (
      <Panel
        title="MC reconciliation — theoretical vs consumption"
        count={rows.length}
        sub={`Every article in Oracle’s Consumption Qty table, one row per article per brand — ${fmtInt(
          totals.flagged
        )} flagged beyond 1%.${
          unmappedRows
            ? ` ${fmtInt(unmappedRows)} rows are not shown: outlets the KST MAP does not resolve, which sum many sites into one row per article.`
            : ''
        } Sorted worst first. Click a row for the menu items that use it.`}
        busy={loading}
        tools={
          <button
            type="button"
            className="btn"
            disabled={!rows.length}
            onClick={() =>
              downloadCsv(
                exportFileName('Consumption variance', {
                  dateFrom: filters?.dateFrom,
                  dateTo: filters?.dateTo,
                }),
                rows,
                CONSUMPTION_COLUMNS.map(({ key, label }) => ({ key, label })),
                /*
                 * Notes under the table, because almost every column here is
                 * derived and a bare spreadsheet cannot say which side of the
                 * comparison a number came from. The same device the
                 * Replenishment Planning export uses.
                 */
                [
                  ['Months covered', months.map(monthLabel).join(', ')],
                  ...(partial
                    ? [
                        [
                          'WARNING',
                          'The dates chosen are not whole calendar months. Oracle records consumption once per month, so its figures cover the whole month while the forecast side covers only the days selected.',
                        ],
                      ]
                    : []),
                  ['MC Theoretical', 'Potential COS QTY - what MC’s own recipes say should have been used for the sales that happened. MC is Oracle Materials Control, the stock system; the prose below calls it Oracle where it means the system rather than the column.'],
                  ['Consumption', 'Reconciled from stock: Opening + Transfers + Purchase - Closing + Usage. Measured, so it includes waste.'],
                  ['Variance', 'Consumption minus Oracle theoretical - the operational loss. Positive means more was used than the recipe explains. Both sides come from Oracle.'],
                  ['Flag', 'Variance where the two differ by more than 1%, or where the theoretical is nothing and something was consumed. Match within 1%, or within half a unit.'],
                  ['Charts', 'The panels below the table cover every month Oracle holds, not the window selected here.'],
                  ['Not shown', `Outlets the KST MAP does not resolve are left off this page${unmappedRows ? ` — ${fmtInt(unmappedRows)} rows for this selection` : ''}. That bucket sums every unresolved site into one row per article, so it is not comparable with a brand.`],
                  ['MC vs Consumption', '1 - |theoretical - consumption| / the larger of the two. Symmetric and bounded, unlike Variance % beside it. Same formula as Stock Article scores the warehouse forecast with.'],
                  ['Consumption vs Outbound', 'The same formula, scoring two MEASUREMENTS against each other: what the warehouse issued against what the outlet reconciled as consumed. They differ legitimately as stock builds or runs down at the shop, so read it over a long window.'],
                  ['PM vs Outbound', 'The same formula, scoring PM Theoretical against what the warehouse actually issued. Stock Article additionally lifts a row to 100% where the shops hold twice the forecast; that rule is about a shipping forecast and is not applied here.'],
                  ['PM Theoretical', 'Recipe QTY BU x the product quantity that actually sold. A CROSS-CHECK on MC’s theoretical, not part of the variance. Read from the local copy, so a stale copy moves this column alone.'],
                  ['Outbound (actual)', 'What the central warehouse actually issued to this brand’s shops. Measured, and not the same as MC Consumption: that is reconciled from stock at the outlet and carries waste, this is what physically shipped. Blank where the warehouse has no record of the article.'],
                  ['Not included', 'Articles with no recipe line: 2,999 of 4,870 and 36.3% of Oracle’s quantity over April-October 2026. Our side cannot produce a theoretical figure for them.'],
                ]
              )
            }
          >
            <IconDownload size={12} />
            CSV
          </button>
        }
      >
        {rows.length === 0 && !loading ? (
          <Empty title="No article could be compared for these filters">
            Either the FM Sales model could not be reached, or none of these articles appears in
            Oracle’s consumption for the months on screen.
          </Empty>
        ) : (
          <DataTable
            tableId="consumption-variance-2"
            columns={CONSUMPTION_COLUMNS}
            rows={rows}
            groups={GROUPS}
            freezable
            totals
            initialSort={{ key: 'Consumption_Variance', dir: 'desc' }}
            searchPlaceholder="Search article or name…"
            onRowClick={(row) => setUsage(row)}
          />
        )}
      </Panel>
      )}

      {/*
        * PM HISTORICAL RECONCILIATION - 11 Nov 2026, brief §5, §6 and §7.
        *
        * Its own table rather than more columns on the MC one. The MC table
        * had grown to twenty columns across three comparisons, which is what
        * made the group headings crowd and the horizontal scrolling painful;
        * splitting by question is what fixes that, not a smaller font.
        *
        * Same rows, same filters, same drill-down - only the columns differ.
        */}
      {view === 'pm' && (
        <Panel
          title="PM historical reconciliation"
          count={pmRows.length}
          sub={`Every article with a PM theoretical — actual PLU sales × article quantity BU — against MC’s own theoretical and against what the warehouse actually issued. ${fmtInt(
            pmPaired.outboundRows
          )} articles carry both a PM theoretical and an outbound figure. This is a HISTORICAL reconciliation, not forecast accuracy: outbound is what the warehouse supplied, which is not the same as what the shops consumed.`}
          busy={loading}
          tools={
            <button
              type="button"
              className="btn"
              disabled={!pmRows.length}
              onClick={() =>
                downloadCsv(
                  exportFileName('PM reconciliation', {
                    dateFrom: filters?.dateFrom,
                    dateTo: filters?.dateTo,
                  }),
                  pmRows,
                  PM_COLUMNS.map(({ key, label }) => ({ key, label })),
                  [
                    ['Months covered', months.map(monthLabel).join(', ')],
                    [
                      'PM Actual Theoretical',
                      'Actual Product/PLU sales quantity × article quantity BU, summed over every recipe line naming the article.',
                    ],
                    [
                      'MC Theoretical',
                      'Potential COS QTY — MC’s own recipe explosion over the same sales.',
                    ],
                    [
                      'Outbound',
                      'What the central warehouse issued. Supply, not consumption: stock builds up and draws down at the shop in between.',
                    ],
                    [
                      'MC-adjusted PM',
                      'INDICATIVE ONLY. PM theoretical × this article’s own MC consumption/theoretical ratio. Not the official PM accuracy, and never applied across articles or branches.',
                    ],
                    ...(unitsShown.length > 1
                      ? [
                          [
                            'WARNING',
                            `${unitsShown.length} units of measurement are mixed in this export. Quantity columns must not be totalled across them.`,
                          ],
                        ]
                      : []),
                  ]
                )
              }
            >
              <IconDownload size={12} />
              CSV
            </button>
          }
        >
          {pmRows.length === 0 && !loading ? (
            <Empty title="No article carries a PM theoretical for these filters">
              PM theoretical comes from the recipe explosion over actual sales. Either no recipe
              names these articles, or the selected range has no sales behind them.
            </Empty>
          ) : (
            <DataTable
              tableId="pm-reconciliation"
              columns={PM_COLUMNS}
              rows={pmRows}
              groups={PM_GROUPS}
              freezable
              totals
              initialSort={{ key: 'Outbound_Variance', dir: 'desc' }}
              searchPlaceholder="Search article or name…"
              onRowClick={(row) => setUsage(row)}
            />
          )}
        </Panel>
      )}

      {/*
        * EVERY article by brand, a column per month - 10 Nov 2026, on request.
        *
        * The matrix above answers "where should I look" for the top twenty;
        * this answers "what did every article do", which is the view the Power
        * BI page gave day by day. Grouped by brand on open, because that is how
        * it is read and a thousand flat rows would make the reader find the
        * grouping control first.
        */}
      {/*
        * The month-by-month panels come from a SECOND read of the FM Sales
        * Dashboard, and a failed read used to remove all four of them without
        * a word - which is how "I can't find the visual" happens. A panel that
        * cannot be drawn now says so rather than vanishing.
        */}
      {view === 'mc' && !loading && rows.length > 0 && sixMonths.length === 0 && (
        <Panel title="All articles by brand, month by month">
          <Empty title="The month-by-month figures could not be read">
            Oracle’s monthly series comes from a second read of the FM Sales Dashboard, separate
            from the figures in the table below. That read did not return, so the four
            month-by-month panels have nothing to draw. Everything else on this page is
            unaffected — use <strong>Refresh</strong> in the corner to try again.
          </Empty>
        </Panel>
      )}

      {/*
        * CONSUMPTION BY MONTH - 15 Nov 2026, on request.
        *
        * Above the per-article table, matching the PM tab's summary. The
        * months are the six COMPLETE ones the trend holds, not the date
        * slicer: MC records once per article per outlet per month, the slicer
        * is usually set to one month, and one month is not a trend. The
        * figures obey every other slicer - brand, article, category, MC
        * theoretical - so the selection is the page's, only the span is not.
        */}
      {view === 'mc' && mcByMonth.length > 0 && (
        <Panel
          title="Consumption by month"
          count={mcByMonth.length}
          sub={`Each month's total consumption against what MC's recipes said, over ${monthLabel(
            sixMonths[0]
          )} to ${monthLabel(
            sixMonths[sixMonths.length - 1]
          )} — the complete months MC holds, not the dates in the slicer, because MC records once per month and one month is not a trend. Every other slicer still applies. Variance % runs high because it includes articles MC holds no theoretical for; the priced-only column beside it is the recipe question.`}
          busy={loading}
          tools={
            <button
              type="button"
              className="btn"
              disabled={!mcByMonth.length}
              onClick={() =>
                downloadCsv(
                  exportFileName('MC consumption by month', {
                    dateFrom: sixMonths[0],
                    dateTo: monthEndOf(sixMonths[sixMonths.length - 1]),
                  }),
                  mcByMonth.map((d) => ({
                    ...d,
                    month: monthLabel(d.month),
                    pctOut:
                      d.pct === null || d.pct === undefined
                        ? ''
                        : Math.round(Number(d.pct) * 1000) / 10,
                    pctPricedOut:
                      d.pctPriced === null || d.pctPriced === undefined
                        ? ''
                        : Math.round(Number(d.pctPriced) * 1000) / 10,
                  })),
                  [
                    { key: 'month', label: 'Month' },
                    { key: 'theoretical', label: 'MC theoretical' },
                    { key: 'consumption', label: 'Consumption' },
                    { key: 'variance', label: 'Variance' },
                    { key: 'pctOut', label: 'Variance %' },
                    { key: 'pctPricedOut', label: 'Variance % (priced only)' },
                    { key: 'articles', label: 'Articles' },
                    { key: 'articlesPriced', label: 'Articles priced' },
                  ],
                  [
                    ['Months', sixMonths.map(monthLabel).join(', ')],
                    ['Consumption', 'Reconciled from stock: Opening + Transfers + Purchase - Closing + Usage. Measured, so it includes waste.'],
                    ['Variance', 'Consumption minus MC theoretical. Positive means more was used than the recipes explain.'],
                    ['Variance %', 'Over EVERY article. Runs high because articles MC holds no theoretical for put their whole consumption in the numerator with nothing under it. Written as a number of per cent: 25 means 25%.'],
                    ['Variance % (priced only)', 'Over only the articles MC priced. This is the recipe question.'],
                    ['Span', 'The complete months MC holds, not the date slicer - MC records once per article per outlet per month.'],
                  ]
                )
              }
            >
              <IconDownload size={12} />
              CSV
            </button>
          }
        >
          <DataTable
            tableId="mc-by-month"
            columns={mcMonthColumns}
            rows={mcByMonth}
            totals
            searchable={false}
            paginate={false}
          />
        </Panel>
      )}

      {view === 'mc' && monthly.length > 0 && (
        <Panel
          title="All articles by brand, month by month"
          count={monthlyShown.length}
          sub={`Every article in the selection, one row each, with MC’s theoretical, the consumption, the variance and the variance % in each of the ${
            sixMonths.length
          } months — ${monthLabel(sixMonths[0])} to ${monthLabel(
            sixMonths[sixMonths.length - 1]
          )}. Grouped by brand; open the group headings to read them. Amber used more than the recipe explains, blue used less, and a dash is a month MC has no row for — not a month in agreement. Use Freeze to hold the article in place while the months scroll, and Build view to drop any column you do not need.${
            /*
             * The skipped month is named HERE from 10 Nov 2026.
             *
             * It used to be said on the ranked list, which has been removed -
             * and the fact had to move rather than go with it. Six columns
             * where the source holds seven months is exactly the kind of
             * silent gap this page exists to not have.
             */
            leftOut.length
              ? ` ${leftOut.join(' and ')} ${
                  leftOut.length > 1 ? 'are' : 'is'
                } left out — only a fragment of a month is in the source, and a partial load would read as consumption collapsing.`
              : ''
          } Obeys every slicer on the page, so it always agrees with the cards above.`}
          busy={loading}
          tools={
            <>
              {/*
                * Buttons rather than a checkbox: every state is named and
                * carries its own count, so the reader can see what the others
                * would do before pressing one. Ordered widest to narrowest.
                */}
              <div className="choices choices--wrap" role="group" aria-label="Which articles">
                <button
                  type="button"
                  className={`choice choice--tiny${mode === 'all' ? ' choice--on' : ''}`}
                  aria-pressed={mode === 'all'}
                  onClick={() => setMode('all')}
                >
                  All articles ({fmtInt(counts.all)})
                </button>
                <button
                  type="button"
                  className={`choice choice--tiny${mode === 'quiet' ? ' choice--on' : ''}`}
                  aria-pressed={mode === 'quiet'}
                  onClick={() => setMode('quiet')}
                  title="Keeps only the quiet articles: never beyond 1% of Oracle’s theoretical, or beyond it in a single month. One month is usually an event — a late delivery, a stock count landing the wrong side of a month end — rather than a pattern."
                >
                  High in 0–1 months ({fmtInt(counts.quiet)})
                </button>
                <button
                  type="button"
                  className={`choice choice--tiny${mode === 'high6' ? ' choice--on' : ''}`}
                  aria-pressed={mode === 'high6'}
                  onClick={() => setMode('high6')}
                  title={`High in all ${sixMonths.length} months: beyond 1% of Oracle’s theoretical and beyond half a unit, every month.`}
                >
                  High all {sixMonths.length} ({fmtInt(counts.high6)})
                </button>
                <button
                  type="button"
                  className={`choice choice--tiny${mode === 'over20' ? ' choice--on' : ''}`}
                  aria-pressed={mode === 'over20'}
                  onClick={() => setMode('over20')}
                  title="Articles whose six-month variance is more than 20% of MC’s own theoretical, in either direction. Articles MC holds no theoretical for are not here — they have no percentage to exceed a threshold."
                >
                  Over 20% ({fmtInt(counts.over20)})
                </button>
              </div>
              <button
                type="button"
                className="btn"
                disabled={!monthlyShown.length}
                onClick={() =>
                  downloadCsv(
                    exportFileName(
                      mode === 'high6'
                        ? 'Monthly variance - high every month'
                        : mode === 'quiet'
                          ? 'Monthly variance - high in at most one month'
                          : mode === 'over20'
                            ? 'Monthly variance over 20 percent - for costing'
                            : 'Monthly variance by article',
                      { dateFrom: sixMonths[0], dateTo: monthEndOf(sixMonths[sixMonths.length - 1]) }
                    ),
                    monthlyExportRows,
                    monthlyExportColumns,
                    [
                      ['Months', sixMonths.map(monthLabel).join(', ')],
                      ['What this file is', 'One row per article per brand. For each month it carries BOTH the variance in units and the variance as a per cent of MC’s own theoretical, because a percentage cannot be costed without the quantity beside it.'],
                      ['Variance', 'MC’s actual consumption minus MC’s own theoretical (Potential COS QTY), for that month. POSITIVE means more was used than the recipe explains.'],
                      ['Variance %', 'That month’s variance as a per cent of that month’s MC theoretical. Written as a number of per cent: 25 means 25%.'],
                      ['6 months variance %', 'The plain average of the monthly variance % columns, over the months MC priced. Every such month counts equally, whatever its size. Months MC did not price are excluded, not counted as zero. Do not total the monthly per cent columns: percentages do not add.'],
                      ['Blank month', 'MC has no row for the article that month, or holds no theoretical to divide by. NOT a zero, which would mean the outlets matched the recipe exactly.'],
                      ['Months scored', `How many of the ${sixMonths.length} months could be judged at all. A month where MC holds no theoretical cannot be high or low.`],
                      ['Months high', 'Of those, how many were beyond 1% of MC’s theoretical AND beyond half a unit.'],
                      ...(mode === 'over20'
                        ? [
                            ['Filtered', `Only articles whose SIX-MONTH variance is more than 20% of MC’s theoretical, in either direction. ${fmtInt(counts.all - counts.over20)} of ${fmtInt(counts.all)} articles are not shown.`],
                            ['Not in this list', 'Articles MC holds no theoretical for have no percentage and cannot clear the threshold, so they are absent. That is deliberate: consumption measured against no theoretical is an unmeasured article, not a variance.'],
                          ]
                        : []),
                      ...(mode === 'high6'
                        ? [['Filtered', `Only articles high in all ${sixMonths.length} months. ${fmtInt(counts.all - counts.high6)} articles are not shown.`]]
                        : []),
                      ...(mode === 'quiet'
                        ? [['Filtered', `Only the quiet articles: never beyond 1% of MC's theoretical, or beyond it in a single month. ${fmtInt(counts.all - counts.quiet)} articles that did so in two or more months are not shown.`]]
                        : []),
                      ['Source', 'Material Control, Consumption Qty. Consumption is reconciled from stock (Opening + Transfers + Purchase - Closing + Usage) so it includes waste, over-portioning and counting error.'],
                      ['Slicers', 'This export carries exactly what the page was showing, including the MC theoretical filter.'],
                    ]
                  )
                }
              >
                <IconDownload size={12} />
                CSV
              </button>
            </>
          }
        >
          {monthlyShown.length === 0 ? (
            <Empty
              title={
                mode === 'high6'
                  ? `No article was high in all ${sixMonths.length} months`
                  : mode === 'over20'
                    ? 'No article is more than 20% from MC’s theoretical over the six months'
                    : 'Every article was high in two months or more'
              }
            >
              Switch back to <strong>All articles</strong> to see the whole selection.
            </Empty>
          ) : (
            <DataTable
              tableId="consumption-monthly-grouped"
              columns={monthlyColumns}
              groups={monthlyGroups}
              rows={monthlyShown}
              groupable={[{ key: 'brand', label: 'Brand' }]}
              initialGroupBy="brand"
              freezable
              totals
              initialSort={{ key: 'total', dir: 'desc' }}
              searchPlaceholder="Search article or name…"
              onRowClick={openUsage}
            />
          )}
        </Panel>
      )}

      {/*
        * THE PERSISTENT OFFENDERS, asked for on 9 Nov 2026.
        *
        * "Articles that have high variance in the last 6 months (if available,
        * if not until available along with how many months was available)" -
        * so the window is the last six COMPLETE months, every row says how many
        * of them it appears in, and the panel says what the window is.
        *
        * This replaced the small multiples that were briefly here. Six
        * drawings at 190px answered direction and nothing else, which was the
        * same complaint as the sparkline column before them; one article at
        * full width, chosen from this list, answers direction AND size.
        */}
      {/*
        * THE PERIOD OVERVIEW, asked for on 9 Nov 2026.
        *
        * "Show the variance trends of these articles in the last 6 months, so
        * I can get the articles that have high variance during this period,
        * instead of just considering October."
        *
        * Which is a fair complaint about everything else on the page: the
        * table, and the bar chart drawn from it, rank by the window on screen,
        * so a steady six-month gap loses to one bad October. This panel and the
        * two below it rank by the PERIOD, and each says which it is.
        */}
      {/*
        * PM against MC - 10 Nov 2026, on request.
        *
        * Deliberately its own panel rather than two more columns on the table
        * above: that table is about the outlets, this is about the recipes,
        * and ranking by the engine gap would have fought with ranking by the
        * operational variance.
        */}
      {/*
        * BRANCH LEVEL - 10 Nov 2026, on request.
        *
        * Placed after the article tables and before the engine comparison,
        * because it answers "where", and the tables above answer "what".
        */}
      {view === 'branch' && branchRows.length > 0 && (
        <Panel
          title="Branch detail — brand + branch + article"
          count={branchShown.length}
          sub={`Every article opened out to the branch its MC figures came from — ${fmtInt(
            branchCount
          )} branches. The code is the same LocationID the Product Mix page uses, and a branch is identified by brand AND code because the codes repeat across brands. Obeys every slicer on the page.${
            branchGap.missing > 0.5
              ? ` ${fmtQty(branchGap.missing)} of consumption is not on any branch row — outlets the KST MAP does not place — so these rows sum to ${fmtQty(
                  branchGap.placed
                )} against the ${fmtQty(branchGap.total)} on the cards above.`
              : ' These rows sum exactly to the figures on the cards above.'
          }`}
          busy={loading}
          tools={
            <button
              type="button"
              className="btn"
              disabled={!branchShown.length}
              onClick={() =>
                downloadCsv(
                  exportFileName('MC by article and branch', {
                    dateFrom: filters?.dateFrom,
                    dateTo: filters?.dateTo,
                  }),
                  branchShown,
                  BRANCH_COLUMNS.map(({ key, label }) => ({ key, label })),
                  [
                    ['Months covered', months.map(monthLabel).join(', ')],
                    ['Branch code', 'The KST MAP branch code, which is the same LocationID the Product Mix page slices on. Codes repeat across brands, so a branch is brand AND code.'],
                    ['Variance', 'MC consumption minus MC theoretical for this article at this branch.'],
                    ['Not on a branch', `${fmtQty(branchGap.missing)} of consumption belongs to outlets the KST MAP does not place and appears on no branch row.`],
                    ['Slicers', 'This export carries exactly what the page was showing.'],
                  ]
                )
              }
            >
              <IconDownload size={12} />
              CSV
            </button>
          }
        >
          {/*
            * The branch picker - §8, and the only view it appears on.
            *
            * Brand AND code, never code alone: ARD is a branch of five
            * different brands and 75 of the 96 outlet names collide once
            * normalised, so a control offering bare codes would be one nobody
            * could use correctly.
            */}
          <div className="alvr__branches">
            <label className="tgroup">
              <span>Brand</span>
              <select
                value={branchBrand}
                onChange={(e) => {
                  setBranchBrand(e.target.value)
                  // The branches listed are the old brand's; keeping the
                  // selection would filter to a branch no longer on offer and
                  // empty the table with a control still naming it.
                  setBranchKey('')
                }}
              >
                <option value="">All brands</option>
                {branchBrands.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>

            <label className="tgroup">
              <span>Branch</span>
              <select
                value={branchKey}
                disabled={!branchBrand}
                title={
                  branchBrand
                    ? 'Branches of the chosen brand'
                    : 'Choose a brand first — branch codes repeat across brands, so a bare code does not identify an outlet'
                }
                onChange={(e) => setBranchKey(e.target.value)}
              >
                <option value="">
                  {branchBrand ? `All ${branchBrand} branches` : 'Choose a brand first'}
                </option>
                {branchChoices.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </select>
            </label>

            {(branchBrand || branchKey) && (
              <button
                type="button"
                className="alvr__unit"
                onClick={() => {
                  setBranchBrand('')
                  setBranchKey('')
                }}
              >
                Clear
              </button>
            )}

            <span className="alvr__branches-count">
              {branchShown.length === branchRows.length
                ? `${fmtInt(branchCount)} branches`
                : `${fmtInt(branchShown.length)} of ${fmtInt(branchRows.length)} rows`}
            </span>
          </div>

          <DataTable
            tableId="consumption-branch-2"
            columns={BRANCH_COLUMNS}
            rows={branchShown}
            groupable={[
              { key: 'brand', label: 'Brand' },
              { key: 'name', label: 'Branch' },
            ]}
            initialGroupBy="brand"
            freezable
            totals
            initialSort={{ key: 'variance', dir: 'desc' }}
            searchPlaceholder="Search article, name or branch…"
          />
        </Panel>
      )}


      {/*
        * PM AGAINST MC, MONTH BY MONTH - 15 Nov 2026, on request.
        *
        * The PM view's counterpart to the MC view's monthly table: the same
        * six complete months, the same Variance / Variance % toggle, the same
        * fold arithmetic. A gap between two recipe engines that shows up in
        * one month is a data load; one that persists across six is the recipes
        * themselves, and that distinction is the whole reason for the panel.
        */}
      {/*
        * THE MONTHLY SUMMARY - 15 Nov 2026, on request.
        *
        * One row per month, above the per-article table. Both totals rest on
        * the SAME articles - the ones both engines costed that month - so the
        * variance beside them is a like-for-like difference rather than one
        * side's coverage showing up as the other side's disagreement.
        */}
      {view === 'pm' && engineByMonth.length > 0 && (
        <Panel
          title="PM vs MC theoretical, by month"
          count={engineByMonth.length}
          sub={`Both theoreticals summed over the articles BOTH engines costed in that month, so the variance is like for like. An article only one of them priced is excluded from both sides rather than added to one — otherwise a gap in coverage reads as a disagreement. The Articles column says how many pairs each row rests on.`}
          busy={loading}
          tools={
            <button
              type="button"
              className="btn"
              disabled={!engineByMonth.length}
              onClick={() =>
                downloadCsv(
                  exportFileName('PM vs MC theoretical by month - summary', {
                    dateFrom: sixMonths[0],
                    dateTo: monthEndOf(sixMonths[sixMonths.length - 1]),
                  }),
                  engineByMonth.map((d) => ({
                    ...d,
                    month: monthLabel(d.month),
                    pctOut:
                      d.pct === null || d.pct === undefined
                        ? ''
                        : Math.round(Number(d.pct) * 1000) / 10,
                  })),
                  [
                    { key: 'month', label: 'Month' },
                    { key: 'mc', label: 'MC theoretical' },
                    { key: 'pm', label: 'PM theoretical' },
                    { key: 'variance', label: 'Variance' },
                    { key: 'pctOut', label: 'Variance %' },
                    { key: 'articles', label: 'Articles both engines costed' },
                  ],
                  [
                    ['Variance', 'PM theoretical minus MC theoretical. Positive means our explosion asks for more than MC’s.'],
                    ['Variance %', 'The month’s variance over the month’s MC theoretical. Written as a number of per cent: 25 means 25%.'],
                    ['Basis', 'Both quantities are summed over the articles BOTH engines costed that month. An article only one priced is excluded from both sides.'],
                    ['Both sides are theoretical', 'Neither figure carries waste, over-portioning or counting error.'],
                  ]
                )
              }
            >
              <IconDownload size={12} />
              CSV
            </button>
          }
        >
          <DataTable
            tableId="engine-by-month"
            columns={engineMonthColumns}
            rows={engineByMonth}
            totals
            searchable={false}
            paginate={false}
          />
        </Panel>
      )}

      {view === 'pm' && engineMonthly.length > 0 && (
        <Panel
          title={
            engineTab === 'branch'
              ? 'PM vs MC theoretical, month by month, by branch'
              : 'PM vs MC theoretical, month by month'
          }
          count={engineTab === 'branch' ? branchMonthly.length : engineMonthly.length}
          sub={
            engineTab === 'branch'
              ? `Each article's PM theoretical against MC's at each branch, in each of the ${
                  sixMonths.length
                } months — ${monthLabel(sixMonths[0])} to ${monthLabel(
                  sixMonths[sixMonths.length - 1]
                )}. Same columns and colours as the article view, one row per article per branch. A branch is matched by brand AND code, because codes repeat across brands. Only branch-article pairs that BOTH engines costed in at least one month are listed — a branch only one side has (for example a branch MC books nothing for) is an absence, not a variance. Catering's MC theoretical is excluded, as everywhere on this page.${
                  branchData.data?.failed?.length
                    ? ` Could not be read: ${branchData.data.failed.join(', ')}.`
                    : ''
                }`
              : `Each article's PM theoretical against MC's, in each of the ${
                  sixMonths.length
                } months — ${monthLabel(sixMonths[0])} to ${monthLabel(
                  sixMonths[sixMonths.length - 1]
                )}. Each month carries MC's theoretical, ours, the variance and the variance %. Amber means our explosion asks for more than MC's, blue less. A dash is a month only one engine costed, which is not a month they agreed. Use Freeze to hold the article in place while the months scroll, and Build view to drop any column you do not need.`
          }
          busy={engineTab === 'branch' ? branchData.loading : loading}
          tools={
            <>
              <div className="alvr__views" role="tablist" aria-label="Month-by-month grain">
                {[
                  ['article', 'By article'],
                  ['branch', 'By branch'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={engineTab === id}
                    className={`alvr__view${engineTab === id ? ' alvr__view--on' : ''}`}
                    onClick={() => setEngineTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {engineTab === 'branch' ? (
                <button
                  type="button"
                  className="btn"
                  disabled={!branchMonthly.length}
                  onClick={() =>
                    downloadCsv(
                      exportFileName('PM vs MC theoretical by branch by month', {
                        dateFrom: sixMonths[0],
                        dateTo: monthEndOf(sixMonths[sixMonths.length - 1]),
                      }),
                      branchExportRows,
                      branchExportColumns,
                      [
                        ['Months', sixMonths.map(monthLabel).join(', ')],
                        ['What this file is', 'One row per article per brand per BRANCH. For each month it carries MC theoretical, PM theoretical, the difference in units and the difference as a per cent of MC’s theoretical.'],
                        ['PM theoretical', 'Level 1 recipe lines x the units of each PLU sold at that branch that month - the same figure as the article view, split by branch.'],
                        ['MC theoretical', 'MC’s Potential COS QTY for the same brand, branch (KST MAP code) and month. Catering’s theoretical is excluded.'],
                        ['Variance', 'PM minus MC for that month. POSITIVE means our recipe explosion asks for more than MC’s.'],
                        ['Variance %', 'That month’s difference as a per cent of that month’s MC theoretical. Written as a number of per cent: 25 means 25%.'],
                        ['Rows listed', 'Branch-article pairs both engines costed in at least one month. A pair only one side has is an absence, not a variance, and is not listed.'],
                        ['Blank month', 'Only one engine costed the article at that branch that month. NOT a zero.'],
                      ]
                    )
                  }
                >
                  <IconDownload size={12} />
                  CSV
                </button>
              ) : (
              <button
                type="button"
                className="btn"
                disabled={!engineMonthly.length}
                onClick={() =>
                  downloadCsv(
                    exportFileName('PM vs MC theoretical by month', {
                      dateFrom: sixMonths[0],
                      dateTo: monthEndOf(sixMonths[sixMonths.length - 1]),
                    }),
                    engineExportRows,
                    engineExportColumns,
                    [
                      ['Months', sixMonths.map(monthLabel).join(', ')],
                      ['What this file is', 'One row per article per brand. For each month it carries BOTH the difference in units and the difference as a per cent of MC’s theoretical, because a percentage cannot be judged without the quantity beside it.'],
                      ['Variance', 'PM Actual Theoretical minus MC Theoretical for that month. POSITIVE means our recipe explosion asks for more than MC’s.'],
                      ['Variance %', 'That month’s difference as a per cent of that month’s MC theoretical. Written as a number of per cent: 25 means 25%.'],
                      ['Avg variance per paired month', 'The gap averaged over the months both engines costed - the typical month. Divided by the months that have a figure, NOT by six: a month the comparison does not exist in is not a month of zero.'],
                      ['6 months variance %', 'The plain average of the monthly variance % columns, over the months MC priced. Months MC did not price are excluded, not counted as zero. Do not total the monthly per cent columns: percentages do not add.'],
                      ['Blank month', 'Only one engine costed the article that month. NOT a zero, which would mean the two agreed.'],
                      ['Both sides are theoretical', 'Neither figure carries waste, over-portioning or counting error. A gap here is the recipes, the unit of measure, or which product the sales were attributed to.'],
                    ]
                  )
                }
              >
                <IconDownload size={12} />
                CSV
              </button>
              )}
            </>
          }
        >
          {engineTab === 'branch' ? (
            branchData.error ? (
              <ErrorBanner error={branchData.error} onRetry={branchData.reload} />
            ) : !branchData.data && branchData.loading ? (
              <Empty title="Loading branch figures…">
                One read per brand per month - the first open takes a little longer, then it is held.
              </Empty>
            ) : branchMonthly.length === 0 ? (
              <Empty title="No branch has figures from both engines for the articles on screen" />
            ) : (
              <DataTable
                tableId="engine-monthly-branch"
                columns={branchColumns}
                groups={engineGroups}
                rows={branchMonthly}
                groupable={[
                  { key: 'brand', label: 'Brand' },
                  { key: 'branch', label: 'Branch' },
                ]}
                initialGroupBy="branch"
                freezable
                totals
                initialSort={{ key: 'avg', dir: 'desc' }}
                searchPlaceholder="Search article, name or branch…"
              />
            )
          ) : (
            <DataTable
              tableId="engine-monthly-grouped-2"
              columns={engineColumns}
              groups={engineGroups}
              rows={engineMonthly}
              groupable={[{ key: 'brand', label: 'Brand' }]}
              initialGroupBy="brand"
              freezable
              totals
              initialSort={{ key: 'avg', dir: 'desc' }}
              searchPlaceholder="Search article or name…"
              onRowClick={openUsage}
            />
          )}
        </Panel>
      )}

      {view === 'pm' && engine.length > 0 && (
        <Panel
          title="PM vs MC theoretical"
          count={engine.length}
          sub={`The same article costed by both recipe engines, worst disagreement first. Both sides are theoretical — neither carries waste, over-portioning or counting error — so a gap here is the recipes themselves, the unit of measure, or which product the sales were attributed to. This is also the only comparison on the page that our local copy can move, which is how the doubled PAT quantities were caught.${
            engineUnscored
              ? ` ${fmtInt(engineUnscored)} of the ${fmtInt(
                  rows.length
                )} articles on screen are not scored: only one of the two engines has a figure for them, which is an absence rather than a disagreement.`
              : ''
          }`}
          busy={loading}
          tools={
            <button
              type="button"
              className="btn"
              disabled={!engine.length}
              onClick={() =>
                downloadCsv(
                  exportFileName('PM vs MC theoretical', {
                    dateFrom: filters?.dateFrom,
                    dateTo: filters?.dateTo,
                  }),
                  engine,
                  ENGINE_COLUMNS.map(({ key, label }) => ({ key, label })),
                  [
                    ['Months covered', months.map(monthLabel).join(', ')],
                    ['PM Theoretical', 'Recipe QTY BU x the product quantity that actually sold. Read from the local copy.'],
                    ['MC Theoretical', 'Potential COS QTY - what MC’s own recipes say should have been used for the same sales.'],
                    ['Difference', 'PM minus MC. Both sides theoretical, so this is a disagreement about the recipe, not about what the outlets did.'],
                    ['Agreement', '1 - |PM - MC| / the larger of the two. 100% is exact; 50% means one is double the other.'],
                    ['Not scored', `${fmtInt(engineUnscored)} articles where only one engine has a figure. An absence is not a disagreement, so they carry no score.`],
                  ]
                )
              }
            >
              <IconDownload size={12} />
              CSV
            </button>
          }
        >
          <DataTable
            tableId="consumption-engines"
            columns={ENGINE_COLUMNS}
            rows={engine}
            /*
             * Grouping by brand replaces the separate per-brand table that
             * stood above this one until 10 Nov 2026, when it was removed as a
             * duplicate. The group headings carry the same counts and totals,
             * so the brand view is a control away rather than a second table
             * saying the same thing twice.
             */
            groupable={[{ key: 'CHAINID', label: 'Brand' }]}
            freezable
            totals
            initialSort={{ key: 'Engine_Diff', dir: 'desc' }}
            searchPlaceholder="Search article or name…"
            onRowClick={(row) => setUsage(row)}
          />
        </Panel>
      )}

      {view === 'mc' && heat.length > 0 && (
        <Panel
          title={`Top ${heat.length} articles, month by month`}
          count={heat.length}
          sub={`The ${heat.length} articles with the largest variance over ${
            monthLabel(sixMonths[0])
          } – ${monthLabel(sixMonths[sixMonths.length - 1])} as a whole, not in the window on screen. Colour is the gap as a share of Oracle’s own theoretical — comparable between a napkin and a beef portion, where the quantity is not — and the figures beside each row carry the quantity. A hatched cell is a month with no row for that article, which is not the same as a month in agreement. Click a row for its figures.${
            noRecipe
              ? ` ${noRecipe} further ${
                  noRecipe === 1 ? 'article is' : 'articles are'
                } left out here because Oracle has no theoretical for ${
                  noRecipe === 1 ? 'it' : 'them'
                } at all — a share of nothing has no place on the scale. They are still in the list and the table below.`
              : ''
          }`}
          busy={loading}
        >
          <div style={{ padding: 'var(--s4)' }}>
            <VarianceHeatmap
              data={heat}
              months={sixMonths}
              onPick={openUsage}
            />
          </div>
        </Panel>
      )}



      {/*
        * `level1` - 15 Nov 2026, on request. This page counts only the recipe
        * lines where the article is supplied directly to the brand, so the
        * drill-down has to agree with the row that opened it. Stock Article
        * passes nothing and still sees every level.
        */}
      {usage && (
        <ArticleUsage
          article={usage}
          filters={filters}
          level1
          onClose={() => setUsage(null)}
        />
      )}
    </div>
  )
}

export default ConsumptionVariance
