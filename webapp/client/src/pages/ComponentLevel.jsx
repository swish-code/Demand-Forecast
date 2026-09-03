import { useEffect, useMemo, useState } from 'react'
import { api, fmtInt, fmtPct, fmtDate, downloadCsv } from '../api.js'
import { isFutureWindow } from '../window.js'
import { useData } from '../useData.js'
import { W } from '../columns.js'
import { FmNotice, Panel, ErrorBanner, ChartSkeleton, Empty, Pill, MetricCard } from '../components/ui.jsx'
import { BrandTag } from '../components/BrandTag.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { IconDownload } from '../components/Icons.jsx'

/**
 * Production type, coloured by how far through production the item is:
 * bought in, prepped, then assembled into a product article.
 *
 * Three categories is few enough for colour to carry, unlike the nine brands.
 * The label is still spelled out in every pill, so the colour is reinforcement
 * rather than the only way to tell them apart.
 */
const TYPE_TONE = { RAW: 'type-raw', PREP: 'type-prep', PA: 'type-pa' }

const COLUMNS = [
  // Which day the requirement falls on. Hidden by default: with a thirty-day
  // window every component repeats once per day, and most readers open this
  // page for a total rather than a diary. The Columns button turns it on.
  { key: 'Date', label: 'Date', width: 116, hiddenByDefault: true, costly: true, render: fmtDate },
  { key: 'LocationID', label: 'Location', width: 110, hiddenByDefault: true, costly: true },
  /*
   * Which brand a line belongs to.
   *
   * Costly like the other two, and for the same reason: the rows are merged
   * across brands by default, because a component used by two brands is one
   * thing to order. Switching this on stops that merge, so the same article
   * appears once per brand and the row count multiplies.
   */
  {
    key: 'CHAINID',
    label: 'Brand',
    width: W.brand,
    hiddenByDefault: true,
    costly: true,
    render: (v) => (v ? <BrandTag code={v} /> : <span className="muted" title="Issued to the central kitchen or another internal destination, so it belongs to no single brand">–</span>),
  },
  /*
   * Where the row's requirement comes from.
   *
   * Two quite different things sit in this table: components a recipe asks for,
   * and articles the warehouse ships that no recipe mentions at all. They are
   * forecast by different methods and trusted to different degrees, and until
   * now the only clue was the recipe group reading "No recipe — from outbound".
   */
  {
    key: 'Source',
    label: 'Recipe',
    width: 116,
    hiddenByDefault: true,
    render: (_v, row) =>
      String(row?.['Recipe Group'] ?? '').startsWith('No recipe') ? (
        <Pill tone="slate">Non-recipe</Pill>
      ) : (
        <Pill tone="green">Recipe</Pill>
      ),
  },
  // Off by default — asked for on 1 Sep 2026. The table opens on the five
  // columns somebody reads: what it is, what kind, in what unit, what moved and
  // what is needed. Recipe group and the article number are a click away in
  // Build view for anyone who wants them.
  { key: 'Recipe Group', label: 'Recipe group', width: W.group, hiddenByDefault: true },
  // Always shown: the component name is what the row is.
  // "Article", not "Component" — asked for on 2 Sep 2026. It is the thing the
  // warehouse stocks and the thing you order, and the page already carries its
  // number in Article No.
  /*
   * Sized to the names actually in the table.
   *
   * It had no width at all, which made it the column that absorbs whatever is
   * left over — generous when four columns are shown and punishing when
   * fourteen are, which is exactly when the long names matter. Measured
   * instead, with a ceiling so one outlier cannot take the row.
   */
  {
    key: 'Item',
    label: 'Article',
    strong: true,
    required: true,
    // No practical ceiling: the whole point of this column is that the name is
    // never cut off. A very long name makes a wide column and the table
    // scrolls, which is the trade asked for.
    autoWidth: { min: 140, max: 900 },
  },
  {
    key: 'Node Type',
    label: 'Type',
    width: 96,
    render: (v) => (v ? <Pill tone={TYPE_TONE[v] ?? 'slate'}>{v}</Pill> : '–'),
  },
  { key: 'BU', label: 'Unit', autoWidth: true },
  // The ERP article number: the key the warehouse knows this component by, and
  // the reason a consumption figure can be put beside a recipe figure at all.
  { key: 'Item No.', label: 'Article No.', width: 104, hiddenByDefault: true },
  /*
   * Consumed, not "actual".
   *
   * The old actual came from the same place as the forecast — recipe quantities
   * multiplied by sales that happened — so it was a second theoretical figure
   * wearing the word actual. It could not show waste, over-portioning or
   * spillage, because none of those are in a recipe.
   *
   * This one is measured: what the warehouse and the kitchens actually issued to
   * this brand's shops, in the article's own base unit.
   *
   * It is not totalled, and that is deliberate. Consumption belongs to an
   * article, while these rows are split by recipe group, so the figure sits on
   * one row per article and the others are blank. A column total would either
   * count it once per recipe or need an allocation nobody has agreed.
   */
  {
    key: 'Consumed_Qty',
    // Outbound, not "consumed" — asked for on 1 Sep 2026, and it is the more
    // exact word. This is what left the warehouse for this brand's shops. What
    // the shops then actually used is a different quantity nothing measures.
    label: 'Outbound',
    autoWidth: true,
    num: true,
    strong: true,
    group: 'wh',
    /*
     * It does total, and correctly: the figure sits on exactly one row per
     * article and every other row is blank, so adding the column counts each
     * article once. The blanks are the reason — they are not zeros, they mean
     * "counted on another line".
     *
     * Filtering is the case to know about: an article whose carrying row falls
     * outside a search or a recipe-group filter takes its consumption with it
     * while its other rows stay. The total is then of what is on screen, which
     * is what a total under a filtered table means everywhere else.
     */
    total: 'sum',
    renderTotal: fmtInt,
    // A dash is not zero, and the difference matters here. Rather than leave
    // somebody guessing which it is, the blank says why it is blank.
    // Two different blanks, and they mean opposite things, so the tooltip says
    // which. One is "counted on another line of this article"; the other is
    // "the warehouse has no record of this article at all", which is a gap in
    // what can be measured rather than anything about the forecast.
    /*
     * A blank that says which blank it is.
     *
     * Three different things produced the same dash, and one of them looked
     * exactly like a bug: an article the warehouse moves in quantity, but only
     * ever into the central kitchen or the central warehouse. Clear Sauce
     * Container is 6,504,632 units of real movement with nothing going to a
     * shop, so nothing is attributable to a brand — and holding the Warehouse
     * Dashboard beside this page, that reads as missing data rather than as
     * data that belongs to nobody here.
     */
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title={
            row?.No_Article
              ? 'This is a kitchen step, not a stocked article, so it has no ERP article number — and the warehouse can only report movement against an article number. What the kitchen makes here reaches the shops under a different code. Nothing can be matched to it, in any date range.'
              : row?.Consumed_Elsewhere
                ? `Nothing was issued to this brand. The warehouse does ship this article — ${fmtInt(row.Consumed_Elsewhere.qty)} units, mostly to ${row.Consumed_Elsewhere.destination} — but that is an internal transfer, not a shop, so it cannot be attributed to any brand. It reaches the shops later inside a prepared item.`
                : row?.Consumed_Unknown
                  ? 'The warehouse has never issued this article, to this brand or anywhere else. The article code may not match, or it may be bought locally.'
                  : "Counted on this article's largest line. Outbound belongs to an article, so it is shown once rather than repeated on every recipe that uses it — and it is not available at all when the table is split by branch."
          }
        >
          –
        </span>
      ) : (
        fmtInt(v)
      ),
  },
  /*
   * The forecast dashboard's own three figures, banded together.
   *
   * Forecast qty and Actual qty come out of the same recipe at the same
   * quantities, so the recipe cancels and the only difference between them is
   * which sales figure was multiplied by it — predicted or actual. Their
   * accuracy is therefore the sales forecast's accuracy, and nothing to do with
   * the warehouse. Shading them as one block says so without a legend.
   */
  {
    key: 'Component_Forecast_Qty',
    label: 'Forecast qty',
    autoWidth: true,
    num: true,
    group: 'fcst',
    total: 'sum',
    render: fmtInt,
    renderTotal: fmtInt,
  },
  {
    key: 'Component_Actual_Qty',
    label: 'Actual qty',
    autoWidth: true,
    num: true,
    group: 'fcst',
    total: 'sum',
    render: fmtInt,
    renderTotal: fmtInt,
  },
  /*
   * The same article, forecast without touching a recipe.
   *
   * The constant is a rate: how much of this article the warehouse shipped per
   * unit the brand sold, measured over each of the last six whole months and
   * averaged. Multiplied by the sales forecast for the window on screen, it is
   * a requirement derived from what actually happened rather than from what the
   * recipe tree says should happen.
   *
   * It sits beside Forecast qty on purpose. Where the two agree, the recipe is
   * corroborated by six months of warehouse behaviour. Where they disagree, one
   * of them is wrong — and given the recipe explosion double counts across
   * levels and misses 39% of volume entirely, it is worth knowing which rows
   * those are.
   */
  {
    key: 'WH_Constant_Forecast_Qty',
    // Named for what it is rather than how it is built. "Forecast constant WH"
    // described the method; beside a column simply called "Forecast qty" what a
    // reader needs is the difference between them, which is where each figure
    // came from — the recipes, or the warehouse's own history.
    label: 'WH forecast',
    autoWidth: true,
    num: true,
    group: 'wh',
    total: 'sum',
    renderTotal: fmtInt,
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted" title="No warehouse history for this article in the last six months, so there is no ratio to forecast from.">
          –
        </span>
      ) : (
        fmtInt(v)
      ),
  },
  /*
   * This month, so far — and only ever this month.
   *
   * A fixed window that ignores the date slicer entirely: the first of the
   * current month to today. Outbound beside it answers "what moved in the
   * period I am looking at"; this answers "how much of what I am about to
   * order has already gone out this month", and that second question does not
   * change when you go and look at July.
   *
   * Asked of the warehouse directly rather than of the hourly copy — a figure
   * called live has to be — but held for five minutes, because nine brands
   * asking afresh on every request is the burst that gets the whole page
   * refused for a minute.
   */
  {
    key: 'Live_Outbound_MTD',
    label: 'Outbound MTD',
    autoWidth: true,
    num: true,
    total: 'sum',
    renderTotal: fmtInt,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Not available — outbound cannot be split by branch, so this is blank while a branch filter is applied. Otherwise it is the 1st of the current month up to today, whatever date range is selected."
        >
          –
        </span>
      ) : (
        fmtInt(v)
      ),
  },
  /*
   * How close this article's whole requirement came to what actually moved.
   *
   * A property of the article, not of the row, so it reads the same on every
   * recipe group that uses it — the warehouse issues flour, not flour-for-the-
   * burger, and scoring one recipe's share against the article's whole
   * consumption would mark every shared ingredient down for being shared.
   *
   * Blank has one meaning here: the warehouse has never shipped this article to
   * this brand, so there is nothing to score against. An article it does ship
   * and did not ship this window scores a real 0% — that one is a miss.
   *
   * The footer averages the article scores rather than deriving one from the
   * column totals. Each score is already a ratio of two figures in the same
   * unit, so it is unit-free before anything is added; totalling first would
   * let the millions of "Each" decide the number for kilograms too.
   */
  {
    key: 'Accuracy',
    label: 'ACC',
    autoWidth: true,
    num: true,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title={
            row?.Consumed_Unknown
              ? 'The warehouse has never issued this article to this brand, so there is nothing to score against.'
              : 'Not enough to compare — nothing went out for this article in the window.'
          }
        >
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    total: (list) => {
      // Once per article: the score repeats on every row of it.
      const seen = new Map()
      for (const r of list) {
        const a = String(r['Item No.'] ?? '').trim()
        if (!a || r.Accuracy === null || r.Accuracy === undefined) continue
        if (!seen.has(a)) seen.set(a, r.Accuracy)
      }
      if (!seen.size) return null
      return [...seen.values()].reduce((x, y) => x + y, 0) / seen.size
    },
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },
  /*
   * The same measurement, against the warehouse's own forecast.
   *
   * Accuracy beside it scores the recipe explosion: forecast sales multiplied
   * by what the recipes say each sale needs. This one scores the requirement
   * derived from six months of what the warehouse actually shipped. Both are
   * compared against the same Outbound, so the pair says which of the two
   * methods is closer to reality for this article — and where they disagree,
   * which one to believe.
   *
   * Blank when there is no warehouse history to forecast from, which is the
   * same reason WH forecast beside it is blank.
   */
  /*
   * Sales accuracy: the forecast against what the sales actually implied.
   *
   * The other two columns measure the app against the warehouse. This one
   * measures the sales forecast against itself, so a row that scores badly here
   * and well on ACC has a demand problem rather than a recipe problem.
   */
  {
    key: 'Sales_Accuracy',
    label: 'ACC%',
    autoWidth: true,
    num: true,
    group: 'fcst',
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted" title="Nothing has sold in this window yet, so there is nothing to compare the forecast against.">
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    total: (list) => {
      const seen = new Map()
      for (const r of list) {
        const a = String(r['Item No.'] ?? '').trim()
        if (!a || r.Sales_Accuracy === null || r.Sales_Accuracy === undefined) continue
        if (!seen.has(a)) seen.set(a, r.Sales_Accuracy)
      }
      if (!seen.size) return null
      return [...seen.values()].reduce((x, y) => x + y, 0) / seen.size
    },
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },
  {
    key: 'WH_Accuracy',
    label: 'WH ACC%',
    autoWidth: true,
    num: true,
    group: 'wh',
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No warehouse forecast for this article, or nothing measured to compare it against."
        >
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    total: (list) => {
      // Once per article: the score repeats on every row of it.
      const seen = new Map()
      for (const r of list) {
        const a = String(r['Item No.'] ?? '').trim()
        if (!a || r.WH_Accuracy === null || r.WH_Accuracy === undefined) continue
        if (!seen.has(a)) seen.set(a, r.WH_Accuracy)
      }
      if (!seen.size) return null
      return [...seen.values()].reduce((x, y) => x + y, 0) / seen.size
    },
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  }
]

/**
 * The order the columns are read in, declared rather than left to the order
 * they happen to be defined in.
 *
 * The two groups are the point. Each is a question and its answer, side by
 * side: what the forecast said, what actually sold, how close it came — then
 * what the warehouse rate predicted, what it actually issued, how close that
 * came. Reading either one means reading three adjacent numbers, and the
 * shading only works if they are adjacent to begin with.
 *
 * The two that follow belong to neither. Outbound MTD is a different window
 * entirely, and ACC compares across the groups — the recipe's forecast against
 * the warehouse's issue — so putting it inside either would claim it belongs
 * to one of them.
 *
 * Editing this list is how the table is rearranged; the definitions below can
 * then stay grouped by what they do rather than by where they appear.
 */
const COLUMN_ORDER = [
  // What the row is.
  'Date',
  'LocationID',
  'CHAINID',
  'Source',
  'Recipe Group',
  'Item',
  'Node Type',
  'BU',
  'Item No.',
  // Forecast dashboard: predicted, actual, and the gap between them.
  'Component_Forecast_Qty',
  'Component_Actual_Qty',
  'Sales_Accuracy',
  // Warehouse: predicted, issued, and the gap between them.
  'WH_Constant_Forecast_Qty',
  'Consumed_Qty',
  'WH_Accuracy',
  // Neither group.
  'Live_Outbound_MTD',
  'Accuracy',
]

const ORDERED_COLUMNS = (() => {
  const rank = new Map(COLUMN_ORDER.map((key, i) => [key, i]))
  // Anything not named keeps its relative position at the end rather than
  // silently jumping to the front, so a column added below still appears.
  return [...COLUMNS].sort(
    (a, b) => (rank.get(a.key) ?? COLUMN_ORDER.length) - (rank.get(b.key) ?? COLUMN_ORDER.length)
  )
})()

/**
 * The accuracy bands, drawn rather than listed.
 *
 * They were a row of chips, which said which bands exist but not how many
 * articles sat in each: "0–20% 504" beside "20–40% 115" reads as two similar
 * things until you notice one number is four times the other. Bars put the
 * counts on a common scale, so the shape of the problem is the first thing
 * seen rather than something arithmetic has to be done to.
 *
 * Bars are measured against the largest band, not against the total. Against
 * the total the interesting bands — the small, bad ones — would be slivers,
 * and the point of the control is to find them.
 *
 * Colour carries severity, not identity: under 40% is a real problem, 40–60%
 * is worth a look, above that is fine, and "Not scored" is off the scale
 * entirely rather than at the bottom of it. Identity is carried by the label
 * and the count beside every bar, so nothing here depends on seeing colour.
 *
 * Written once and used twice, because there are two of these and they must
 * behave identically.
 */
function BandChart({ label, bands, counts, active, total, onPick }) {
  const peak = Math.max(1, ...bands.map((b) => counts.get(b.key) ?? 0))

  const tone = (b) => {
    if (b.lo === null) return 'none'
    if (b.hi <= 0.4) return 'poor'
    if (b.hi <= 0.6) return 'fair'
    return 'good'
  }

  return (
    <div className="bandchart" role="group" aria-label={`Filter by ${label}`}>
      <div className="bandchart__head">
        <span className="bandchart__label">{label}</span>
        <button
          type="button"
          className={`bandchart__all${active === null ? ' bandchart__all--on' : ''}`}
          onClick={() => onPick(active)}
          aria-pressed={active === null}
        >
          All <span className="bandchart__allcount">{fmtInt(total)}</span>
        </button>
      </div>

      <div className="bandchart__rows">
        {bands.map((b) => {
          const n = counts.get(b.key) ?? 0
          const on = active === b.key
          const share = total ? Math.round((n / total) * 100) : 0
          return (
            <button
              key={b.key}
              type="button"
              disabled={!n}
              aria-pressed={on}
              className={`bandrow${on ? ' bandrow--on' : ''}`}
              onClick={() => onPick(b.key)}
              title={
                n
                  ? `${fmtInt(n)} of ${fmtInt(total)} articles (${share}%) — click to ${
                      on ? 'clear' : 'show only these'
                    }`
                  : 'No articles in this band'
              }
            >
              <span className="bandrow__key">{b.label}</span>
              <span className="bandrow__track">
                <span
                  className={`bandrow__fill bandrow__fill--${tone(b)}`}
                  style={{ width: `${(n / peak) * 100}%` }}
                />
              </span>
              <span className="bandrow__count">{fmtInt(n)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Mirrors the report's COMPONENT LEVEL page. */
export function ComponentLevel({ filters, options, ready, refreshNonce, onLoaded }) {
  /*
   * Which extra dimensions the reader has switched on.
   *
   * Read from the same store the table writes to, and sent with the request:
   * splitting by branch or by day is a different query, not a different way of
   * displaying the same rows.
   */
  const [hiddenCols, setHiddenCols] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('df-cols-component-detail-v2') || 'null')
      return Array.isArray(saved) ? saved : ['Date', 'LocationID']
    } catch {
      return ['Date', 'LocationID']
    }
  })

  const grain = useMemo(
    () =>
      [
        !hiddenCols.includes('Date') && 'date',
        !hiddenCols.includes('LocationID') && 'location',
        !hiddenCols.includes('CHAINID') && 'brand',
      ].filter(Boolean),
    [hiddenCols]
  )

  const request = useMemo(() => ({ ...filters, grain }), [filters, grain])

  const { data, error, loading, reload } = useData(api.componentLevel, request, {
    enabled: ready,
    nonce: refreshNonce,
    onLoaded,
  })

  // Already at the requested grain: asking for Branch or Date changes the
  // query, so there is nothing left to fold together here.
  const rows = data?.rows ?? []

  const busy = loading || !ready

  /**
   * Roll each article back up, and score it.
   *
   * Consumption arrives on one row per article and the requirement is split
   * across every recipe group that uses it, so neither can be read against the
   * other line by line. Adding the requirement back up per article puts both on
   * the same footing, and that is what accuracy is computed from.
   */
  const priced = useMemo(() => {
    const perArticle = new Map()
    for (const r of rows) {
      const a = String(r['Item No.'] ?? '').trim()
      if (!a) continue
      const held = perArticle.get(a) ?? { forecast: null, consumed: 0, wh: null, measured: false }
      /*
       * Null until something contributes, not zero.
       *
       * Articles with no recipe carry no demand figure at all now — there is
       * nothing to explode, and the warehouse constant beside them already says
       * what they need. Starting this at zero turned "no forecast exists" into
       * "the forecast was zero", which scored every one of them at 0% accuracy
       * against real outbound and buried the articles that genuinely were
       * forecast badly.
       */
      if (r.Component_Forecast_Qty !== null && r.Component_Forecast_Qty !== undefined) {
        held.forecast = (held.forecast ?? 0) + (Number(r.Component_Forecast_Qty) || 0)
      }
      if (r.Component_Actual_Qty !== null && r.Component_Actual_Qty !== undefined) {
        held.implied = (held.implied ?? 0) + (Number(r.Component_Actual_Qty) || 0)
      }
      if (r.Consumed_Qty !== null && r.Consumed_Qty !== undefined) {
        held.consumed += Number(r.Consumed_Qty) || 0
        held.measured = true
      }
      /*
       * Added, not taken.
       *
       * It sits on one row per article per brand — never repeated within a
       * brand — so there is nothing to double. But when the same article is
       * used by different recipe groups in different brands the merge keeps
       * those as separate rows, each carrying its own share, and taking one of
       * them threw the rest away.
       *
       * The table folds those rows together and sums this column, so the figure
       * on screen was the total while the figure behind the accuracy was
       * whichever share happened to be read last. CPUSH Sunflower Oil showed
       * 4,070 outbound against 3,887 forecast and scored 2.2%, because the
       * score was being computed against about 89.
       */
      if (r.WH_Constant_Forecast_Qty !== null && r.WH_Constant_Forecast_Qty !== undefined) {
        held.wh = (held.wh ?? 0) + (Number(r.WH_Constant_Forecast_Qty) || 0)
      }
      perArticle.set(a, held)
    }

    return rows.map((r) => {
      const a = String(r['Item No.'] ?? '').trim()
      const held = a ? perArticle.get(a) : null
      const forecast = held
        ? held.forecast
        : r.Component_Forecast_Qty === null || r.Component_Forecast_Qty === undefined
          ? null
          : Number(r.Component_Forecast_Qty) || 0
      /*
       * Divided by the larger of the two, not by the forecast.
       *
       * With the forecast on the bottom the same discrepancy scored two very
       * different ways depending on its direction: an article forecast at 31,268
       * that the warehouse issued 169,500 of came out at −442%, clamped to zero,
       * while the same 5.4x gap the other way scored 18%. 204 of 1,135
       * components were being clamped to zero that way, so the card was largely
       * reporting how often it had run off the end of its own scale.
       *
       * Against the larger figure the answer is symmetric and already between
       * zero and one, so nothing has to be clamped: equal quantities score 100%,
       * one side twice the other scores 50%, and nothing issued scores 0%.
       */
      const score = (target) =>
        held && held.measured && target !== null && (held.consumed > 0 || target > 0)
          ? 1 - Math.abs(held.consumed - target) / Math.max(held.consumed, target)
          : null

      /*
       * How good the sales forecast was, read through this article.
       *
       * Both sides come out of the same recipe at the same quantities, so the
       * recipe cancels: the only thing that differs is which sales figure was
       * multiplied by it. Forecast qty uses the sales we predicted, Implied by
       * sales uses the sales that happened. The gap between them is the sales
       * forecast's error, expressed in this article's own unit.
       *
       * That makes it the one accuracy on the row that is not about the
       * warehouse at all — and the only one a better sales forecast would move.
       */
      const implied = held?.implied ?? null
      /*
       * Divided by the actual, matching the report's own measure.
       *
       *   Variation % MTD = DIVIDE(ActualSales - MonthRunrate, ActualSales)
       *
       * and accuracy is one minus the size of that variation. It was previously
       * divided by the larger of the two, which is symmetric and never leaves
       * the 0..1 range — but it is not the number the brand dashboards report,
       * and two places computing "sales accuracy" differently is worse than one
       * place computing it with a rough edge.
       *
       * The rough edge is inherited: with actual on the bottom, a forecast more
       * than twice the actual scores below zero, and an actual of zero has no
       * answer at all. The first is clamped to zero, the second left blank —
       * DIVIDE's fallback would call it 0% variation, i.e. a perfect forecast
       * against sales that never happened, which is the one reading that is
       * certainly wrong.
       */
      const salesAccuracy =
        implied !== null && implied > 0 && forecast !== null
          ? Math.max(0, 1 - Math.abs(implied - forecast) / implied)
          : null

      return {
        ...r,
        Article_Forecast_Qty: forecast,
        Sales_Accuracy: salesAccuracy,
        Accuracy: score(forecast),
        // The same measurement against the other forecast, so the two methods
        // can be judged on the same evidence rather than on each other.
        WH_Accuracy: score(held?.wh ?? null),
      }
    })
  }, [rows])

  /**
   * One row per combination the reader can actually see.
   *
   * The rows arrive split by recipe group, by production type, by article
   * number — every dimension the query grouped on. Switch a dimension off in
   * Build view and its rows do not merge; they sit there looking identical.
   * "Chili Flakes" appeared nine times in one search, each line a different
   * article number or recipe group, none of them the figure anybody wanted:
   * the requirement for chili flakes is their sum.
   *
   * So the rows are folded together on exactly the columns that are on screen.
   * Turn Recipe group back on and they split again, because then the split is
   * something you can see and act on.
   *
   * Accuracy is not summed — it is a ratio, and adding ratios is meaningless.
   * A group covering one article keeps that article's score, which is already
   * measured across every recipe group it appears in. A group that has merged
   * several articles is re-scored on its own totals, which is the only figure
   * that matches what the row now shows.
   */
  const DIMENSIONS = ['Date', 'LocationID', 'CHAINID', 'Source', 'Recipe Group', 'Item', 'Node Type', 'BU', 'Item No.']

  const visibleDims = useMemo(
    () => DIMENSIONS.filter((k) => !hiddenCols.includes(k)),
    [hiddenCols]
  )

  const grouped = useMemo(() => {
    // Nothing to fold if every dimension is on screen.
    if (visibleDims.length === DIMENSIONS.length) return priced

    const add = (a, b) => {
      if ((a === null || a === undefined) && (b === null || b === undefined)) return null
      return (Number(a) || 0) + (Number(b) || 0)
    }

    const out = new Map()
    for (const r of priced) {
      const key = visibleDims.map((k) => String(r[k] ?? '')).join('')
      const held = out.get(key)
      if (!held) {
        out.set(key, { ...r, __articles: new Set([String(r['Item No.'] ?? '').trim()]) })
        continue
      }
      held.Component_Forecast_Qty = add(held.Component_Forecast_Qty, r.Component_Forecast_Qty)
      held.Component_Actual_Qty = add(held.Component_Actual_Qty, r.Component_Actual_Qty)
      held.Consumed_Qty = add(held.Consumed_Qty, r.Consumed_Qty)
      held.Live_Outbound_MTD = add(held.Live_Outbound_MTD, r.Live_Outbound_MTD)
      held.WH_Constant_Forecast_Qty = add(held.WH_Constant_Forecast_Qty, r.WH_Constant_Forecast_Qty)
      held.__articles.add(String(r['Item No.'] ?? '').trim())
      // Measured anywhere in the group means measured, so one unmatched article
      // does not blank a row that has a real figure in it.
      if (r.Consumed_Qty !== null && r.Consumed_Qty !== undefined) delete held.Consumed_Unknown
    }

    return [...out.values()].map((r) => {
      const articles = [...r.__articles].filter(Boolean)
      delete r.__articles
      if (articles.length <= 1) return r

      const c = r.Consumed_Qty
      const known = c !== null && c !== undefined
      const rescore = (target) =>
        known && target !== null && target !== undefined && (Number(c) > 0 || Number(target) > 0)
          ? 1 - Math.abs(Number(c) - Number(target)) / Math.max(Number(c), Number(target))
          : null
      return {
        ...r,
        // Same rule as above: a folded row with no demand figure has no demand
        // accuracy, rather than an accuracy of zero.
        Accuracy:
          r.Component_Forecast_Qty === null || r.Component_Forecast_Qty === undefined
            ? null
            : rescore(Number(r.Component_Forecast_Qty) || 0),
        WH_Accuracy: rescore(r.WH_Constant_Forecast_Qty),
      }
    })
  }, [priced, visibleDims])

  /*
   * Accuracy bands, for working through the bad ones.
   *
   * The table sorts by accuracy, but sorting only tells you the order — it does
   * not tell you how many are in trouble, and it does not let you take the
   * worst hundred and work through them. Each band carries its own count, so
   * the shape of the problem is visible before anything is clicked.
   *
   * Banded on WH Forecast ACC — asked for on 3 Sep 2026. That is the warehouse's
   * own six-month rate measured against what it actually issued, so a low band
   * is an article whose usage does not behave the way its history says it
   * should: a supply change, a menu change, or a code that has drifted.
   *
   * Articles with no score of their own are a band too. There are hundreds of
   * them and they are not accurate or inaccurate — nothing was measured — so
   * hiding them in "all" would overstate how much of the page is scored.
   */
  const BANDS = [
    { key: '0-20', label: '0–20%', lo: 0, hi: 0.2 },
    { key: '20-40', label: '20–40%', lo: 0.2, hi: 0.4 },
    { key: '40-60', label: '40–60%', lo: 0.4, hi: 0.6 },
    { key: '60-85', label: '60–85%', lo: 0.6, hi: 0.85 },
    { key: '85-100', label: '85–100%', lo: 0.85, hi: 1.0001 },
    { key: 'none', label: 'Not scored', lo: null, hi: null },
  ]

  /*
   * Two measures worth banding, so two rows of bands.
   *
   * They are not the same question and an article can sit in opposite ends of
   * the two: a good forecast against bad warehouse behaviour is a supply
   * change, the reverse is a recipe problem. Filtering on both at once narrows
   * to exactly that intersection, which is the useful thing to be able to ask.
   */
  const [band, setBand] = useState(null)
  const [fcstBand, setFcstBand] = useState(null)

  const inBand = (row, b, key = 'WH_Accuracy') => {
    const v = row[key]
    const scored = v !== null && v !== undefined
    if (b.lo === null) return !scored
    return scored && v >= b.lo && v < b.hi
  }

  const countBands = (rows, key) => {
    const counts = new Map()
    for (const b of BANDS) counts.set(b.key, 0)
    for (const r of rows) {
      for (const b of BANDS) {
        if (inBand(r, b, key)) {
          counts.set(b.key, counts.get(b.key) + 1)
          break
        }
      }
    }
    return counts
  }

  // Counted against what the other band is already showing, so the numbers
  // describe the rows you would actually get rather than the whole table.
  const bandCounts = useMemo(
    () => countBands(fcstBand ? grouped.filter((r) => inBand(r, BANDS.find((x) => x.key === fcstBand), 'Sales_Accuracy')) : grouped, 'WH_Accuracy'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- BANDS is constant
    [grouped, fcstBand]
  )

  const fcstBandCounts = useMemo(
    () => countBands(band ? grouped.filter((r) => inBand(r, BANDS.find((x) => x.key === band), 'WH_Accuracy')) : grouped, 'Sales_Accuracy'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- BANDS is constant
    [grouped, band]
  )

  /** What the table shows: the chosen band, or everything. */
  const banded = useMemo(() => {
    let out = grouped
    if (band) {
      const b = BANDS.find((x) => x.key === band)
      if (b) out = out.filter((r) => inBand(r, b, 'WH_Accuracy'))
    }
    if (fcstBand) {
      const b = BANDS.find((x) => x.key === fcstBand)
      if (b) out = out.filter((r) => inBand(r, b, 'Sales_Accuracy'))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- BANDS is constant
  }, [grouped, band, fcstBand])

  /*
   * What the table reports it is showing. Declared here rather than beside the
   * other view state below, because the memos under it read it — and a `const`
   * read before its declaration is a crash, not a `undefined`.
   */
  const [view, setView] = useState(null)

  /*
   * What the table is actually showing, fed back to everything above it.
   *
   * Search for "Chili Flakes" and the table narrows while the cards keep
   * reporting the whole warehouse — so the two halves of the screen describe
   * different things and neither says which. The table already reports its
   * visible rows through `onViewChange`, for the CSV export; the same set
   * answers this.
   *
   * Matched on article number or on name, because a row may be either: with
   * Article No. hidden the table folds same-named articles into one row that
   * carries only the first one's code, and the name is then the only key that
   * finds the rest. Over-matching two genuinely different articles that share a
   * name cannot mislead here — folded, they are already one row on screen.
   *
   * Band selections come through the same path, so picking 0–20% now moves the
   * cards too. That was not true before and should have been: a card that
   * ignores the filter beside it is a card nobody can trust.
   */
  const shownKeys = useMemo(() => {
    if (!view?.rows) return null
    const set = new Set()
    for (const r of view.rows) {
      const a = String(r['Item No.'] ?? '').trim()
      if (a) set.add(a)
      const n = String(r.Item ?? '').trim()
      if (n) set.add(n)
    }
    return set
  }, [view])

  const focused = useMemo(() => {
    if (!shownKeys) return priced
    return priced.filter((r) => {
      const a = String(r['Item No.'] ?? '').trim()
      if (a && shownKeys.has(a)) return true
      const n = String(r.Item ?? '').trim()
      return Boolean(n) && shownKeys.has(n)
    })
  }, [priced, shownKeys])

  const top = useMemo(
    () => [...focused].sort((a, b) => b.Component_Forecast_Qty - a.Component_Forecast_Qty)[0],
    [focused]
  )

  /**
   * The totals, and how close the requirement came to what actually moved.
   *
   * Two things need saying about the quantities. They add across units of
   * measure — kilograms and pieces in one number — because the page is a list
   * of everything a brand needs, and the cards on the right are where each unit
   * is totalled on its own. The card says so rather than pretending otherwise.
   *
   * Accuracy does not have that problem, and is deliberately computed a
   * different way: per component, then averaged. Each component's accuracy is a
   * ratio of two figures in the same unit, so it is unit-free before anything
   * is added, and a kilogram of flour weighs the same as a box of gloves in the
   * average. Totalling first and dividing after would let the largest "Each"
   * lines decide the number for every unit.
   *
   * Only components with both a requirement and a movement count. One with no
   * transfer is not 0% accurate, it is unmeasured — and scoring it zero would
   * read as a terrible forecast rather than an absent one.
   */
  /*
   * Whether this row's requirement came from a recipe at all.
   *
   * The one test, written once. The recipe group is what the server stamps, and
   * two places deciding "is this a recipe row?" by different means is how the
   * card and the column start disagreeing.
   */
  const fromRecipe = (r) => !String(r['Recipe Group'] ?? '').startsWith('No recipe')

  const summary = useMemo(() => {
    let forecast = 0
    let consumed = 0
    let scored = 0
    let accuracySum = 0
    /*
     * The requirement for the articles the consumption total actually covers.
     *
     * Not the same as `forecast`, and the difference is the point. `forecast` is
     * every row on the page; `consumed` can only be the articles the warehouse
     * has records for. Comparing the two directly counts every unmatched
     * component as a total miss — the same mistake as scoring them zero, made
     * one level up. So the headline compares like with like.
     */
    let matchedForecast = 0
    /*
     * The same pair again, for the warehouse forecast.
     *
     * Kept separate rather than reusing the figures above, because the two are
     * scored over different sets: an article can have a recipe requirement and
     * no warehouse history, or warehouse history and no recipe. Comparing one
     * method's total against the other's set would flatter or punish it for
     * covering different articles.
     */
    let whScored = 0
    let whAccuracySum = 0
    let whMatchedForecast = 0
    let whConsumed = 0
    // Components with a requirement the warehouse has no record of shipping.
    // Counted rather than scored: nothing about them says the forecast is wrong,
    // and scoring them zero is what made this card unreadable.
    const unmatched = new Set()

    /*
     * Scored per article, from the rolled-up figures, so the card and the
     * column agree. Doing it per row compared an article's whole consumption
     * against one recipe group's share of the requirement, which understated
     * accuracy for every component used by more than one recipe.
     */
    const seen = new Set()
    const whSeen = new Set()
    for (const r of focused) {
      /*
       * Non-recipe articles take no part in the Accuracy card — but they are
       * the whole point of the one beside it.
       *
       * Accuracy measures the recipe explosion against what the warehouse
       * issued. An article with no recipe has nothing on the forecast side to
       * measure, so it could only ever enter as outbound with no requirement
       * beside it — adding its whole quantity to the denominator and itself to
       * "unmatched". That is not a bad forecast; it is not a forecast.
       *
       * WH accuracy is the opposite: the constant method is exactly how these
       * articles are forecast, and excluding them would drop the measure's best
       * evidence. So the test scopes the recipe side only, and the loop runs on
       * for both.
       */
      const recipeRow = fromRecipe(r)
      const c = r.Consumed_Qty

      if (recipeRow) {
        forecast += Number(r.Component_Forecast_Qty) || 0
        if (c !== null && c !== undefined) consumed += Number(c) || 0
      }

      const a = String(r['Item No.'] ?? '').trim()
      if (!a) continue

      // The warehouse side, scored over its own set and counted once per
      // article the same way. Every article, recipe or not.
      if (r.WH_Accuracy !== null && r.WH_Accuracy !== undefined && !whSeen.has(a)) {
        whSeen.add(a)
        whAccuracySum += r.WH_Accuracy
        whScored += 1
        whMatchedForecast += Number(r.WH_Constant_Forecast_Qty) || 0
        whConsumed += Number(c) || 0
      }

      if (!recipeRow) continue
      if (r.Accuracy === null) {
        if (r.Consumed_Unknown) unmatched.add(a)
        continue
      }
      if (seen.has(a)) continue
      seen.add(a)
      accuracySum += r.Accuracy
      scored += 1
      // Once per article: the roll-up repeats on every row of it.
      matchedForecast += Number(r.Article_Forecast_Qty) || 0
    }

    /*
     * Two honest answers to "how accurate is this", and they are not the same
     * question.
     *
     * The headline compares the totals, which is what the two cards beside it
     * show and what anybody reading them expects to be able to check by hand.
     * The foot gives the average component, which is far lower — because the
     * totals can agree while every component inside them is wrong, one over-
     * forecast cancelling the next. Both are true; the gap between them is
     * itself the finding, and hiding either one would misrepresent the page.
     *
     * Divided by what actually moved, and floored at zero, so it reads as a
     * percentage of reality rather than of the forecast's own opinion.
     */
    const overall =
      scored && consumed > 0
        ? Math.max(0, 1 - Math.abs(matchedForecast - consumed) / consumed)
        : null

    const whOverall =
      whScored && whConsumed > 0
        ? Math.max(0, 1 - Math.abs(whMatchedForecast - whConsumed) / whConsumed)
        : null

    return {
      forecast,
      consumed,
      measured: scored,
      unmatched: unmatched.size,
      overall,
      perComponent: scored ? accuracySum / scored : null,
      whMeasured: whScored,
      whOverall,
      whPerComponent: whScored ? whAccuracySum / whScored : null,
    }
  }, [focused])

  /**
   * Top components for every unit of measure.
   *
   * Kilograms, litres and "each" cannot share an axis, and one chart per unit
   * would be a wall of charts once a selection spans eight of them. So each unit
   * gets a short ranked list with the bar drawn relative to its own leader —
   * comparable within a unit, never across, which is the only honest reading.
   */
  const facets = useMemo(() => {
    /*
     * One line per component, not one per recipe it appears in.
     *
     * The table splits a component by recipe group, which is right there — you
     * order against the recipe. Ranked, it read as a fault: "Saj Bread Mishmash"
     * four times over, "Chicken Breast Uncalibrated" three times, each one a
     * different recipe group but the names cut off at the same width, so the
     * card looked like it was repeating itself. Worse, none of the four was the
     * real figure for that bread — the requirement is their sum.
     *
     * Adding across recipe groups is the same reasoning the API already applies
     * across brands: a component in two recipes is one thing to order. Adding
     * across units would not be, so that stays split — a kilogram and an "each"
     * share no axis.
     */
    const byUnit = new Map()
    for (const r of focused) {
      const unit = r.BU || '—'
      if (!byUnit.has(unit)) byUnit.set(unit, new Map())
      const items = byUnit.get(unit)
      const key = r.Item
      const prev = items.get(key) ?? { Item: key, Component_Forecast_Qty: 0, Component_Actual_Qty: 0 }
      prev.Component_Forecast_Qty += Number(r.Component_Forecast_Qty) || 0
      prev.Component_Actual_Qty += Number(r.Component_Actual_Qty) || 0
      items.set(key, prev)
    }

    return [...byUnit.entries()]
      .map(([unit, items]) => {
        const ranked = [...items.values()].sort(
          (a, b) => b.Component_Forecast_Qty - a.Component_Forecast_Qty
        )
        return {
          unit,
          // The card scrolls, so the list is not cut to whatever happened to
          // fit. Twenty is where a ranking stops being a ranking.
          rows: ranked.slice(0, 20),
          leader: Number(ranked[0]?.Component_Forecast_Qty) || 0,
          count: ranked.length,
          total: ranked.reduce((a, r) => a + r.Component_Forecast_Qty, 0),
        }
      })
      .sort((a, b) => b.count - a.count)
  }, [focused])

  /*
   * Tomorrow has no actual and never will until it arrives.
   *
   * The same rule the Products table follows: a component requirement for a day
   * nobody has cooked is a plan, not a shortfall, and a column of zeroes beside
   * the forecast reads as one.
   */
  const future = isFutureWindow(filters, options?.dateRange)
  const columns = useMemo(
    () =>
      future
        ? ORDERED_COLUMNS.filter(
            (c) =>
              c.key !== 'Consumed_Qty' &&
              c.key !== 'Accuracy' &&
              c.key !== 'WH_Accuracy' &&
              c.key !== 'Sales_Accuracy'
          )
        : ORDERED_COLUMNS,
    [future]
  )

  /*
   * What the CSV holds.
   *
   * The table tells us the columns it is showing and the rows left after its
   * search box; the download is that, not the full set behind it. Someone who
   * ticks six columns out of twelve and downloads twelve has not exported the
   * view they built. Falls back to everything until the table has reported —
   * which is before the button can be clicked.
   */

  const groups = useMemo(() => new Set(focused.map((r) => r['Recipe Group'])).size, [focused])

  const units = useMemo(() => [...new Set(focused.map((r) => r.BU).filter(Boolean))], [focused])

  if (error) return <ErrorBanner error={error} onRetry={reload} />

  return (
    <>
      {/*
        * Said on the page rather than in a handover note, because this is the
        * page people order from and the gap is not visible in the figures.
        *
        * FM has no forecast model, so nothing here covers it — and it draws on
        * the same warehouse stock: 166 raw articles shared with these brands,
        * some of them almost entirely FM's (eggs read 26,172 here against
        * 497,672 actually issued). A quantity that is 5% of the truth looks
        * exactly like one that is right.
        */}
      <FmNotice detail />

      <div className="metrics">
        <MetricCard
          label="Outbound"
          accent="green"
          progress={summary.forecast ? Math.min(1, summary.consumed / summary.forecast) : 0}
          loading={busy}
          value={summary.measured ? fmtInt(summary.consumed) : '–'}
          foot={
            summary.measured
              ? `Left the warehouse, ${fmtInt(summary.measured)} components measured`
              : 'No transfers matched this view'
          }
        />
        {/*
          * No accuracy on a window that has not happened.
          *
          * Nothing has been issued against a future requirement, so the card
          * reads 0.0% — which looks like a catastrophic forecast rather than an
          * absence of evidence. The columns it summarises are already dropped
          * for a future window; the card was the piece left behind.
          */}
        {!future && (
          <MetricCard
            label="Accuracy"
            accent={summary.overall === null ? 'slate' : summary.overall >= 0.9 ? 'green' : 'amber'}
            progress={summary.overall ?? 0}
            loading={busy}
            value={summary.overall === null ? '–' : fmtPct(summary.overall, 1)}
            foot={
              summary.overall === null
                ? 'Needs outbound to compare against'
                : `Totals compared · ${fmtPct(summary.perComponent, 0)} for the average component` +
                  (summary.unmatched ? ` · ${fmtInt(summary.unmatched)} unmatched` : '')
            }
          />
        )}
        {/*
          * The other forecast, scored the same way.
          *
          * Beside the recipe accuracy rather than instead of it: the two are
          * measured over different sets of articles — one needs a recipe, the
          * other needs six months of warehouse history — so neither is a
          * substitute for the other, and where they disagree is the finding.
          */}
        {!future && (
          <MetricCard
            label="WH ACC%"
            accent={
              summary.whOverall === null ? 'slate' : summary.whOverall >= 0.9 ? 'green' : 'amber'
            }
            progress={summary.whOverall ?? 0}
            loading={busy}
            value={summary.whOverall === null ? '–' : fmtPct(summary.whOverall, 1)}
            foot={
              summary.whOverall === null
                ? 'Needs warehouse history to compare against'
                : `Totals compared · ${fmtPct(summary.whPerComponent, 0)} for the average article · ${fmtInt(
                    summary.whMeasured
                  )} scored`
            }
          />
        )}

        <MetricCard
          label="Articles"
          accent="slate"
          progress={0.72}
          loading={busy}
          value={fmtInt(rows.length)}
          foot={`${fmtInt(groups)} recipe groups`}
        />
        <MetricCard
          label="Largest requirement"
          accent="green"
          progress={1}
          loading={busy}
          textValue
          value={top?.Item ?? '–'}
          foot={top ? `${fmtInt(top.Component_Forecast_Qty)} ${top.BU}` : undefined}
        />
      </div>

      {/* The table first, at full width, and the per-unit rankings beneath it.
          Side by side, the table lost a third of its columns to a column of
          cards that is read after it, not with it. */}
      <Panel
        title="Article detail"
        count={busy ? undefined : `${rows.length.toLocaleString()} rows`}
        sub="What the forecast implies you need, beside what actually left the warehouse"
        flush
        fill
        tools={
          <button
            type="button"
            className="btn"
            disabled={!rows.length}
            onClick={() =>
              downloadCsv(
                'bbt-component-level.csv',
                view?.rows ?? priced,
                view?.columns ?? columns.map(({ key, label }) => ({ key, label }))
              )
            }
          >
            <IconDownload size={12} />
            CSV
          </button>
        }
      >
        {/*
          * The skeleton only before there is anything to show.
          *
          * Swapping the whole table out on every refresh unmounted it, and with
          * it went the search box, the sort and the page you were on — type an
          * article name, change the date, and the table came back showing
          * everything. The search is a question about the data, not about one
          * particular load of it.
          */}
        {busy && !rows.length ? (
          <div style={{ padding: 16 }}>
            <ChartSkeleton height={420} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={banded}
            totals
            initialSort={{ key: 'Component_Forecast_Qty', dir: 'desc' }}
            searchPlaceholder="Search article or group…"
            tableId="component-detail-v2"
            onColumnsChange={setHiddenCols}
            onViewChange={setView}
            groups={{ fcst: 'Demand', wh: 'Warehouse' }}
            fill
          />
        )}
      </Panel>
      {/*
        * One card per unit, three of them, none of them scrolling.
        *
        * These were a single panel holding every unit in a scrolling list, which
        * put the second unit below the fold and the rest out of sight entirely —
        * a ranking nobody scrolls is a ranking nobody reads. Three cards share
        * the column height evenly, so all three are visible at once and the last
        * one ends level with the table beside it.
        *
        * Kilograms and "each" share no axis, so each card draws its bars against
        * its own leader and never across units. Any unit past the third is still
        * in the table on the left, and the note under the stack says so rather
        * than letting it disappear.
        */}
      {/* Under the table it filters, because it is read after the table:
          you look at the figures, then decide which end to work on. */}
      {/*
        * Two rows of bands, under the table they filter.
        *
        * Each counts against what the other is already showing, so the numbers
        * describe the rows you would actually get rather than the whole table —
        * pick a poor warehouse band and the forecast counts beside it narrow to
        * match. Selecting one in each asks for the intersection, which is where
        * the interesting articles are.
        */}
      {!busy && !future && (
        <div className="bandstack">
          <BandChart
            label="WH ACC%"
            bands={BANDS}
            counts={bandCounts}
            active={band}
            total={grouped.length}
            onPick={(k) => setBand(band === k ? null : k)}
          />
          <BandChart
            label="ACC%"
            bands={BANDS}
            counts={fcstBandCounts}
            active={fcstBand}
            total={grouped.length}
            onPick={(k) => setFcstBand(fcstBand === k ? null : k)}
          />
          {(band || fcstBand) && (
            <span className="bands__note">
              Showing {fmtInt(banded.length)} of {fmtInt(grouped.length)} — the CSV and the totals
              row follow this selection.
            </span>
          )}
        </div>
      )}

      <div className="unitrow" style={{ '--cards': busy ? 3 : Math.min(3, Math.max(1, facets.length)) }}>
        {busy ? (
          <>
            <ChartSkeleton height={150} />
            <ChartSkeleton height={150} />
            <ChartSkeleton height={150} />
          </>
        ) : facets.length === 0 ? (
          <Panel title="Top components by unit">
            <Empty />
          </Panel>
        ) : (
          <>
            {facets.slice(0, 3).map((facet) => (
              <Panel
                key={facet.unit}
                title={`Top by ${facet.unit.toLowerCase()}`}
                sub={`${fmtInt(facet.total)} across ${fmtInt(facet.count)} component${
                  facet.count === 1 ? '' : 's'
                } · bars compare within this unit`}
              >
                <ol className="units__list">
                  {facet.rows.map((r) => (
                    <li className="units__row" key={r.Item}>
                      <span className="units__item" title={r.Item}>
                        {r.Item}
                      </span>
                      <span className="units__track" aria-hidden="true">
                        <span
                          className="units__fill"
                          style={{
                            width: `${
                              facet.leader
                                ? Math.max(2, (r.Component_Forecast_Qty / facet.leader) * 100)
                                : 0
                            }%`,
                          }}
                        />
                      </span>
                      <span className="units__value">{fmtInt(r.Component_Forecast_Qty)}</span>
                    </li>
                  ))}
                </ol>
              </Panel>
            ))}
          </>
        )}
      </div>
      {!busy && facets.length > 3 && (
        <p className="unitcol__more">
          {facets.length - 3} further unit{facets.length - 3 === 1 ? '' : 's'} (
          {facets.slice(3).map((f) => f.unit).join(', ')}) — in the table above.
        </p>
      )}
    </>
  )
}
