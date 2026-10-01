import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, fmtInt, fmtQty, fmtPct, fmtDate, downloadCsv } from '../api.js'
import { isFutureWindow } from '../window.js'
import { useData } from '../useData.js'
import { W } from '../columns.js'
import { averageScore, weightedScore } from '../scores.js'
import { FmNotice, Panel, ErrorBanner, ChartSkeleton, Empty, Pill, MetricCard } from '../components/ui.jsx'
import { BrandTag } from '../components/BrandTag.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { whAccuracy, coveredByStock, whRatioAccuracy } from '../whAccuracy.js'
import { ArticleUsage } from '../components/ArticleUsage.jsx'
import { ArticleFinder } from '../components/ArticleFinder.jsx'
import ReplenishmentPlanning from '../components/ReplenishmentPlanning.jsx'
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

/** Ladder order, and how each rung reads. Mirrors whClassify.js on the server. */
const STATUS_TONE = {
  Active: 'green',
  'Slow-Moving': 'amber',
  'Super Slow-Moving': 'amber',
  'Non-Moving': 'red',
  'To Be Deactivated': 'slate',
  'Never shipped': 'slate',
}

/**
 * The cover target the replenishment column aims at, in months.
 *
 * Kept in step with `TARGET_COVER_MONTHS` in `server/insights/storeStock.js`,
 * which is where it was chosen and where the sweep that chose it is written up.
 * It appears here only to be said out loud in a tooltip.
 */
const TARGET_COVER = 1.25

/*
 * Severity, not identity. Every pill carries its own words, so nothing here
 * depends on being able to tell the colours apart.
 */
/*
 * A variance, which is only readable if the sign is unmissable.
 *
 * These two columns are the only place on the page where a negative number is
 * ordinary, and "2,579" against "-2,579" is a difference a reader scanning a
 * column will miss. An explicit + on the positives makes the direction the
 * first thing seen rather than something to work out.
 *
 * A dash, not a zero, when either side is missing: the difference between two
 * quantities one of which does not exist is not nought.
 */
const fmtVariance = (v) => {
  if (v === null || v === undefined) return '–'
  const n = Number(v)
  if (!Number.isFinite(n)) return '–'
  return `${n > 0 ? '+' : ''}${fmtQty(n)}`
}

const SOH_TONE = {
  'No store stock': 'red',
  'Low stock': 'amber',
  Normal: 'green',
  'Store already stocked': 'slate',
}

const SHIPMENT_TONE = {
  'Low stock — urgent': 'red',
  'Shipment required': 'amber',
  'No shipment needed': 'green',
  'Supply constraint': 'slate',
}

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
    /*
     * How long since the warehouse last issued the article.
     *
     * The same ladder the forecast routes on, so a reader who wonders why a row
     * has no warehouse forecast can see the reason in the row rather than
     * having to know the rule. Off by default — the table is already wide, and
     * this matters when it is being asked about rather than always.
     */
    key: 'Status',
    label: 'Status',
    width: 150,
    hiddenByDefault: true,
    render: (v, row) =>
      v ? (
        <span
          title={
            row?.Days_Idle === null || row?.Days_Idle === undefined
              ? undefined
              : `Last shipped ${row.Days_Idle} days before the end of this window`
          }
        >
          <Pill tone={STATUS_TONE[v] ?? 'slate'}>{v}</Pill>
        </span>
      ) : (
        <span className="muted">–</span>
      ),
  },
  {
    key: 'Source',
    label: 'Recipe',
    width: 116,
    hiddenByDefault: true,
    /*
     * Rendered from the row's own `Source` value, not derived here.
     *
     * It used to test the recipe group inside the renderer and ignore the
     * value entirely — which looked identical on screen and exported an empty
     * column, because the CSV writes values and never calls a renderer. The
     * value is now set once, in `priced`, and both the pill and the download
     * read the same field.
     */
    render: (v) =>
      v ? (
        <Pill tone={v === 'Recipe' ? 'green' : 'slate'}>{v}</Pill>
      ) : (
        <span className="muted">–</span>
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
    /*
     * Wide enough for 95% of names exactly, and the rest wrap.
     *
     * Nothing is ever truncated, and the column is not held open by the one
     * 60-character name in three and a half thousand rows.
     */
    autoWidth: { min: 140, max: null, percentile: 0.95 },
    wrap: true,
    // The column that absorbs whatever width is left over, so the table always
    // ends flush with its panel instead of trailing off into white.
    flex: true,
  },
  {
    key: 'Node Type',
    label: 'Type',
    width: 96,
    render: (v) => (v ? <Pill tone={TYPE_TONE[v] ?? 'slate'}>{v}</Pill> : '–'),
  },
  /*
   * What kind of thing the article is, from the Inventory Control article
   * master — the same list the category slicers elsewhere are fed from.
   *
   * "Prepared" is this app's word, not the master's: a PURCHASING master has no
   * category for something the kitchen makes rather than buys, and 359 of the
   * 389 PA items on this page are in that position. A dash would read as
   * missing data where "we make this" is the actual answer.
   *
   * A genuine dash is left for the two bought-in articles the master has never
   * heard of, because calling those Prepared would be a guess dressed as a fact.
   */
  {
    key: 'Category',
    label: 'Category',
    autoWidth: true,
    hint:
      'What kind of article this is, from the Inventory Control article master. ' +
      '"Prepared" means the kitchen makes it rather than buying it, so the ' +
      'purchasing master has no category for it. A dash means the master does ' +
      'not hold the article at all.',
    render: (v) =>
      v ? (
        <Pill tone={v === 'Prepared' ? 'slate' : 'blue'}>{v}</Pill>
      ) : (
        <span className="muted" title="The purchasing article master does not hold this article.">
          –
        </span>
      ),
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
    /*
     * What the kitchens and the bakery issued, for the pages that make things.
     *
     * The column beside this one measures the CENTRAL WAREHOUSE, which is the
     * right question for a bought article and the wrong one for a prepared
     * one: a prepared article is made at the Central Kitchen, the Bakery or
     * the Yelo Factory and issued from there, so the warehouse has no line for
     * it. Put on the Production pages on 29 Sep 2026, the warehouse column
     * read blank on nearly every row - Marinated BBT Chicken tender, BBT
     * Sesame Bun Loaf, Egyptain Bread - all of which move in quantity, from
     * the kitchens.
     *
     * Shown only where the warehouse half is hidden. On Stock Article the
     * warehouse column is the meaningful one and this would be noise.
     */
    key: 'Site_Outbound_Qty',
    label: 'Site outbound',
    hint: 'How much of this article the production sites issued to this brand’s shops over the selected dates — the Central Kitchen, the Bakery or the Yelo Factory. Measured, not forecast. Blank means no site has a record of it, which is different from zero.',
    autoWidth: true,
    num: true,
    strong: true,
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted" title="No production site has issued this article to this brand. That is a gap in what can be measured, not a forecast that missed.">
          –
        </span>
      ) : (
        fmtQty(v)
      ),
  },
  {
    /*
     * Forecast against site outbound, as a bounded score:
     *
     *   1 - |Forecast - Outbound| / MAX(Forecast, Outbound)
     *
     * Changed to this on 29 Sep 2026, from the plain ratio outbound / forecast
     * it carried for a day. The ratio was unbounded above and the page showed
     * 387.7% beside 107.6%, so a column headed ACC% could not be read as a
     * score, sorted usefully or averaged. See `siteAcc` for the full reasoning
     * and for every case that comes out blank.
     *
     * Same expression as WH ACC%, so the two are directly comparable. The cost
     * of that is deliberate: `MAX` treats issuing double and issuing half as the
     * same size of miss, so this column no longer says WHICH WAY the gap went.
     * Site outbound beside it, against Forecast qty, still shows the direction.
     */
    key: 'Site_Acc',
    /*
     * "Actual ACC%" - renamed on request, 29 Sep 2026.
     *
     * There is another column with this label, `Actual_Accuracy` in the
     * variance group. The two never appear together: that one is in
     * NO_WAREHOUSE_COLUMNS and so is absent from exactly the pages this one is
     * shown on. Worth knowing before either is moved.
     */
    label: 'Actual ACC%',
    hint: 'How close the forecast was to what the production sites actually issued: 1 − |Forecast qty − Site outbound| ÷ the larger of the two. Bounded 0–100%, so higher is better, and it reads the same way as WH ACC%. Because it divides by the larger side, issuing double and issuing half score alike — read Site outbound against Forecast qty for the direction. Blank where no site has a record of the article, or where the view has split an article across recipe lines.',
    width: 116,
    num: true,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Nothing to score: either no site has a record of this article, both sides are zero, or this view has split the article across rows and outbound is only known per article."
        >
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    /*
     * Volume-weighted across ARTICLES, built from the quantities rather than
     * from the scores in the column above.
     *
     * It would have been shorter to call `weightedScore(list, 'Site_Acc', ...)`
     * the way WH ACC% does, and it would have been wrong here: those row scores
     * are blank by design on any view that splits an article, so the total would
     * vanish exactly when a reader switched Recipe group on. Scoring the
     * quantities instead keeps the total right in every view.
     *
     * Two rules do the work, and they differ per side:
     *
     *   forecast  SUMMED across an article's rows - the requirement really is
     *             split across recipe lines.
     *   outbound  taken ONCE per article, because the same per-article figure is
     *             stamped on every one of those rows. This is what stops the
     *             double-counting across recipe lines.
     *
     * Then a mean of per-article scores weighted by what moved - not a ratio of
     * the two column totals, which would let one article's over-issue cancel
     * another's under-issue and report a healthier figure than any single
     * article achieved. Each score is floored at 0, as `weightedScore` floors
     * them, so one pathological article cannot drag the mean below zero.
     *
     * Articles with no site record are skipped on both sides together: counting
     * their forecast while they can contribute no outbound would depress the
     * total with rows the column itself declines to score.
     */
    total: (list) => siteAccTotal(list, 'Component_Forecast_Qty'),
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },
  {
    /*
     * The same score against the OTHER forecast, so the comparison is on
     * accuracy and not just on two quantities.
     *
     * Actual ACC% to the left scores the recipe explosion; this scores the site
     * forecast. Identical formula, identical actual, identical population - the
     * only thing that changes is which forecast is being judged, which is the
     * whole point of showing both.
     *
     * Read them together: where this column is higher, the rate model was
     * closer for that article.
     */
    key: 'Site_Fc_Acc',
    label: 'Site fc ACC%',
    hint: 'How close the SITE FORECAST was to what the production sites issued: 1 − |Site forecast − Site outbound| ÷ the larger of the two. The same formula and the same actual as Actual ACC% beside it, which scores the recipe forecast instead — so the two columns compare the two methods directly. Higher is better.',
    width: 116,
    num: true,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Nothing to score: no site forecast for this article, no site outbound to compare against, or both sides are zero."
        >
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    total: (list) => siteAccTotal(list, 'Site_Forecast_Qty'),
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },
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
    renderTotal: fmtQty,
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
        fmtQty(v)
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
  /*
   * A blank here means no recipe, and it is now the only thing a reader sees.
   *
   * Investigated on 13 Sep 2026 because these columns showed "0" for some
   * articles and "-" for others. They were the same articles: ones no recipe
   * names, which carry null on both columns deliberately. The zero was made in
   * `merged()` in routes/api.js, which summed these two fields without listing
   * them in `keepNull`, so null + null came to 0 the moment two brands were
   * selected - and stayed null when one was, because mergeRows returns a single
   * list untouched. Fixed there; both are in `keepNull` now.
   *
   * So a blank means no recipe names this article and there is nothing to
   * explode a sales forecast through. A zero would mean the explosion ran and
   * came to nought, which happens nowhere in the extracted span: every one of
   * the 3,129 rows the copy holds carries a positive figure on both columns.
   * The tooltip says which, rather than leaving it to be guessed.
   */
  {
    key: 'Component_Forecast_Qty',
    label: 'Forecast qty',
    autoWidth: true,
    num: true,
    group: 'fcst',
    total: 'sum',
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No recipe names this article, so there is no sales forecast to explode through one. WH forecast is the figure for these - it comes from what the warehouse actually shipped."
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
    renderTotal: fmtQty,
  },
  {
    /*
     * The SECOND PA forecast, beside the recipe explosion rather than replacing
     * it - asked for on 29 Sep 2026 so the two can be compared row by row.
     *
     * Forecast qty to the left multiplies forecast sales by what the recipes
     * say each sale needs. This asks the warehouse forecast's question of the
     * kitchens instead: for every dinar this brand sold, how much of this
     * article did the production sites have to issue? No recipe is consulted.
     *
     * Backtested on PA articles over four months, both methods on identical
     * rows: 85.3% per article against the explosion's 64.8%, 89.8% against
     * 70.7% by volume, and it removed a standing 24% UNDER-forecast. See
     * server/insights/siteForecast.js for the full measurements and for what
     * this method is NOT - it learns behaviour, not requirement.
     *
     * Blank on every row of an article but one, like the warehouse quantities
     * and unlike Site outbound: a per-article figure repeated down recipe lines
     * is a trap for every total that meets it, which Site outbound proved twice
     * over the same week. A dash here means "counted on another line".
     */
    key: 'Site_Forecast_Qty',
    label: 'Site forecast',
    hint: 'A second forecast for comparison, built from what the production sites actually issued rather than from recipes: this article’s issued-per-sales rate over the last six whole months, applied to the forecast sales for the selected dates. Backtested at 85.3% per article against the recipe explosion’s 64.8%. Blank where no site history exists to forecast from, and shown once per article.',
    autoWidth: true,
    num: true,
    group: 'fcst',
    total: 'sum',
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No production-site history for this article over the training months, so there is no rate to forecast from — or the figure is carried on another line of the same article."
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
    renderTotal: fmtQty,
  },
  {
    key: 'Component_Actual_Qty',
    label: 'Actual qty',
    autoWidth: true,
    num: true,
    group: 'fcst',
    total: 'sum',
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No recipe names this article, so the sales that happened imply no requirement for it. Outbound is what to read instead."
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
    renderTotal: fmtQty,
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
    renderTotal: fmtQty,
    /*
     * A rounded figure is marked, because it is no longer the forecast.
     *
     * Where a standard package size exists this is the quantity rounded UP to
     * whole packs — what you would order. The dot says so at a glance and the
     * tooltip gives the original, so a reader is never left wondering whether a
     * number is a prediction or a package.
     */
    render: (v, r) =>
      v === null || v === undefined ? (
        <span className="muted" title="No warehouse history for this article in the last six months, so there is no ratio to forecast from.">
          –
        </span>
      ) : r?.WH_Rounded ? (
        <span
          title={`Rounded up to whole packs of ${r.Pack_Size} ${r.Pack_Unit ?? ''}. The forecast itself was ${fmtQty(r.WH_Forecast_Unrounded)}. WH ACC% is still scored on that unrounded figure.`.replace('  ', ' ')}
        >
          {fmtQty(v)} <span className="pill pill--blue">pkg</span>
        </span>
      ) : (
        fmtQty(v)
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
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Not available — outbound cannot be split by branch, so this is blank while a branch filter is applied. Otherwise it is the 1st of the current month up to today, whatever date range is selected."
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
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
  /*
   * How the day's sales went, not how this article's did.
   *
   * One number per trading day — total actual sales against total forecast
   * sales — repeated on every row of that day, because that is what it is: a
   * property of the day. Asked for on 5 Sep 2026, and the repetition is the
   * point rather than a fault.
   *
   * It answers a different question from every other accuracy here. ACC% beside
   * it is this article's own demand error; this is the trading day's. A day that
   * went badly explains a whole column of poor article scores at once, and no
   * per-article figure can show you that.
   *
   * Split the table by Date in Build view and it varies by day. Left whole, it
   * is the window's total, which is the same calculation over a longer period.
   */
  {
    key: 'Sales_Day_Accuracy',
    label: 'Sales ACC%',
    autoWidth: true,
    num: true,
    render: (v) =>
      v === null || v === undefined ? (
        <span className="muted" title="No sales recorded for this period, so there is nothing to compare the sales forecast against.">
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    // Not summed and not averaged across rows: every row carries the same
    // figure for its day, so the window's own total is the honest footer.
    total: (list) => (list.length ? (list[0].Sales_Day_Accuracy ?? null) : null),
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },
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
    /*
     * The totals compared, not the average of the rows' scores.
     *
     * Averaging gave a figure nothing else on screen could produce: two rows at
     * 99.0% and 92.6% averaged to 95.8%, while the column totals directly above
     * it said 39,740 against 40,178, which is 98.9%. Both were defensible and
     * neither could be checked against the other.
     *
     * Computed from the same two totals the row shows, so it is arithmetic
     * anybody can repeat, and identical to the card above by construction.
     */
    // The average article, computed exactly as the card above it is.
    total: (list) => averageScore(list, 'Sales_Accuracy')?.value ?? null,
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },
  {
    key: 'WH_Accuracy',
    label: 'WH ACC%',
    autoWidth: true,
    num: true,
    group: 'wh',
    hint:
      'How close the warehouse forecast was to what actually shipped: 1 - |forecast - outbound| / the larger of the two. From 26 Sep 2026 a row also scores 100% when the shops already held at least twice the forecast, because not shipping was then the correct outcome — those rows are marked, since a stock-driven 100% is not the same claim as an accurate forecast.',
    render: (v, r) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No warehouse forecast for this article, or nothing measured to compare it against."
        >
          –
        </span>
      ) : r?.WH_Acc_Covered ? (
        /*
         * Marked, not hidden.
         *
         * Four rows in five meet the stock condition, so without a mark the
         * column would read as a near-perfect forecast everywhere and nobody
         * could tell which figures were earned. The dot says "this 100% came
         * from the shops being stocked, not from the forecast being right".
         */
        <span
          className="wh-acc--stock"
          title="Scored 100% because the shops already held at least twice this forecast, so the warehouse was right not to ship. This is not a measure of how accurate the forecast was."
        >
          {fmtPct(v, 1)}
          <span aria-hidden="true"> •</span>
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    /*
     * Volume weighted, so the footer and the card are the same figure.
     *
     * This was the unweighted average article, which is a different and equally
     * valid question — but the card above the table dropped its "average
     * article" line on 21 Sep 2026, so the two were left reading 74.4% here and
     * 85.9% there with nothing on the page to explain the gap. Two answers to
     * one question in one view is worse than either answer.
     *
     * Weighted by what the warehouse actually issued, never by the forecast:
     * weighting by the forecast would let the thing being judged decide how
     * much it counts.
     */
    total: (list) => weightedScore(list, 'WH_Accuracy', 'Consumed_Qty')?.value ?? null,
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },
  {
    /*
     * The directional score, beside the symmetric one.
     *
     * WH ACC% asks "how close was it", and treats shipping double and shipping
     * half as the same size of miss. This asks "how much went out against what
     * we said", so it has a direction: over 100% means more shipped than
     * forecast, under means less. It is unbounded above - 49 articles are over
     * 300% on a three-week window - which is why its footer is a plain mean
     * and not dressed up as an accuracy.
     *
     * The stock rule applies here first, exactly as it does to WH ACC%.
     */
    key: 'WH_Ratio_Acc',
    label: 'New WH ACC%',
    hint:
      'What actually shipped as a share of what was forecast: Outbound / WH Forecast. Over 100% means more went out than predicted, so higher is not better. A row scores 100% outright when the shops already held at least twice the forecast. This is the figure the Outbound vs forecast card averages.',
    autoWidth: true,
    num: true,
    group: 'wh',
    render: (v, r) =>
      v === null || v === undefined ? (
        <span className="muted" title="No warehouse forecast for this article to divide by.">
          –
        </span>
      ) : r?.WH_Acc_Covered ? (
        <span
          className="wh-acc--stock"
          title="Scored 100% because the shops already held at least twice this forecast, so the warehouse was right not to ship. Not a measure of how accurate the forecast was."
        >
          {fmtPct(v, 1)}
          <span aria-hidden="true"> •</span>
        </span>
      ) : (
        <span title={v > 1 ? 'More shipped than forecast' : 'Less shipped than forecast'}>
          {fmtPct(v, 1)}
        </span>
      ),
    /*
     * A plain mean of the rows, which is what the card shows.
     *
     * Deliberately NOT volume weighted like WH ACC% beside it: the card was
     * asked to average the row percentages, and a footer computing it a second
     * way would put two answers to one question in one view.
     */
    total: (list) => {
      const scored = list.filter(
        (x) => x.WH_Ratio_Acc !== null && x.WH_Ratio_Acc !== undefined
      )
      return scored.length ? scored.reduce((a, x) => a + x.WH_Ratio_Acc, 0) / scored.length : null
    },
    renderTotal: (v) => (v === null ? '–' : fmtPct(v, 1)),
  },

  /*
   * Outbound divided by WH forecast, asked for on 21 Sep 2026.
   *
   * A different question from WH ACC% beside it, and worth having both.
   *
   * WH ACC% divides the gap by the LARGER of the two sides, so it is capped at
   * 100% and loses the direction of the error: forecast 100 against outbound
   * 120 scores 83.3%, and against 80 scores 80.0% — near enough alike that the
   * column cannot tell you which way a forecast missed.
   *
   * This keeps the direction, and is not capped. Over 100% the warehouse issued
   * more than was predicted; under 100% it issued less. Forecast 100 against
   * outbound 120 reads 120%, against 80 reads 80%.
   *
   * Computed from the two columns either side of it, on the figures as
   * DISPLAYED — so a reader can check it with the numbers in front of them.
   * That means it uses the rounded WH forecast where rounding applied; the
   * difference is a rounding step, and a ratio nobody can reproduce by eye is
   * worse than one that moves by 0.001%.
   *
   * The total is the ratio of the two totals, not an average of the ratios.
   * Averaging ratios would weight an article that shipped forty units the same
   * as one that shipped six hundred thousand.
   */
  {
    key: 'WH_New_Pct',
    label: 'New',
    autoWidth: true,
    num: true,
    group: 'wh',
    hint:
      'Outbound divided by WH forecast, on the figures shown. Above 100% the ' +
      'warehouse issued MORE than the forecast predicted; below 100% it issued ' +
      'less. WH ACC% beside it is capped at 100% and cannot show which way a ' +
      'forecast missed; this can. The total is total outbound over total forecast.',
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Needs both a warehouse forecast above zero and an outbound figure on the same row."
        >
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    total: (list) => {
      let f = 0
      let c = 0
      for (const r of list) {
        const fv = Number(r.WH_Constant_Forecast_Qty)
        const cv = Number(r.Consumed_Qty)
        // Both sides, or neither — a row contributing outbound with no forecast
        // beside it would push the ratio up without belonging to it.
        if (!Number.isFinite(fv) || !Number.isFinite(cv) || fv <= 0) continue
        f += fv
        c += cv
      }
      return f > 0 ? c / f : null
    },
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },

  /*
   * Which rows on this page are showing a package figure rather than a forecast.
   *
   * The marker beside WH forecast says it in place; this column exists so the
   * set can be sorted, filtered and exported — "show me everything that was
   * rounded" is a question somebody will ask, and scanning for a dot is not an
   * answer.
   *
   * Blank rather than "No" where nothing was rounded: a column of "No" down 98%
   * of the page is noise, and the absence of a pack size is already what the
   * dash in the neighbouring columns means.
   */
  {
    key: 'WH_Rounded',
    label: 'Rounded',
    autoWidth: true,
    group: 'wh',
    hint:
      'Marks the rows whose WH forecast has been rounded UP to a whole standard ' +
      'package, so the figure shown is an order quantity rather than the ' +
      'engine’s forecast. The pack size is given in the cell. Blank means no ' +
      'standard package size applies, and the forecast is shown as calculated. ' +
      'WH ACC% is always scored on the unrounded forecast.',
    render: (v, r) =>
      v ? (
        <span
          className="pill pill--blue"
          title={`Rounded up from ${fmtQty(r?.WH_Forecast_Unrounded)} to whole packs of ${r?.Pack_Size} ${r?.Pack_Unit ?? ''}`.trim()}
        >
          {r?.Pack_Size} {r?.Pack_Unit ?? ''}
        </span>
      ) : (
        <span className="muted">–</span>
      ),
    total: (list) => {
      const n = list.filter((x) => x.WH_Rounded).length
      return n || null
    },
    renderTotal: (v) =>
      v === null || v === undefined ? (
        <span className="muted">–</span>
      ) : (
        <span className="muted">{v} rounded</span>
      ),
  },


  /*
   * The two methods, subtracted.
   *
   * Asked for on 13 Sep 2026. Forecast qty against WH forecast compares the two
   * predictions; Actual qty against Outbound compares the two measurements. A
   * row where both variances are small is an article the recipe tree and the
   * warehouse agree about. A row where they are large in the same direction is
   * one where the recipe is out by a factor rather than a margin: Kids Fries
   * Sleeves reads +228,168 against 15,000 shipped, which is how that defect
   * was found in the first place.
   *
   * Worked out per article and stamped only on the row carrying the warehouse
   * figures, exactly as WH ACC% is. Product Mix is split across one row per
   * recipe group, while Outbound and WH forecast sit on a single row per
   * article and are blank on the rest - subtracting one line share from the
   * article whole would have produced a variance on every line and a correct
   * one on none.
   *
   * Outside both group headings on purpose: a column that subtracts the
   * warehouse from the recipe belongs to neither of them.
   */
  {
    key: 'Forecast_Variance',
    label: 'Forecast variance',
    group: 'variance',
    autoWidth: true,
    num: true,
    total: 'sum',
    renderTotal: fmtVariance,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Both forecasts are needed to compare them. Either no recipe names this article, or the warehouse has no history to forecast from."
        >
          –
        </span>
      ) : (
        <span title="Forecast qty minus WH forecast. Positive means the recipe explosion asks for more than the warehouse's own history does.">
          {fmtVariance(v)}
        </span>
      ),
  },
  {
    key: 'Actual_Variance',
    label: 'Actual variance',
    group: 'variance',
    autoWidth: true,
    num: true,
    total: 'sum',
    renderTotal: fmtVariance,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Both measurements are needed to compare them. Either no recipe names this article, or the warehouse has no outbound record for it in this window."
        >
          –
        </span>
      ) : (
        <span title="Actual qty minus Outbound. Positive means the sales that happened imply more than the warehouse actually issued.">
          {fmtVariance(v)}
        </span>
      ),
  },

  /*
   * The two MEASUREMENTS, scored rather than subtracted.
   *
   * Actual variance above says how far apart they are in units, which is the
   * right answer for one article and a poor one for comparing two: 800 units
   * apart is a rounding error on a six-figure article and a disaster on a
   * four-figure one. This is the same comparison as a ratio, so the rows can be
   * ranked against each other.
   *
   * Scored the same way as the two accuracy columns beside it - the gap over
   * the LARGER of the two sides - so it is capped at 100%, never negative, and
   * reads on the same scale a reader has already learned here.
   *
   * It is a different question from both of them. Sales ACC% asks whether the
   * SALES forecast was right; WH ACC% asks whether the WAREHOUSE forecast was.
   * This one involves no forecast at all: it asks whether the two ways of
   * MEASURING what happened agree with each other. They come from different
   * places - one from sales exploded through recipes, one from what the
   * warehouse actually shipped - so a low score means the recipe and the
   * warehouse disagree about reality, which is a data question rather than a
   * forecasting one.
   */
  /*
   * (Actual qty + Store SOH) − Outbound. Asked for on 1 Oct 2026.
   *
   * Actual variance beside it asks whether the warehouse issued what the sales
   * imply. This asks the same question with what the shops were already
   * holding counted on the demand side: stock already in the shops is demand
   * that has been met without the warehouse shipping again for it, so an
   * article can look under-shipped on Actual variance and be perfectly
   * supplied once its shelf stock is counted.
   *
   * Scored per article, like Store SOH and Outbound either side of it, so it
   * appears once per article rather than on each of its recipe lines.
   */
  {
    key: 'New_Variance',
    label: 'New variance',
    group: 'variance',
    autoWidth: true,
    num: true,
    hint:
      'Actual qty plus Store SOH, minus Outbound. Counts the stock already ' +
      'sitting in the shops as demand that has been met, so it says whether ' +
      'the warehouse shipped enough once existing shelf stock is taken into ' +
      'account. Positive means more was needed than the warehouse issued.',
    total: 'sum',
    renderTotal: fmtVariance,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Needs an outbound record for this article in this window. Shown once per article, on the row that carries its warehouse figures."
        >
          –
        </span>
      ) : (
        <span title="(Actual qty + Store SOH) − Outbound. Positive means the sales that happened, plus what the shops already held, come to more than the warehouse issued.">
          {fmtVariance(v)}
        </span>
      ),
  },
  {
    key: 'Actual_Accuracy',
    label: 'Actual ACC%',
    group: 'variance',
    autoWidth: true,
    num: true,
    hint:
      'How closely the two MEASUREMENTS agree: Actual qty (sales exploded ' +
      'through the recipes) against Outbound (what the warehouse really ' +
      'issued). No forecast is involved. 100% means the two agree exactly; a ' +
      'low score means the recipe and the warehouse disagree about what ' +
      'actually happened.',
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Both measurements are needed to compare them. Either no recipe names this article, or the warehouse has no outbound record for it in this window."
        >
          –
        </span>
      ) : (
        fmtPct(v, 1)
      ),
    // Volume weighted on what the warehouse issued, matching WH ACC% beside it,
    // so a forty-unit article cannot outvote a six-hundred-thousand-unit one.
    total: (list) => weightedScore(list, 'Actual_Accuracy', 'Consumed_Qty')?.value ?? null,
    renderTotal: (v) => (v === null || v === undefined ? '–' : fmtPct(v, 1)),
  },

  /*
   * What the warehouse itself was holding, at each end of the window.
   *
   * Asked for on 14 Sep 2026. The store columns below say whether the shops
   * were already full; these say whether the warehouse had anything to send.
   * Read together with Outbound they close the loop: opening minus closing
   * should be roughly what went out, and where it is not, something moved that
   * the outbound feed did not record.
   *
   * Opening is the day BEFORE the selected range starts, closing is its last
   * day - so the pair brackets exactly the window on screen and responds to the
   * date slicer.
   *
   * These are not behind the store switch. The posting gap that makes store
   * stock unreliable does not reach the warehouse locations: measured over the
   * sixty days to 14 Sep 2026, warehouse stock rose on 29 days and fell on 31,
   * with no negative balances. See `server/insights/storeStock.js`.
   */
  {
    key: 'WH_Opening_SOH',
    label: 'WH opening',
    hint: 'Warehouse stock on hand the day before the selected date range began.',
    autoWidth: true,
    num: true,
    group: 'whstock',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No warehouse stock reading for this article the day before the selected range began. The inventory model has never held it, which is a different fact from holding none of it."
        >
          –
        </span>
      ) : (
        fmtQty(v)
      ),
  },
  {
    key: 'WH_Closing_SOH',
    label: 'WH closing',
    hint: 'Warehouse stock on hand on the last day of the selected date range. Opening minus closing should be roughly what went out.',
    autoWidth: true,
    num: true,
    group: 'whstock',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No warehouse stock reading for this article on the last day of the selected range."
        >
          –
        </span>
      ) : (
        <span
          title={
            row?.WH_Opening_SOH === null || row?.WH_Opening_SOH === undefined
              ? 'Warehouse balance on the last day of the selected range.'
              : `Warehouse balance on the last day of the range. It moved ${fmtVariance(
                  Number(v) - Number(row.WH_Opening_SOH)
                )} across the window.`
          }
        >
          {fmtQty(v)}
        </span>
      ),
  },

  /*
   * What is still outstanding with suppliers.
   *
   * Asked for on 14 Sep 2026. Sits with the warehouse stock columns because it
   * completes them: WH closing is what is on the shelf, this is what has been
   * bought and not yet arrived.
   *
   * A VALUE, not a quantity - the only money column on the page, which is why
   * the label says so. Every other number in these groups is units.
   *
   * Two things it does not do, both deliberate and both in the tooltip. It does
   * not move with the date slicer, because an open PO has no "as at" date - it
   * is the book as it stands, the same way Outbound MTD is a fixed window. And
   * it does not tie to the Inventory Control dashboard's own pending-PO figure;
   * `server/insights/openPo.js` records why, and why that measure could not be
   * read per article at all.
   */
  {
    key: 'Open_PO_Qty',
    label: 'Pending PO',
    hint: 'Units already ordered from suppliers but not yet received, after taking off anything part-delivered. Warehouse only, as at the end of the selected date range.',
    autoWidth: true,
    num: true,
    group: 'whstock',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="Nothing outstanding: the warehouse has no open purchase order for this article."
        >
          –
        </span>
      ) : (
        <span title="Units ordered from suppliers and not yet received, in the article's base unit. From the Inventory Control model's own [CC Open PO Qty] measure, which nets deliveries off through the PO lifecycle. Warehouse locations only, counting POs raised on or before the end of the selected range.">
          {fmtQty(v)}
        </span>
      ),
  },
  /*
   * Pending PO VALUE and NEW REQUIRED QTY were both removed on 16 Sep 2026.
   *
   * The value column was the only money figure among a run of unit columns, and
   * the quantity beside it already answers the question the group is for. New
   * required qty was explicitly a test of MAX(0, forecast - closing - pending):
   * it worked arithmetically and was withdrawn because its inputs sit on
   * different time bases - the order book runs about 5.7 months ahead of a
   * one-month forecast, which drove 68.8% of articles to zero. The server still
   * computes both; only the columns are gone, so either can come back by
   * restoring a definition here.
   */

  /*
   * SS DAYS, SS QTY, LEAD TIME and DELIVERY FREQ were removed from this table
   * on 16 Sep 2026, the day after they were added.
   *
   * Not because they were wrong, but because they were in the wrong table.
   * Every one of them is a planning setting - how much buffer to hold, how long
   * an order takes, how often it is delivered - and none of them says anything
   * about what this article needed or what the warehouse issued, which is what
   * Article Detail is for. They are inputs to a decision rather than a record
   * of one.
   *
   * All four are still shown, and still used, in the Replenishment Planning
   * table below, which is the decision they belong to. The server continues to
   * stamp them on every row, so nothing was lost on the way here - see
   * `withSafetyStock` in `server/routes/api.js`.
   */

  /*
   * What the shops are holding on the last day of the selected range.
   *
   * Closing stock, from 15 Sep 2026. It read the day before the window until
   * then, which answered a 1-31 Aug selection with the 31 July balance -
   * defensible for judging a zero-outbound row, and not what the column is read
   * as. See the date note in `server/insights/storeStock.js`.
   *
   *
   * These sit beside the warehouse columns rather than inside them because they
   * answer the question the warehouse columns provoke: a forecast of 14,934
   * against an outbound of 0 reads as a total failure until you can see whether
   * the shops were already full. They change nothing about the forecast — see
   * `server/insights/storeStock.js` for the backtest that settled that.
   */
  {
    key: 'Store_SOH',
    label: 'Store SOH',
    hint: "Closing stock in the shops on the last day of the selected date range. This is the shops' own stock, not the warehouse's, and it is never used in any warehouse calculation.",
    autoWidth: true,
    num: true,
    /*
     * Inside the Stock group, from 16 Sep 2026.
     *
     * It was deliberately ungrouped the day before: its own "Store inventory"
     * heading spanned one column and was clipped to "STORE INVENT", and a
     * heading over a single column only costs width. Joining the warehouse
     * columns under one heading called "Stock" solves that the other way - the
     * heading now spans eight columns and earns its place, and the two stock
     * readings a reader compares sit under the same title instead of one of them
     * floating outside it.
     *
     * The group is a heading, not a claim that these figures are
     * interchangeable. Store SOH is the shops' stock and cannot be issued by the
     * warehouse; every tooltip in the group says which side it describes.
     */
    group: 'whstock',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No closing-stock reading for this article in these brands' shops on the last day of the selected range. That is not the same as zero stock — it means nothing is known, so nothing is claimed. A range whose last day has not happened yet has no reading at all."
        >
          –
        </span>
      ) : v < 0 ? (
        // A book balance below zero is shown as it stands rather than tidied to
        // zero — it is a real condition somebody needs to go and fix — but it is
        // marked, because it is not a quantity of stock sitting anywhere.
        <span
          title="The books show less than nothing here: consumption has been recorded against stock the system had already run out of, usually a delivery booked late or a transfer never posted. It is treated as empty when working out what to send, not as a debt to be made up."
        >
          {fmtQty(v)}
        </span>
      ) : (
        fmtQty(v)
      ),
  },
  {
    /*
     * How many days of intake the shops' shelf is currently worth.
     *
     *   Combined Purchase = Purchase Qty + Transfer In Qty, over the selected
     *                       range, summed across the shops in scope
     *   Average Purchase  = Combined Purchase / calendar days in the range
     *   Store DTL         = Store SOH / Average Purchase
     *
     * It divides the Store SOH beside it — the same figure, not a second
     * reading of it. Sits next to it deliberately: the numerator is the column
     * immediately to its left, so the ratio can be checked without looking away.
     *
     * Not summable. A total of a ratio is arithmetic on a quantity that does
     * not add up, so there is no `total` here where Store SOH has one.
     */
    key: 'Store_DTL',
    label: 'Store DTL',
    hint: "Days of cover at the rate the shops are currently taking stock in: Store SOH divided by the average daily Purchase Qty + Transfer In Qty over the selected date range. Zero-delivery days are counted in the average, so this reads as days. It measures intake, not consumption.",
    autoWidth: true,
    num: true,
    group: 'whstock',
    render: (v, row) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title={
            row?.Store_SOH === null || row?.Store_SOH === undefined
              ? 'No closing-stock reading for this article in these shops, so there is nothing to divide.'
              : Number(row?.Store_SOH) < 0
                ? 'The book balance is below zero, which is an accounting artefact rather than stock on a shelf. A negative number of days is not a length of time, so nothing is claimed.'
                : 'No stock was purchased or transferred in for this article over the selected range, so there is no rate to divide by. That is not infinite cover — it is no answer at all.'
          }
        >
          –
        </span>
      ) : (
        <span
          title={`${fmtQty(row?.Store_SOH)} in the shops, at the average daily intake over the selected range. Counts days with no delivery, so it reads as calendar days of cover.`}
        >
          {Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}
        </span>
      ),
  },
  {
    /*
     * Stock in months of demand, because raw stock says nothing on its own.
     *
     * Ten thousand units is a fortnight of one article and two years of
     * another. Dividing by the article's own monthly requirement is what makes
     * the column comparable down its length.
     */
    key: 'Stock_Cover',
    label: 'Stock cover',
    autoWidth: true,
    num: true,
    group: 'stock',
    render: (v) =>
      v === null || v === undefined ? (
        <span
          className="muted"
          title="No cover can be worked out: either there is no stock reading, or there is no warehouse forecast to divide by. A cover figure with nothing underneath it would be infinity dressed up as a number."
        >
          –
        </span>
      ) : (
        <span title={`${v.toFixed(2)} months of the forecast requirement`}>
          {v >= 100 ? '99+' : v.toFixed(2)}m
        </span>
      ),
  },
  {
    key: 'SOH_Status',
    label: 'SOH status',
    width: 168,
    group: 'stock',
    render: (v) =>
      v ? (
        <Pill tone={SOH_TONE[v] ?? 'slate'}>{v}</Pill>
      ) : (
        <span className="muted">–</span>
      ),
  },

  /*
   * What the shops would need sent to reach the cover target.
   *
   * Deliberately a separate column from WH forecast rather than a replacement
   * for it. WH forecast is demand — what the shops will get through. This is
   * replenishment — what to send given what they already have. Backtesting
   * showed the second is a worse predictor of what the warehouse actually ships
   * than the first, by nine points, so both are published and neither pretends
   * to be the other.
   */
  {
    key: 'Required_Shipment',
    label: 'Required',
    autoWidth: true,
    num: true,
    group: 'repl',
    total: 'sum',
    renderTotal: fmtQty,
    render: (v, row) =>
      v === null || v === undefined ? (
        <span className="muted" title="Nothing to work out: no stock reading, or no warehouse forecast.">
          –
        </span>
      ) : (
        <span
          title={`Enough to bring the shops to ${TARGET_COVER} months of cover, from the ${
            row?.Store_SOH === null || row?.Store_SOH === undefined ? '0' : fmtInt(row.Store_SOH)
          } they hold now. A monthly figure, whatever window is on screen — a stock target does not shrink because you are looking at a week.`}
        >
          {fmtQty(v)}
        </span>
      ),
  },
  {
    key: 'Shipment_Status',
    label: 'Shipment',
    width: 176,
    group: 'repl',
    render: (v) =>
      v ? (
        <Pill tone={SHIPMENT_TONE[v] ?? 'slate'}>{v}</Pill>
      ) : (
        <span className="muted">–</span>
      ),
  },
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
  'WH_Forecast_Unrounded',
  'Consumed_Qty',
  'WH_Accuracy',
  // Across the two groups: the recipe answer minus the warehouse answer, on
  // both the predicted and the measured side.
  'Forecast_Variance',
  'Actual_Variance',
  'New_Variance',
  'Actual_Accuracy',
  // What the warehouse had at each end of the window, and how long it lasts.
  'WH_Opening_SOH',
  'WH_Closing_SOH',
  // What has been bought and not yet arrived. After the balances, because it
  // looks forward rather than reporting a balance.
  'Open_PO_Qty',
  // What the shops hold, immediately after the warehouse's own readings so the
  // two stock figures can be compared without looking away. Last of the Stock
  // group: the four planning settings that used to follow it now live in the
  // Replenishment Planning table, where they are acted on.
  'Store_SOH',
  // The same figure divided by the rate the shops take stock in — kept beside
  // its own numerator so the ratio can be checked without looking away.
  'Store_DTL',
  // What the shops' stock implies should be sent. Read left to right the four
  // blocks are: what was needed, what moved, what is in stock and on order,
  // what to do about it.
  'Stock_Cover',
  'SOH_Status',
  'Required_Shipment',
  'Shipment_Status',
  // Belongs to the day rather than to either group, so it sits outside both.
  'Sales_Day_Accuracy',
  // Neither group.
  'Live_Outbound_MTD',
]

/*
 * Store inventory is off, asked for on 14 Sep 2026.
 *
 * Back on for one day on 13 Sep, off again the next. The data is the honest
 * reason to leave it off: measured 13 Sep, store closing stock rose on 58 of
 * the previous 60 days and did not fall once in September, ending 28.8% above
 * where the month started — a 13.3m August mean against 26.0m in September.
 * The inventory model stopped posting sales depletion on 1 September, so Store
 * SOH and Stock cover read roughly double throughout, and an "SOH status" of
 * Normal could sit on a shop that was actually low.
 *
 * Nothing is deleted. Set this to true, and WH_STORE_COLUMNS=1 on the server,
 * and the three columns come back exactly as they were — admin only. The real
 * fix is upstream: somebody has to get depletion posting again.
 *
 * Warehouse stock is unaffected. Its data is sound and it has its own switch.
 */
const STORE_COLUMNS_ON = false

/*
 * The Stock group, kept apart from the store-replenishment block on purpose.
 *
 * Gated on the reader being an administrator, but NOT on STORE_COLUMNS_ON -
 * these come from the warehouse locations, whose data is sound, and they should
 * not disappear the next time the store figures have to be switched off.
 *
 * Store_SOH is NOT in this set even though it now sits in the same group: it
 * keeps its own STORE_SOH_ON switch, because it is the one column here that the
 * posting gap can affect. Sharing a heading is not sharing a gate.
 */
const WH_STOCK_COLUMNS = new Set(['WH_Opening_SOH', 'WH_Closing_SOH', 'Open_PO_Qty'])

/*
 * Replenishment is off, asked for on 14 Sep 2026.
 *
 * These were the only two columns on the page that issued an instruction rather
 * than reporting a measurement, and they are not wanted. The server withholds
 * the fields as well, so this is what keeps an empty group heading off the
 * table. Set both switches back on and they return as they were.
 */
const REPL_COLUMNS_ON = false
const REPL_COLUMNS = new Set(['Required_Shipment', 'Shipment_Status'])

/** The two blocks that only maintainers see, kept in one place. */
/*
 * Store SOH is back, on its own switch, asked for on 15 Sep 2026.
 *
 * Only the stock level. Stock cover and SOH status divide it by a monthly
 * forecast, and the level itself is the figure with the posting problem, so a
 * number somebody can see and judge is worth showing where a ratio built on it
 * is not. Set STORE_COLUMNS_ON back to true for those two.
 */
const STORE_SOH_ON = true
const STORE_SOH_COLUMNS = new Set(['Store_SOH', 'Store_DTL'])

/*
 * What the Production page has no use for.
 *
 * Every one of these is measured by, or derived from, the central warehouse -
 * and on a page of prep steps and prepared articles it is either blank or
 * describes something the warehouse never handled. Status and Category go too:
 * both describe how an article is SUPPLIED, which is a question about the
 * bought half.
 */
const NO_WAREHOUSE_COLUMNS = new Set([
  /*
   * The warehouse Outbound column belongs here after all.
   *
   * It was taken out of this set on 29 Sep 2026 to put Outbound on the
   * Production pages, and that was the wrong column: it measures what the
   * CENTRAL WAREHOUSE issued, and a prepared article never leaves the
   * warehouse. It read blank on nearly every row. `Site_Outbound_Qty` is the
   * figure those pages want, and it is shown in its place.
   */
  'Consumed_Qty',
  'WH_Constant_Forecast_Qty',
  'WH_Accuracy',
  'WH_Ratio_Acc',
  'WH_New_Pct',
  'WH_Rounded',
  'Live_Outbound_MTD',
  'WH_Opening_SOH',
  'WH_Closing_SOH',
  'Open_PO_Qty',
  'Open_PO_Value',
  'Forecast_Variance',
  'Actual_Variance',
  'New_Variance',
  'Actual_Accuracy',
  'Status',
  'Category',
])

/** The derived store figures, still off. */
const STOCK_COLUMNS = new Set([
  'Stock_Cover',
  'SOH_Status',
  'Required_Shipment',
  'Shipment_Status',
])

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
/*
 * Whether this row's requirement came from a recipe at all.
 *
 * Declared above the component, not merely at column zero inside it. Sitting
 * unindented among the other helpers made it look like module scope while it
 * was still lexically inside the function — so `priced`, which runs earlier in
 * the same body, read it before its declaration and the page died on mount.
 *
 * The recipe group is what the server stamps, and two places deciding "is this
 * a recipe row?" by different means is how a card and a column start
 * disagreeing.
 */
/*
 * What each column means, for the person reading the number rather than the
 * one who wrote it.
 *
 * Deliberately in the words somebody would use out loud: "how many we expected
 * to sell" rather than "the recipe explosion of forecast sales". The exact
 * expressions live in the Calculations panel for anybody who needs them; this
 * is here so a reader can settle a question without leaving the table.
 */
const HELP = {
  variance: [
    {
      term: 'Forecast variance',
      text: 'How far apart the two FORECASTS are. Positive means the recipe explosion asks for more than the warehouse’s own history does.',
      formula: 'Forecast qty − WH forecast',
    },
    {
      term: 'Actual variance',
      text: 'How far apart the two MEASUREMENTS are: sales exploded through the recipes, against what the warehouse really issued.',
      formula: 'Actual qty − Outbound',
    },
    {
      term: 'Actual ACC%',
      text: 'How closely those two measurements agree. It judges the recipes and the outbound data against each other — not the forecast.',
      formula: '1 − |Actual qty − Outbound| / MAX(Actual qty, Outbound)',
    },
  ],
  whstock: [
    {
      term: 'WH opening',
      text: 'What the warehouse was holding the day before the selected date range began.',
      formula: 'Closing stock qty in the inventory model, warehouse locations only, on the day before the range starts.',
      example:
        'Range 1-13 Sep, so the reading is 31 Aug. Kids Fries Sleeves read 7,500 that day.',
    },
    {
      term: 'WH closing',
      text: 'The same reading on the last day of the range.',
      formula: 'Closing stock qty, warehouse locations only, on the last day of the range.',
      example:
        'Kids Fries Sleeves read 5,000 on 13 Sep - down 2,500, which is exactly what Outbound says went out.',
    },
    {
      term: 'Pending PO',
      text: 'Units ordered from suppliers and not yet received.',
      formula:
        "[CC Open PO Qty], grouped on 'CC Item Location'[Article No.], warehouse locations only, with 'CC Date'[Movement Date] filtered to the end of the selected range.",
      example:
        'The Inventory Control model’s own [CC Open PO Qty] measure, which nets deliveries off through the PO lifecycle - so this column and that dashboard agree by construction. Switched to it on 17 Sep 2026 from a hand-rolled join that agreed with it on 399 of 411 articles. It DOES move with the date range: POs raised on or before the end of the selected range count, clamped to the last day the inventory feed holds.',
    },
    {
      term: 'Store SOH',
      text: "What the shops of the brands on screen are holding, added together. The shops' stock, not the warehouse's.",
      formula:
        'Closing stock qty in the inventory model, shop locations only, on the LAST day of the selected range.',
      example:
        'Never used in any warehouse figure in this group - the warehouse cannot issue stock that is already sitting in a shop. A dash means the model has no reading, which is not the same as none in stock. It can read negative where consumption was posted against stock the system had already run out of.',
    },
    {
      term: 'Safety stock, lead time, delivery frequency',
      text: 'Moved out of this table on 16 Sep 2026 - they are planning settings rather than a record of what happened.',
      example:
        'All four are in the Replenishment Planning table below, where they are acted on: SS days and SS qty, Lead time and Delivery freq.',
    },
  ],
  fcst: [
    {
      term: 'Forecast qty',
      text: 'What the recipes say we need, if we sell what we expect to sell.',
      formula:
        'For every dish that uses this article:  forecast sales of the dish × amount the recipe uses.  Add those up.',
      example: '1,000 burgers forecast × 1 bun each = 1,000 buns.',
    },
    {
      term: 'Actual qty',
      text: 'The same sum, using the dishes we actually sold.',
      formula:
        'For every dish that uses this article:  actual sales of the dish × the same recipe amount.  Add those up.',
      example: '1,100 burgers sold × 1 bun each = 1,100 buns.',
    },
    {
      term: 'ACC%',
      text: 'How close the two are. Because both use the same recipe, this really scores the sales forecast rather than the recipe.',
      formula: '1 − ( difference between Actual and Forecast ÷ Actual )',
      example:
        'Forecast 1,000, actual 1,100 → 1 − (100 ÷ 1,100) = 90.9%. Blank when nothing sold, because there is nothing to divide by.',
    },
  ],
  /*
   * The same band on the production pages, where the columns are named for the
   * method rather than for the quantity - and where a fourth one joins them.
   *
   * Deliberately a separate list from `fcst` above rather than a rewrite of it:
   * Stock Article still shows "Forecast qty" and "Actual qty" and is under a
   * standing instruction not to change, so one text cannot serve both.
   */
  fcstProduction: [
    {
      term: 'PM Forecast',
      text: 'What the recipes say this site needs to make, if we sell what we expect to sell. "PM" is the product mix.',
      formula:
        'For every dish that uses this article:  forecast sales of the dish × the amount the recipe uses.  Add those up.',
      example:
        '1,000 burgers forecast × 1 bun each = 1,000 buns. Blank means no recipe reaches this article — either nothing on the menu uses it, or the products that do are not in the sales forecast. Click the article name to see which.',
    },
    {
      term: 'PM Actual',
      text: 'The same sum, using the dishes that actually sold.',
      formula:
        'For every dish that uses this article:  actual sales of the dish × the same recipe amount.  Add those up.',
      example: '1,100 burgers sold × 1 bun each = 1,100 buns.',
    },
    {
      term: 'ACC%',
      text: 'How close those two are. Because both use the same recipe, this really scores the SALES forecast rather than the recipe itself.',
      formula: '1 − ( difference between PM Actual and PM Forecast ÷ PM Actual )',
      example:
        'Forecast 1,000, actual 1,100 → 1 − (100 ÷ 1,100) = 90.9%. Blank when nothing sold, because there is nothing to divide by.',
    },
    {
      term: 'Outbound/PM Forecast',
      text: 'How close the recipe forecast came to what the sites actually issued. It judges the PRODUCT MIX method against real movement, which is why it sits in this band rather than the next one.',
      formula: '1 − ( difference between PM Forecast and Outbound ÷ the larger of the two )',
      example:
        'Read the slash as "versus". Bounded 0–100%, so higher is better, and it is directly comparable with Acc% under Outbound forecast — where that one is higher, the site method was closer for that article. 0.0% against a real Outbound means the recipes forecast nothing at all.',
    },
  ],
  /*
   * The production pages' measured half. Written to be read straight after
   * `fcst` above, because the whole point of the two bands is the comparison.
   */
  siteout: [
    {
      term: 'Outbound',
      text: 'What the production sites actually issued to this brand’s shops over the selected dates. Measured, not forecast.',
      formula:
        'Every issue of this article from the Central Kitchen, the Central Production Unit, Swish Bakery or the Yelo Factory, where the destination is this brand.  Add them up.',
      example:
        'Blank means no site has a record of it, which is different from zero. Shown once per article, so it is not counted again on the article’s other recipe lines.',
    },
    {
      term: 'Forecast',
      text: 'A second forecast that never looks at a recipe. It asks what the kitchens have had to issue per dinar of sales, and applies that to the sales forecast.',
      formula:
        'For each of the last six whole months:  what the sites issued ÷ what the brand sold.  Weight the recent months more heavily, then × the forecast sales for these dates.',
      example:
        'Backtested on prepared articles over four months: 85.3% accurate per article against the recipe method’s 64.8%, and it removed a standing 24% under-forecast. It learns BEHAVIOUR, not requirement — if the kitchens habitually issue more than a recipe implies, this asks for that too.',
    },
    {
      term: 'Acc%',
      text: 'How close that forecast came to what was issued. The same formula as ACC% under Product mix, so the two bands can be compared directly.',
      formula: '1 − ( difference between Forecast and Outbound ÷ the larger of the two )',
      example:
        'Bounded 0–100%, so higher is better. Dividing by the larger side means issuing double and issuing half score alike — read Outbound against Forecast for the direction.',
    },
  ],
  wh: [
    {
      term: 'WH forecast',
      text: 'What the warehouse would be expected to ship, based on how much it has shipped per unit sold.',
      formula: `Step 1 — for each of the last 6 whole months: units the warehouse shipped ÷ that brand’s sales that month. That is a rate.
Step 2 — average those 6 rates.
Step 3 — multiply by the forecast sales for the dates on screen.`,
      example:
        'Shipped 2,000 in a month the brand sold 100,000 → a rate of 0.02. If we forecast 150,000 sales, the warehouse forecast is 3,000.',
    },
    {
      term: 'Outbound',
      text: 'What actually left the Central Warehouse for the shops.',
      formula:
        'Add up the quantity on every transfer where the source is the Central Warehouse, the destination is anywhere except the warehouse itself, and the status is Booked, Delivered or Declined. Dated on the requested delivery date.',
      example:
        'A dash means the warehouse has never shipped this article to this brand. A zero means it normally does and did not this time.',
    },
    {
      term: 'WH ACC%',
      text: 'How close the warehouse forecast was to what actually shipped.',
      formula: '1 − ( difference between WH forecast and Outbound ÷ whichever of the two is larger )',
      example:
        'Forecast 8, shipped 10 → 1 − (2 ÷ 10) = 80%. Always between 0% and 100%: equal is 100%, one side twice the other is 50%, nothing shipped against a real forecast is 0%.',
    },
    {
      term: 'Why it can look wrong',
      text: 'The warehouse ships in full cases on an ordering cycle, so a short date range catches one delivery or none.',
      example: 'Judge this over a full month; under about three weeks it is mostly noise.',
    },
  ],
  stock: [
    {
      term: 'Store SOH',
      text: 'What the shops of the brands on screen are holding, added together, in the article’s own base unit.',
      formula: 'Closing stock in the inventory model, on the day before this window opens.',
      example:
        'The day before, not the last day: closing stock cannot explain a shipment that was decided before it existed. A dash means the model has no reading at all, which is not the same as none in stock.',
    },
    {
      term: 'Stock cover',
      text: 'How long that stock would last at the rate this article is forecast to be needed.',
      formula: 'Store SOH ÷ the warehouse forecast put on a monthly footing.',
      example:
        '100 in the shops against 100 a month = 1.00m. Blank when there is no forecast to divide by, because the honest answer there is not infinity.',
    },
    {
      term: 'SOH status',
      text: 'The same figure in words, with the lines drawn where the data actually changes behaviour.',
      formula:
        'Nothing held → No store stock.  Under 0.25 months → Low stock.  0.25 to 2 → Normal.  2 months or more → Store already stocked.',
      example:
        'Backtested over 6,815 article-months: above two months of cover, what ships falls from about three quarters of the forecast to about half. Below two months, cover tells you almost nothing — which is why there is one band there and not three.',
    },
  ],
  repl: [
    {
      term: 'Required',
      text: 'What would have to be sent to bring the shops up to the cover target — a suggestion to order from, not a forecast.',
      formula: 'MAX(0, 1.25 months of forecast demand − Store SOH)',
      example:
        'A monthly figure whatever window is on screen, because a stock target does not shrink because you are looking at a week. It sits beside WH forecast rather than replacing it: the forecast says what the shops will get through, this says what to send given what they already have.',
    },
    {
      term: 'Shipment',
      text: 'What to do about it.',
      formula:
        'Warehouse empty at any point this window → Supply constraint.  Nothing needed → No shipment needed.  Needed and cover under 0.25 months → Low stock, urgent.  Otherwise → Shipment required.',
      example:
        'Supply constraint wins over the rest on purpose: a shop that needs stock from a warehouse that has none is a purchase order, not a shipment somebody has forgotten to raise.',
    },
    {
      term: 'Why this is not the forecast',
      text: 'Because it was tested as one and it was worse.',
      example:
        'Over five months, subtracting store stock from the forecast scored 42.1% against 53.5% for leaving it alone, and drove one forecast in five to zero — 566 of which then shipped 2.15 million units. Store stock and shipments move together (r = +0.80), not against each other: bigger shops hold more and receive more.',
    },
  ],
}

const fromRecipe = (r) => !String(r['Recipe Group'] ?? '').startsWith('No recipe')

/**
 * Actual ACC% — forecast against what the production sites actually issued.
 *
 *   1 - |Forecast - Outbound| / MAX(Forecast, Outbound)
 *
 * Asked for on 29 Sep 2026, replacing the plain ratio `Outbound / Forecast`
 * this column carried for one day. The ratio answered "which way did it go" and
 * was unbounded above - the page was showing 387.7% beside 107.6% - so a column
 * headed ACC% could not be read as a score, sorted meaningfully, or averaged.
 * Dividing by the LARGER of the two bounds it 0-100% by construction: the gap
 * can never exceed the denominator. It is the same expression WH ACC% uses, so
 * the two are now directly comparable, and it is `MAX` that makes over- and
 * under-issuing count as the same size of miss.
 *
 * Defined in ONE place because it is computed twice - once per row, and again on
 * a folded row's own totals - and two copies would eventually disagree.
 *
 * Every blank is a refusal to state something the data cannot support:
 *
 *   outbound null   no site has a record of this article. Unmeasured, NOT 0%
 *                   accurate - a zero would read as a forecast that missed
 *                   completely rather than one nothing can be said about.
 *   forecast null   nothing to score.
 *   MAX(f, o) == 0  both sides zero. Arithmetically 0/0, and editorially a row
 *                   nothing was forecast for and nothing was issued from was
 *                   never tested; scoring it 100% would flatter the page.
 *
 * The two asymmetric cases need no special handling and are deliberately NOT
 * blank: forecast 0 against real outbound scores 0% (issued, never forecast),
 * and a real forecast against outbound 0 scores 0% (forecast, nothing issued).
 * Neither can divide by zero, because MAX is positive in both.
 *
 * `bounded` is false only on Stock Article, where this column has no business
 * appearing at all - it is a leak: the page filters out `Site_Outbound_Qty` and
 * not this, so it shows a ratio whose numerator is hidden. That page is under a
 * standing instruction not to change, so its behaviour is pinned here rather
 * than quietly corrected. Removing the column there is the real fix.
 */
/**
 * A volume-weighted mean of per-article site scores, for a column footer.
 *
 * Built from the quantities rather than from the scores in the column, because
 * those are blank by design on a view that splits an article - see
 * `stampSiteAcc`. Scoring the quantities keeps the total right in every view.
 *
 * Two rules, and they differ per side:
 *
 *   forecast  SUMMED across the article's rows. The recipe forecast really is
 *             split across recipe lines; the site forecast sits on one row and
 *             the others contribute nothing, so the same sum is correct for both.
 *   outbound  taken ONCE per article, because the same per-article figure is
 *             stamped on every one of those rows. This is what stops the
 *             double-counting across recipe lines.
 *
 * Then a mean weighted by what moved, each score floored at 0 - not a ratio of
 * the two column totals, which would let one article's over-issue cancel
 * another's under-issue and report a figure no article achieved.
 *
 * `key` is which forecast to judge, so Actual ACC% and Site fc ACC% share this
 * and cannot be computed two different ways.
 */
const siteAccTotal = (list, key) => {
  const seen = new Map()
  for (const r of list) {
    const article = String(r['Item No.'] ?? '').trim() || String(r.Item ?? '').trim()
    if (!article) continue
    const o = r.Site_Outbound_Qty
    // Articles with no site record are skipped on both sides together:
    // counting a forecast that can never be measured would depress the total
    // with rows the column itself declines to score.
    if (o === null || o === undefined) continue
    const held = seen.get(article)
    if (held) {
      held.f += Number(r[key]) || 0
      continue
    }
    seen.set(article, { f: Number(r[key]) || 0, o: Math.max(0, Number(o) || 0) })
  }
  let sum = 0
  let weight = 0
  for (const { f, o } of seen.values()) {
    const score = siteAcc(f, o, true)
    if (score === null) continue
    sum += Math.max(0, score) * o
    weight += o
  }
  // No volume at all is not a zero-accuracy answer, it is no answer.
  return weight > 0 ? sum / weight : null
}

const siteAcc = (forecast, outbound, bounded = true) => {
  if (forecast === null || forecast === undefined) return null
  if (outbound === null || outbound === undefined) return null
  const f = Number(forecast)
  const o = Number(outbound)
  if (!Number.isFinite(f) || !Number.isFinite(o)) return null
  if (!bounded) return f > 0 ? o / f : null
  const bigger = Math.max(f, o)
  return bigger > 0 ? 1 - Math.abs(f - o) / bigger : null
}

export function ComponentLevel({
  filters,
  options,
  ready,
  refreshNonce,
  onLoaded,
  onDrill,
  isAdmin,
  fullDetail,
  /*
   * Who may see the Stock group and the Replenishment Planning table.
   *
   * Administrators, Warehouse and Supply Chain - decided by the server and
   * sent with the session, so this never matches on a department name. It
   * replaced `isAdmin` on these gates on 16 Sep 2026: the two departments
   * that place the orders are already granted this page, and gating the
   * figures they order from on `admin` meant they could open it and not see
   * them. `isAdmin` still guards everything that is genuinely administrative.
   */
  stockDetail,
  /*
   * Drop everything the central warehouse measures.
   *
   * Set by the Production page, where the articles are made in-house rather
   * than shipped: outbound, the accuracy built on it, the warehouse stock
   * readings and the variance columns that compare the two forecasts are all
   * blank or misleading there. Stock Article leaves it off and keeps them.
   */
  noWarehouse = false,
}) {
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
  /*
   * The day's sales, forecast against actual, keyed by date.
   *
   * Comes down with the rows from the same request, so it is always the same
   * window and the same brands as the table it sits beside.
   */
  const sales = data?.sales ?? null

  const dayAccuracy = useMemo(() => {
    const score = (t) => {
      if (!t) return null
      const actual = Number(t.actual) || 0
      const forecast = Number(t.forecast) || 0
      // The report's own shape: 1 − |variation|, divided by what actually sold.
      // No sales means no answer — a forecast against nothing is not a hit.
      if (actual <= 0) return null
      return 1 - Math.abs(actual - forecast) / actual
    }

    const byDate = new Map()
    for (const [d, t] of Object.entries(sales?.byDate ?? {})) byDate.set(d, score(t))
    const whole = score(sales?.total)
    return (r) => {
      const d = r.Date ? String(r.Date).slice(0, 10) : null
      return d && byDate.has(d) ? byDate.get(d) : whole
    }
  }, [sales])

  const priced = useMemo(() => {
    /*
     * Keyed on the article number, or on the name when there isn't one.
     *
     * All 941 PREP steps have a blank `Item No.` — a kitchen step is not
     * something the ERP stocks — and they were being skipped here entirely.
     * That cost them their roll-up, so `implied` stayed null and ACC% read as a
     * dash on every prep row, even where Forecast qty and Actual qty were both
     * sitting right there on the line.
     *
     * The name is a good enough key for them: two prep steps with the same name
     * are the same step, and the warehouse columns stay blank either way
     * because there is still no article for the warehouse to have shipped.
     */
    const keyOf = (r) => String(r['Item No.'] ?? '').trim() || String(r.Item ?? '').trim()

    const perArticle = new Map()
    for (const r of rows) {
      const a = keyOf(r)
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
        /*
         * The UNROUNDED figure, where one exists.
         *
         * Product-mix quantities are rounded up to whole packs from 27 Sep
         * 2026, and this total is what Sales ACC% divides. Scored against a
         * figure deliberately lifted to a pack boundary it would grade the
         * packaging rather than the forecast - the same reason WH ACC% reads
         * `WH_Forecast_Unrounded`.
         */
        held.forecast =
          (held.forecast ?? 0) +
          (Number(r.Component_Forecast_Unrounded ?? r.Component_Forecast_Qty) || 0)
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
        /*
         * The engine's figure, not the package figure.
         *
         * WH ACC% compares the forecast with what the warehouse issued. Once
         * the displayed forecast is rounded up to a whole pack, scoring against
         * it grades the packaging rather than the forecast — so the accuracy
         * side reads `WH_Forecast_Unrounded` wherever rounding happened.
         */
        held.wh =
          (held.wh ?? 0) +
          (Number(r.WH_Forecast_Unrounded ?? r.WH_Constant_Forecast_Qty) || 0)
      }
      perArticle.set(a, held)
    }

    return rows.map((r) => {
      const a = keyOf(r)
      const held = a ? perArticle.get(a) : null
      const forecast = held
        ? held.forecast
        : r.Component_Forecast_Qty === null || r.Component_Forecast_Qty === undefined
          ? null
          : Number(r.Component_Forecast_Unrounded ?? r.Component_Forecast_Qty) || 0
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
      /*
       * Divided by what actually left the warehouse, matching the card.
       *
       * It used to divide by the larger of the two, which is symmetric and
       * never negative — but the card beside it divided by outbound, so the
       * column footer and the card disagreed by more than their aggregation
       * explained. Asked for on 6 Sep 2026: one formula, outbound underneath,
       * floored at zero.
       *
       * The floor is doing real work here. Over-forecast by more than twice
       * what moved and the raw answer goes negative; nothing issued at all and
       * it is negative infinity. Both mean "the forecast was wrong and the
       * warehouse shipped less", and 0% is where that bottoms out.
       *
       * Blank stays blank: no outbound figure at all, or nothing forecast and
       * nothing moved, cannot be scored and is not a zero.
       */
      /*
       *   Accuracy = 1 − |Forecast − Actual| / MAX(Forecast, Actual)
       *
       * Symmetric, and bounded between 0 and 1 by construction: dividing by the
       * larger of the two means the gap can never exceed the denominator, so
       * nothing needs flooring and nothing runs off the scale. Equal quantities
       * score 100%, one side twice the other scores 50%, and a real forecast
       * against nothing issued scores 0%.
       *
       * It replaces dividing by outbound, which read the same discrepancy two
       * quite different ways depending on its direction and sent articles with
       * a tiny denominator to minus a million.
       *
       * Blank only where there is genuinely nothing to compare: no outbound
       * figure at all, or nothing forecast and nothing moved.
       */
      const score = (target) => {
        if (!held || !held.measured || target === null) return null
        const outbound = held.consumed
        const bigger = Math.max(outbound, target)
        return bigger > 0 ? 1 - Math.abs(target - outbound) / bigger : null
      }

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
          ? 1 - Math.abs(implied - forecast) / implied
          : null

      /*
       * Does this row hold the article's warehouse figures, or point at another?
       */
      const carriesWarehouse =
        (r.Consumed_Qty !== null && r.Consumed_Qty !== undefined) ||
        (r.WH_Constant_Forecast_Qty !== null && r.WH_Constant_Forecast_Qty !== undefined)

      /*
       * Outbound over forecast, on the figures this row shows.
       *
       * A real field rather than something the column computes: DataTable reads
       * `row[key]`, so a column that exists only in a render function sorts
       * wrongly and exports blank.
       */
      const newPct = (() => {
        const f = Number(r.WH_Constant_Forecast_Qty)
        const c = Number(r.Consumed_Qty)
        return Number.isFinite(f) && Number.isFinite(c) && f > 0 ? c / f : null
      })()

      return {
        ...r,
        WH_New_Pct: newPct,
        // A real value, so the CSV has something to write and the table has
        // something to sort and search on.
        Source: fromRecipe(r) ? 'Recipe' : 'Non-recipe',
        Sales_Day_Accuracy: dayAccuracy(r),
        Site_Acc: siteAcc(r.Component_Forecast_Qty, r.Site_Outbound_Qty, noWarehouse),
        Article_Forecast_Qty: forecast,
        Sales_Accuracy: salesAccuracy,
        Accuracy: score(forecast),
        /*
         * The same measurement against the other forecast, so the two methods
         * can be judged on the same evidence rather than on each other.
         *
         * Only on the row that carries the warehouse figures. Those sit on one
         * row per article and every other row of the same article is blank —
         * they mean "counted on another line" rather than zero. The score,
         * though, is worked out per article, so it used to be stamped on all of
         * them: a row reading "– – 83.3%", an accuracy apparently derived from
         * two blanks. Folding the rows recomputes the score from the summed
         * columns, so the grouped view is unaffected.
         */
        /*
         * The stock rule is applied on top of the ordinary score: where the
         * shops already hold twice what was forecast, not shipping was right
         * and the forecast is not marked down for it. See `whAccuracy.js` for
         * what this does to the figure and the argument against it.
         */
        /*
         * New Variance = (Actual qty + Store SOH) − Outbound. Asked for on
         * 1 Oct 2026.
         *
         * Worked out PER ARTICLE and stamped on the one row that carries the
         * warehouse figures, because its three inputs do not share a row.
         * Actual qty is per recipe line - an article used by eleven products
         * has eleven of them - while Store SOH and Outbound are anchored once
         * per article. Computed row by row it would have read one recipe line's
         * actual against the whole article's outbound, which is the mistake
         * that made Actual ACC% print 387.7% in September.
         *
         * `held.implied` is that per-article sum of Actual qty and
         * `held.consumed` the per-article outbound, which are the same figures
         * the Actual qty and Outbound columns total to.
         *
         * Blank rather than zero where the article has no outbound record at
         * all: "nothing shipped here" and "this came out at nought" are
         * different answers, and only the second is a variance.
         */
        New_Variance:
          carriesWarehouse && held?.measured
            ? (held.implied ?? 0) + (Number(r.Store_SOH) || 0) - held.consumed
            : null,
        WH_Accuracy: carriesWarehouse
          ? whAccuracy(score(held?.wh ?? null), held?.wh ?? null, r.Store_SOH)
          : null,
        // So the column can say WHY a row reads 100%.
        WH_Acc_Covered: carriesWarehouse && coveredByStock(held?.wh ?? null, r.Store_SOH),
        /*
         * The directional score, beside the symmetric one: what shipped as a
         * share of what was forecast, with the same stock rule applied first.
         */
        WH_Ratio_Acc: carriesWarehouse
          ? whRatioAccuracy(held?.consumed ?? null, held?.wh ?? null, r.Store_SOH)
          : null,
        /*
         * Both sides present, or nothing at all.
         *
         * `held.forecast` and `held.wh` stay null until something contributes
         * rather than starting at zero, so a missing side stays missing instead
         * of reading as a variance that happens to equal the other side.
         */
        Forecast_Variance:
          carriesWarehouse &&
          held?.forecast !== null &&
          held?.forecast !== undefined &&
          held?.wh !== null &&
          held?.wh !== undefined
            ? held.forecast - held.wh
            : null,
        // `measured` is the outbound equivalent of that: set only once a real
        // outbound figure has landed, which is what separates "shipped
        // nothing" from "there is no record of it".
        Actual_Variance:
          carriesWarehouse &&
          held?.implied !== null &&
          held?.implied !== undefined &&
          held?.measured
            ? held.implied - held.consumed
            : null,
        /*
         * The same pair, as a score. Null exactly where the variance is null -
         * one measurement alone cannot be compared with anything.
         */
        Actual_Accuracy:
          carriesWarehouse &&
          held?.implied !== null &&
          held?.implied !== undefined &&
          held?.measured
            ? (() => {
                const bigger = Math.max(held.implied, held.consumed)
                return bigger > 0 ? 1 - Math.abs(held.implied - held.consumed) / bigger : null
              })()
            : null,
      }
    })
  }, [rows, dayAccuracy])

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
  const DIMENSIONS = ['Date', 'LocationID', 'CHAINID', 'Source', 'Recipe Group', 'Item', 'Node Type', 'Category', 'BU', 'Item No.', 'WH_Rounded', 'Pack_Size', 'Pack_Unit']

  const visibleDims = useMemo(
    () => DIMENSIONS.filter((k) => !hiddenCols.includes(k)),
    [hiddenCols]
  )

  /**
   * Actual ACC%, scored per ARTICLE and shown on every row of that article.
   *
   * Site outbound is an article-level fact - the server can only ever read it
   * per article, never per recipe line - and it is already repeated on each of
   * the article's rows. The score beside it has to be built the same way, or the
   * two columns describe different things on the same line.
   *
   * WHY IT IS NOT SCORED FROM THE ROW'S OWN FORECAST
   *
   * A row is one article within one recipe group, so its forecast is a SHARE of
   * the requirement while the outbound beside it is the whole article's. An
   * article with lines of 100, 50 and 30 against 300 issued would score three
   * different, all-wrong numbers. Summing the article's forecast first is what
   * makes the comparison legitimate.
   *
   * This replaced a first attempt on 29 Sep 2026 that blanked the column
   * whenever the view split an article apart. That was built on a misreading:
   * `hiddenByDefault` on the Recipe group column controls only whether the TABLE
   * SHOWS it, while the fold groups on `hiddenCols`, which starts as just
   * ['Date', 'LocationID']. So recipe rows are NOT folded by default, the gate
   * fired on every row, and the whole column read blank.
   *
   * THE KEY
   *
   * Brand joins the article in the key when the table is split by brand, because
   * outbound is read per brand in the server's fan-out - two brands' rows for one
   * article carry two different figures and must not be pooled.
   *
   * Date is different: outbound is a single figure for the whole selected range
   * and cannot be apportioned across days, so a date-split view has nothing
   * honest to compare and the column blanks. Branch needs no rule - outbound
   * arrives null there and `siteAcc` blanks it anyway.
   *
   * Stock Article is passed through untouched: it shows this column only by
   * accident and is under a standing instruction not to change.
   */
  const stampSiteAcc = useCallback(
    (rows) => {
      if (!noWarehouse) return rows
      if (visibleDims.includes('Date'))
        return rows.map((r) => ({ ...r, Site_Acc: null, Site_Fc_Acc: null }))

      const byBrand = visibleDims.includes('CHAINID')
      const keyOf = (r) =>
        `${String(r['Item No.'] ?? '').trim() || String(r.Item ?? '').trim()}${
          byBrand ? `|${String(r.CHAINID ?? '')}` : ''
        }`

      /*
       * Forecast sums across the article's rows; outbound is taken once, since
       * the same per-article figure sits on each of them.
       *
       * `sf` is the SITE forecast, summed the same way. It is stamped on one row
       * per article and null on the rest, so the sum is just that one figure -
       * but summing it costs nothing and means neither column depends on which
       * row the fold happened to keep.
       */
      const held = new Map()
      for (const r of rows) {
        const key = keyOf(r)
        if (!key) continue
        const o = r.Site_Outbound_Qty
        const seen = held.get(key)
        if (seen) {
          seen.f += Number(r.Component_Forecast_Qty) || 0
          if (r.Site_Forecast_Qty !== null && r.Site_Forecast_Qty !== undefined)
            seen.sf = (seen.sf ?? 0) + Number(r.Site_Forecast_Qty)
          if (seen.o === null && o !== null && o !== undefined) seen.o = Number(o)
          continue
        }
        held.set(key, {
          f: Number(r.Component_Forecast_Qty) || 0,
          sf:
            r.Site_Forecast_Qty === null || r.Site_Forecast_Qty === undefined
              ? null
              : Number(r.Site_Forecast_Qty),
          o: o === null || o === undefined ? null : Number(o),
        })
      }

      return rows.map((r) => {
        const pair = held.get(keyOf(r))
        return {
          ...r,
          Site_Acc: pair ? siteAcc(pair.f, pair.o, true) : null,
          Site_Fc_Acc: pair ? siteAcc(pair.sf, pair.o, true) : null,
        }
      })
    },
    [noWarehouse, visibleDims]
  )

  const grouped = useMemo(() => {
    /*
     * Actual ACC% is scored per ARTICLE, then shown on each of the article's
     * rows - see `stampSiteAcc` below, which every return path runs through.
     */

    // Nothing to fold if every dimension is on screen.
    if (visibleDims.length === DIMENSIONS.length) return stampSiteAcc(priced)

    const add = (a, b) => {
      if ((a === null || a === undefined) && (b === null || b === undefined)) return null
      return (Number(a) || 0) + (Number(b) || 0)
    }

    const out = new Map()
    for (const r of priced) {
      const key = visibleDims.map((k) => String(r[k] ?? '')).join('')
      const held = out.get(key)
      if (!held) {
        // `__n` counts how many rows went into this one. Whether the fold
        // combined anything is what decides if the derived columns below have
        // to be worked out again — see the note there.
        out.set(key, {
          ...r,
          __n: 1,
          __articles: new Set([String(r['Item No.'] ?? '').trim()]),
          /*
           * Site outbound, kept per article rather than added row by row.
           *
           * It is the only quantity on the row that is stamped on EVERY recipe
           * line of an article instead of on one - see `withSiteOutbound` - so
           * adding it the way the figures above are added would count one
           * article's outbound once per recipe. Keeping the first value instead
           * fixes that and breaks the other case: a fold that spans several
           * ARTICLES would then report only the first one's outbound.
           *
           * A map keyed on the article answers both. One article over three
           * recipe lines contributes one entry; three articles contribute three,
           * and the sum below is the figure the folded row actually describes.
           */
          __siteOb: new Map([[String(r['Item No.'] ?? '').trim(), r.Site_Outbound_Qty]]),
        })
        continue
      }
      held.__n += 1
      held.Component_Forecast_Qty = add(held.Component_Forecast_Qty, r.Component_Forecast_Qty)
      // Summed alongside it so a folded row can still be scored on what was
      // predicted rather than on what the packs rounded it up to.
      held.Component_Forecast_Unrounded = add(
        held.Component_Forecast_Unrounded ?? held.Component_Forecast_Qty,
        r.Component_Forecast_Unrounded ?? r.Component_Forecast_Qty
      )
      held.Component_Actual_Qty = add(held.Component_Actual_Qty, r.Component_Actual_Qty)
      held.Consumed_Qty = add(held.Consumed_Qty, r.Consumed_Qty)
      held.Live_Outbound_MTD = add(held.Live_Outbound_MTD, r.Live_Outbound_MTD)
      held.WH_Constant_Forecast_Qty = add(held.WH_Constant_Forecast_Qty, r.WH_Constant_Forecast_Qty)
      /*
       * Safety stock quantity sums, unlike the policy beside it.
       *
       * It is stamped once per article, on the row carrying that article's
       * warehouse figures, so folding an article's recipe rows together adds
       * nothing to it. Across several articles it adds up to the buffer the
       * group as a whole is meant to hold, which is the figure the row now
       * describes. It is not re-derived from the summed forecast below because
       * the merged articles need not share a policy.
       */
      held.Safety_Stock_Qty = add(held.Safety_Stock_Qty, r.Safety_Stock_Qty)
      /*
       * The stock columns, which the fold used to drop entirely.
       *
       * Fixed 17 Sep 2026. Every one of these is stamped by the server on ONE
       * row per article - the row carrying the warehouse figures - and the fold
       * copied the FIRST row of the group and merged only the quantities. When
       * the first row was a recipe line rather than the carrying one, all four
       * columns kept its nulls and the folded row showed a dash for stock it
       * demonstrably had. Beef Ground Chuck Mr.Cleaver was the case that found
       * it: WH opening, WH closing, Pending PO and Store SOH all blank on one
       * folded row, with a real pending PO of 2,250 sitting on the row the fold
       * had discarded.
       *
       * Added rather than taken once, for the same reason Safety_Stock_Qty is:
       * each article contributes its figure exactly once, on its own carrying
       * row, so summing gives that article's value when the group is one
       * article and the group's total when it is several. `add` keeps null as
       * null, so "no reading" survives and does not become a zero.
       */
      held.WH_Opening_SOH = add(held.WH_Opening_SOH, r.WH_Opening_SOH)
      held.WH_Closing_SOH = add(held.WH_Closing_SOH, r.WH_Closing_SOH)
      held.Open_PO_Qty = add(held.Open_PO_Qty, r.Open_PO_Qty)
      held.Open_PO_Value = add(held.Open_PO_Value, r.Open_PO_Value)
      held.Store_SOH = add(held.Store_SOH, r.Store_SOH)
      /*
       * Store DTL is CARRIED, not added — and it has to be carried, not left
       * to the spread above.
       *
       * The same fault the note above describes, which Store_DTL was added
       * after and so never got the fix. The server stamps it on ONE row per
       * article, the fold seeds from the FIRST row of the group, and for a raw
       * material that first row is a recipe line with no stock columns on it -
       * so the folded row showed a Store SOH (because that one is summed) and
       * a dash beside it for cover the article demonstrably had. Flour All
       * Purpose over 1-31 Aug was the case: Store SOH 10,275.34, intake
       * 57,930, a real answer of 5.5 days, and a blank cell.
       *
       * Taken rather than summed because it is DAYS, not units. Adding the
       * cover of two articles gives a number that describes neither. Where a
       * group has merged several articles it is blanked outright further down,
       * for the same reason.
       */
      held.Store_DTL = held.Store_DTL ?? r.Store_DTL
      held.New_Required_Qty = add(held.New_Required_Qty, r.New_Required_Qty)
      held.__articles.add(String(r['Item No.'] ?? '').trim())
      // First non-null wins per article: the value repeats across an article's
      // recipe lines, so any one of them is that article's figure.
      {
        const art = String(r['Item No.'] ?? '').trim()
        const seen = held.__siteOb.get(art)
        if (seen === null || seen === undefined) held.__siteOb.set(art, r.Site_Outbound_Qty)
      }
      // Measured anywhere in the group means measured, so one unmatched article
      // does not blank a row that has a real figure in it.
      if (r.Consumed_Qty !== null && r.Consumed_Qty !== undefined) delete held.Consumed_Unknown
    }

    return stampSiteAcc([...out.values()].map((r) => {
      /*
       * A policy belongs to one article, so it is withheld once a row stops
       * being one article.
       *
       * Safety stock policy, lead time and delivery frequency are per-article
       * settings, not quantities: they cannot be added and there is no sense in
       * which a group of articles has "a" lead time. Showing whichever one the
       * fold happened to keep would read as the group's own.
       */
      const oneArticle = r.__articles.size <= 1
      delete r.__articles
      const folded = r.__n > 1
      delete r.__n

      /*
       * Site outbound: one contribution per article, summed.
       *
       * Null only when NO article in the group had a figure - a group where one
       * article is measured and another is not reports what is known rather
       * than blanking the lot, which is the same rule `Consumed_Unknown` uses
       * just above.
       */
      {
        const vals = [...r.__siteOb.values()].filter((v) => v !== null && v !== undefined)
        delete r.__siteOb
        r.Site_Outbound_Qty = vals.length ? vals.reduce((s, v) => s + (Number(v) || 0), 0) : null
      }
      if (!oneArticle) {
        r.Safety_Stock_Days = null
        r.Lead_Time_Days = null
        r.Delivery_Freq = null
        /*
         * A ratio does not survive a fold across articles.
         *
         * Store SOH above is summed, because units add. Store DTL is days, and
         * the days of cover of a group is not the days of cover of any article
         * in it — recomputing it would need the group's combined intake, which
         * is not carried on the row. Keeping the first article's figure would
         * silently label the group with one member's number, which is the worse
         * of the two failures.
         */
        r.Store_DTL = null
      }


      /*
       * Re-derive whenever rows were actually combined.
       *
       * This used to test whether the fold spanned more than one ARTICLE, and
       * that missed the commonest case on this page. An article's warehouse
       * figures arrive on their own row - "No recipe - from outbound" - beside
       * its recipe rows, all under the same article number. Folding those sums
       * the quantities onto one line but the article count stays at one, so the
       * early return fired and every derived column kept the first row's value.
       *
       * Eggs was the case that showed it: article 102100003, whose warehouse
       * side sits almost entirely in the catch-all bucket. The folded row
       * showed WH forecast and Outbound correctly and then a dash for WH ACC%,
       * Forecast variance and Actual variance, because the row it copied them
       * from was the recipe row, where all three are null by design.
       */
      if (!folded) return r

      const c = r.Consumed_Qty
      const known = c !== null && c !== undefined
      // The same formula as `score` above, on a folded row's own totals.
      // The same formula as `score` above, on a folded row's own totals.
      const rescore = (target) => {
        if (!known || target === null || target === undefined) return null
        const outbound = Number(c)
        const bigger = Math.max(outbound, Number(target))
        return bigger > 0 ? 1 - Math.abs(Number(target) - outbound) / bigger : null
      }
      return {
        ...r,
        // Same rule as above: a folded row with no demand figure has no demand
        // accuracy, rather than an accuracy of zero.
        Accuracy:
          r.Component_Forecast_Qty === null || r.Component_Forecast_Qty === undefined
            ? null
            : rescore(Number(r.Component_Forecast_Unrounded ?? r.Component_Forecast_Qty) || 0),
        // Unrounded, for the same reason `held.wh` is: see `priced` above.
        // The stock rule uses the folded row's own summed Store SOH, so a
        // group is judged on the stock of the articles actually in it.
        WH_Accuracy: whAccuracy(
          rescore(r.WH_Forecast_Unrounded ?? r.WH_Constant_Forecast_Qty),
          r.WH_Forecast_Unrounded ?? r.WH_Constant_Forecast_Qty,
          r.Store_SOH
        ),
        WH_Acc_Covered: coveredByStock(
          r.WH_Forecast_Unrounded ?? r.WH_Constant_Forecast_Qty,
          r.Store_SOH
        ),
        WH_Ratio_Acc: whRatioAccuracy(
          c,
          r.WH_Forecast_Unrounded ?? r.WH_Constant_Forecast_Qty,
          r.Store_SOH
        ),
        /*
         * Re-divided on the folded row's own totals, not carried over: a merged
         * row shows summed outbound against summed forecast, so its ratio has
         * to come from those sums.
         */
        WH_New_Pct: (() => {
          const f = Number(r.WH_Constant_Forecast_Qty)
          const c = Number(r.Consumed_Qty)
          return Number.isFinite(f) && Number.isFinite(c) && f > 0 ? c / f : null
        })(),
        /*
         * Actual ACC% is not re-derived here. `stampSiteAcc` runs over whatever
         * this fold produces and scores every row from its article's totals,
         * which is the only grain the figure is meaningful at - so doing it on
         * one row's numbers here would just be overwritten, or worse, disagree.
         */
        /*
         * Re-scored on the row's own totals, like the other two.
         *
         * This one was being carried over from whichever article the fold
         * happened to keep, so a merged row could show quantities from several
         * articles beside an accuracy belonging to one of them.
         */
        Sales_Accuracy:
          r.Component_Actual_Qty === null ||
          r.Component_Actual_Qty === undefined ||
          Number(r.Component_Actual_Qty) <= 0 ||
          r.Component_Forecast_Qty === null ||
          r.Component_Forecast_Qty === undefined
            ? null
            : 1 -
              Math.abs(Number(r.Component_Actual_Qty) - Number(r.Component_Forecast_Qty)) /
                Number(r.Component_Actual_Qty),
        /*
         * The two variances, on the folded row's own totals.
         *
         * They were missing from this list entirely - added 16 Sep 2026 - so a
         * folded row carried whichever value the first row happened to hold.
         * Worked out here exactly as they are per article: both sides have to be
         * present, and a missing side leaves the cell blank rather than reading
         * as a variance equal to the side that is there.
         */
        Forecast_Variance:
          r.Component_Forecast_Qty === null ||
          r.Component_Forecast_Qty === undefined ||
          r.WH_Constant_Forecast_Qty === null ||
          r.WH_Constant_Forecast_Qty === undefined
            ? null
            : Number(r.Component_Forecast_Qty) - Number(r.WH_Constant_Forecast_Qty),
        Actual_Variance:
          r.Component_Actual_Qty === null ||
          r.Component_Actual_Qty === undefined ||
          r.Consumed_Qty === null ||
          r.Consumed_Qty === undefined
            ? null
            : Number(r.Component_Actual_Qty) - Number(r.Consumed_Qty),
        // Re-scored on the folded row's own totals, like every other ratio here.
        Actual_Accuracy: (() => {
          if (
            r.Component_Actual_Qty === null ||
            r.Component_Actual_Qty === undefined ||
            r.Consumed_Qty === null ||
            r.Consumed_Qty === undefined
          ) {
            return null
          }
          const a = Number(r.Component_Actual_Qty)
          const c = Number(r.Consumed_Qty)
          const bigger = Math.max(a, c)
          return bigger > 0 ? 1 - Math.abs(a - c) / bigger : null
        })(),
      }
    }))
  }, [priced, visibleDims, noWarehouse, stampSiteAcc])

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
    // Open-ended at the bottom: a score can now be negative, and an article
    // that fell off the scale is exactly the one this band is for.
    { key: '0-20', label: 'Under 20%', lo: -Infinity, hi: 0.2 },
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
  /*
   * Whether to show rows whose 100% came from the stock rule.
   *
   * null shows everything. 'stock' shows only the rows that scored 100%
   * because the shops already held twice the forecast; 'scored' shows only the
   * rows whose score was actually measured against outbound.
   *
   * Worth separating because the two are not the same claim and there are a
   * lot of the first kind - about four rows in five meet the stock condition -
   * so a reader checking forecast quality needs to be able to put them aside.
   */
  const [covered, setCovered] = useState(null)

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
    /*
     * Only rows that carry a warehouse score can be on either side of this.
     * A recipe line with no WH ACC% at all is neither stock-covered nor
     * measured, so it leaves with both choices rather than defaulting into one.
     */
    if (covered === 'stock') out = out.filter((r) => r.WH_Acc_Covered === true)
    if (covered === 'scored') {
      out = out.filter(
        (r) =>
          !r.WH_Acc_Covered && r.WH_Accuracy !== null && r.WH_Accuracy !== undefined
      )
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- BANDS is constant
  }, [grouped, band, fcstBand, covered])

  /*
   * What the table reports it is showing. Declared here rather than beside the
   * other view state below, because the memos under it read it — and a `const`
   * read before its declaration is a crash, not a `undefined`.
   */
  const [view, setView] = useState(null)

  /*
   * The article whose recipe breakdown is open, or null.
   *
   * Held here rather than inside the dialog so that closing it does not throw
   * away the fetch, and so the table below stays exactly where it was.
   */
  const [usage, setUsage] = useState(null)
  const [finding, setFinding] = useState(false)

  /*
   * The file is named for what it is and when it covers.
   *
   * "bbt-component-level.csv" was wrong twice over: the page is Stock Articles
   * and has not been BBT-only since brands became a slicer. A download that
   * cannot be told apart from last week's is a download somebody has to open to
   * identify, and browsers helpfully append "(7)" rather than complaining.
   */
  const exportName = useMemo(() => {
    const from = filters?.dateFrom
    const to = filters?.dateTo
    const period = from && to ? (from === to ? from : `${from} to ${to}`) : 'all dates'
    return `Stock Articles - ${period}.csv`
  }, [filters?.dateFrom, filters?.dateTo])

  /*
   * The cards read the table's OWN rows, not a re-selection from the full set.
   *
   * They used to take the article NUMBERS the table was showing and re-filter
   * `priced` by them. That was close enough while the only filters were the
   * search box and the accuracy bands, neither of which can keep one brand's
   * row of an article and drop another's.
   *
   * The Scoring slicer can. Article 101200028 is stock-covered for PAT and BUR
   * but not for BBT: the table correctly showed the two covered rows, and the
   * cards dragged the BBT row back in - with 2,456 units of outbound, enough to
   * dominate the volume weighting. "Stock-covered 100% only" read 100.0% in the
   * column total and 95.2% on the card. Reported 27 Sep 2026; 41 rows across 32
   * articles were being pulled back that way.
   *
   * Taking `view.rows` directly makes the cards exactly the table's dataset,
   * whatever narrowed it - filters, bands, the slicer, the search box, or
   * anything added later. Nothing has to know which filters exist.
   *
   * Pagination is deliberately not part of it: `onViewChange` reports the rows
   * left after the search, not the page being looked at, so paging through the
   * table does not move the cards.
   */
  const focused = view?.rows ?? priced

  /*
   * Distinct articles, not rows — corrected 16 Sep 2026.
   *
   * The card is labelled "Articles" and was counting `focused.length`, which is
   * rows: one per brand per recipe group per unit, so an article used by three
   * recipes counted three times. It read 1,834 while the CSV beside it held
   * 1,187, and both were right about different things — the card counted rows
   * before the table folds them, the download exports them after.
   *
   * Counting articles makes the label true and makes the figure stable: it no
   * longer moves when somebody hides Recipe Group in Build view and the rows
   * collapse underneath it.
   *
   * Keyed the same way the per-article roll-up is — article number, falling
   * back to the name for kitchen steps, which have no number and are still one
   * thing each.
   */
  const articleCount = useMemo(() => {
    const seen = new Set()
    for (const r of focused) {
      const k = String(r['Item No.'] ?? '').trim() || String(r.Item ?? '').trim()
      if (k) seen.add(k)
    }
    return seen.size
  }, [focused])

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
  const summary = useMemo(() => {
    let forecast = 0
    let actual = 0
    let consumed = 0
    /*
     * Outbound twice, because two questions want it.
     *
     * `consumed` is every article's outbound in view, which is what the card
     * above the table shows and what the Outbound column totals underneath it.
     * `consumedCovered` is only the part a recipe requirement covers, which is
     * what the card's progress bar compares against that requirement - mixing
     * the two would measure outbound the recipes never asked for against a
     * requirement that never asked for it.
     */
    let consumedCovered = 0
    // Rows a recipe names, so the card beside this one can say whether it has
    // nothing to measure or nothing was sold.
    let recipeRows = 0
    let scored = 0
    // Distinct articles the warehouse has an outbound figure for. Not the same
    // as `scored`, which counts articles scorable on product-mix accuracy.
    const withOutbound = new Set()
    /*
     * The requirement for the articles the consumption total actually covers.
     *
     * Not the same as `forecast`, and the difference is the point. `forecast` is
     * every row on the page; `consumed` can only be the articles the warehouse
     * has records for. Comparing the two directly counts every unmatched
     * component as a total miss — the same mistake as scoring them zero, made
     * one level up. So the headline compares like with like.
     */
    /*
     * The same pair again, for the warehouse forecast.
     *
     * Kept separate rather than reusing the figures above, because the two are
     * scored over different sets: an article can have a recipe requirement and
     * no warehouse history, or warehouse history and no recipe. Comparing one
     * method's total against the other's set would flatter or punish it for
     * covering different articles.
     */
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
      const hasOutbound = c !== null && c !== undefined

      if (recipeRow) {
        recipeRows += 1
        forecast += Number(r.Component_Forecast_Qty) || 0
        actual += Number(r.Component_Actual_Qty) || 0
        if (hasOutbound) consumedCovered += Number(c) || 0
      }

      const a = String(r['Item No.'] ?? '').trim()
      if (!a) continue

      /*
       * Outside the recipe test, and that is the fix.
       *
       * The outbound total used to be accumulated inside it, so an article with
       * no recipe contributed nothing to the card however much of it left the
       * warehouse. Searching the table for one non-recipe article - a raw
       * material, which is most of what the warehouse ships - left the card
       * reading "No transfers matched this view" directly above an Outbound
       * column reading 15. The card was answering a question about recipes
       * while wearing the column's name.
       *
       * Added rather than taken once per article: an article used by different
       * recipe groups in different brands stays as separate rows, each carrying
       * its own share, so taking one would throw the rest away. Same rule as
       * the per-article roll-up above.
       */
      if (hasOutbound) {
        consumed += Number(c) || 0
        withOutbound.add(a)
      }

      if (!recipeRow) continue
      if (r.Accuracy === null) {
        if (r.Consumed_Unknown) unmatched.add(a)
        continue
      }
      if (seen.has(a)) continue
      seen.add(a)
      scored += 1
    }

    /*
     * The totals, compared — which is the figure a reader can check by hand
     * against the two column totals in the table below.
     *
     * It flatters: totals can agree while every article inside them is wrong,
     * one over-forecast cancelling the next. The card used to carry the average
     * article beside it to say so, and that was removed on 3 Sep 2026; the two
     * band charts under the table now show that distribution properly, which is
     * more use than a single averaged number was.
     *
     * Divided by what actually moved, and floored at zero, so it reads as a
     * percentage of reality rather than of the forecast's own opinion.
     */
    /*
     * Forecast qty against Actual qty — the two columns the card sits above.
     *
     * It used to compare the recipe requirement against Outbound, which is a
     * warehouse measure wearing a product-mix name: for packaging the two are
     * wildly different quantities, so the card read 0.0% while the ACC% column
     * beside it read 95.8% and both were "right" about different questions.
     *
     * Same formula as the column, same totals, so the card is now derivable by
     * hand from the totals row underneath it. Divided by actual, floored at
     * zero, matching the report's Variation Percentage MTD.
     */
    /*
     * The average article, not the totals compared.
     *
     * Asked for on 6 Sep 2026, and it is the harder of the two numbers: totals
     * let a component over-forecast by 40,000 cancel one under-forecast by the
     * same, and report near-perfection over a set where nothing individually
     * matched. Averaging the article scores refuses that cancellation.
     *
     * Computed by the same helper the column footer calls, over the same rows,
     * so the card and the footer are one figure in two places.
     */
    const mix = averageScore(focused.filter(fromRecipe), 'Sales_Accuracy')
    const overall = mix?.value ?? null

    // The same treatment on the warehouse side, over every article rather than
    // only the ones a recipe names.
    const wh = averageScore(focused, 'WH_Accuracy')
    const whOverall = wh?.value ?? null

    /*
     * And both again, weighted by volume.
     *
     * Each side is weighted by its own actual: the recipe figure by the
     * quantity the recipes imply was used, the warehouse figure by what the
     * warehouse actually issued. Weighting either by a forecast would let the
     * thing being judged decide how much it counts.
     */
    const mixByVolume = weightedScore(
      focused.filter(fromRecipe),
      'Sales_Accuracy',
      'Component_Actual_Qty'
    )
    const whByVolume = weightedScore(focused, 'WH_Accuracy', 'Consumed_Qty')

    /*
     * The `New` column's figure for the whole set: outbound over forecast.
     *
     * Summed then divided, never an average of the per-article ratios. An
     * article that shipped forty units would otherwise count as heavily as one
     * that shipped six hundred thousand, and one tiny denominator could put the
     * card into the hundreds of percent on its own.
     *
     * Deliberately the same rows as the two scores above it, and the same rule
     * about needing both sides: a row with outbound but no forecast beside it
     * would lift the ratio without belonging to it.
     *
     * The FORECAST side is the unrounded one. The card is judging the forecast,
     * and scoring it against a figure lifted to a pack boundary would grade the
     * packaging — the column in the table uses the displayed figure so a reader
     * can reproduce it by eye, and the two differ by about a thousandth of a
     * percent.
     */
    /*
     * Averaged across articles, not divided as one big total.
     *
     * Changed 26 Sep 2026 on request: the card now averages the New WH ACC%
     * column beneath it, so the headline and the column agree. It used to be
     * SUM(outbound) / SUM(forecast), which is a different question - that is
     * the warehouse's overall fill rate, where this is how the typical article
     * did. On 1-23 Sep the two read 92.9% and 91.7%.
     *
     * The quantities are still summed for the footnote, because "7.3m out vs
     * 7.7m forecast" is worth saying and cannot be recovered from an average.
     */
    let newFc = 0
    let newOut = 0
    let newScored = 0
    let newAccSum = 0
    for (const r of focused) {
      const f = Number(r.WH_Forecast_Unrounded ?? r.WH_Constant_Forecast_Qty)
      const c = Number(r.Consumed_Qty)
      if (!Number.isFinite(f) || !Number.isFinite(c) || f <= 0) continue
      newFc += f
      newOut += c
      newScored += 1
      // The row's own score, stock rule included — the same number the column
      // shows, so the card cannot disagree with the rows it summarises.
      const a = whRatioAccuracy(c, f, r.Store_SOH)
      newAccSum += a === null ? 0 : a
    }
    const newRatio = newScored > 0 ? newAccSum / newScored : null

    return {
      newRatio,
      newScored,
      newFc,
      newOut,
      forecast,
      actual,
      mixArticles: mix?.count ?? 0,
      consumed,
      consumedCovered,
      outboundArticles: withOutbound.size,
      recipeRows,
      // Scorable on product-mix accuracy. Named for that rather than
      // "measured", which is what the Outbound card mistook it for.
      mixScored: scored,
      unmatched: unmatched.size,
      overall,
      overallByVolume: mixByVolume?.value ?? null,
      whMeasured: wh?.count ?? 0,
      whOverall,
      whOverallByVolume: whByVolume?.value ?? null,
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
  const columns = useMemo(() => {
    let list = future
      ? ORDERED_COLUMNS.filter(
          (c) =>
            c.key !== 'Consumed_Qty' &&
            c.key !== 'Accuracy' &&
            c.key !== 'WH_Accuracy' &&
            c.key !== 'Sales_Accuracy' &&
            /*
             * Actual qty goes too, and this was the one real defect behind the
             * "why 0 here and a dash there" question.
             *
             * The copy stores actual as a literal 0 for a month that has not
             * happened: October, November and December 2026 are 2,666 rows
             * each with an actual total of exactly nought. Printed through
             * fmtQty that is a column of "0" beside a full forecast, which
             * reads as a total shortfall rather than as a period nobody has
             * traded yet. Consumed_Qty and the accuracies were already dropped
             * here for precisely this reason; this column was missed.
             */
            c.key !== 'Component_Actual_Qty' &&
            // Depends on both of the above, so it cannot be formed either.
            c.key !== 'Actual_Variance'
        )
      : ORDERED_COLUMNS
    /*
     * Store inventory and replenishment are for maintainers for now.
     *
     * The server withholds the fields as well, so this is tidiness rather than
     * the control itself — without it a reader would get five permanently empty
     * columns and two group headings over nothing.
     */
    if (!STORE_COLUMNS_ON || !stockDetail) list = list.filter((c) => !STOCK_COLUMNS.has(c.key))
    if (!STORE_SOH_ON || !stockDetail) list = list.filter((c) => !STORE_SOH_COLUMNS.has(c.key))
    if (!stockDetail) list = list.filter((c) => !WH_STOCK_COLUMNS.has(c.key))
    if (!REPL_COLUMNS_ON) list = list.filter((c) => !REPL_COLUMNS.has(c.key))
    if (noWarehouse) {
      list = list.filter((c) => !NO_WAREHOUSE_COLUMNS.has(c.key))

      /*
       * The Production page's own column order - asked for on 29 Sep 2026.
       *
       * Done here rather than by moving entries in COLUMNS, because that array
       * is shared with Stock Article and reordering it would move that page's
       * columns too. The bands follow the order of the list, so placing the
       * outbound pair directly after the Product mix run puts them beside it,
       * and putting the Stock run last leaves it at the far right.
       *
       * Sales ACC% goes entirely: it scores the SALES forecast read through
       * the recipes, which is a question about the menu rather than about
       * production, and it repeated for every row of an article.
       */
      list = list.filter((c) => c.key !== 'Sales_Day_Accuracy')

      /*
       * The two sections, and their names on THIS page only - 29 Sep 2026.
       *
       * Asked for so the page reads as two comparable halves: what the recipes
       * imply, and what the kitchens actually did. Inside a band a column does
       * not need to repeat its source in its own name, so "Site outbound"
       * becomes "Outbound" and "Site forecast" becomes "Forecast" - the heading
       * above them already says which.
       *
       * Done as a map INSIDE this branch rather than by editing COLUMNS, for the
       * same reason the reorder above is: that array is shared with Stock
       * Article. Two of these three columns are filtered off that page anyway,
       * but `Site_Acc` is not - it reaches it through a leak documented in the
       * else branch below - so renaming or regrouping it in COLUMNS would have
       * moved a column on a page under a standing instruction not to change.
       * Here it cannot.
       *
       * `Site_Acc` is deliberately NOT in the Outbound forecast band. It scores
       * the PRODUCT MIX forecast against what was issued, so it belongs with the
       * thing it judges; putting it under "Outbound forecast" would read as that
       * forecast's own accuracy, which it is not. It was not named in the
       * request either way - it is kept rather than dropped because removing a
       * column nobody asked to remove is the worse mistake.
       */
      const SECTIONS = {
        /*
         * Product mix, renamed 29 Sep 2026.
         *
         * "PM" for product mix, so the two bands can be told apart at a glance
         * when both carry a forecast and an actual. `Component_Forecast_Qty`
         * and `Component_Actual_Qty` are SHARED with Stock Article, which is why
         * these belong in this map and not in COLUMNS - that page keeps
         * "Forecast qty" and "Actual qty".
         */
        Component_Forecast_Qty: { label: 'PM Forecast' },
        Component_Actual_Qty: { label: 'PM Actual' },
        /*
         * `Site_Acc` names what it compares rather than calling itself an
         * accuracy: outbound against the product-mix forecast. Worth knowing the
         * label reads as a division and the figure is not one - it is the
         * bounded score 1 - |PM Forecast - Outbound| / MAX(the two), unchanged
         * by this rename. Read the slash as "versus".
         */
        /*
         * `autoWidth` because the label is now far wider than the fixed 116px
         * this column carries for Stock Article, where it is still "Actual
         * ACC%". Headers are rendered uppercase, so "OUTBOUND/PM FORECAST"
         * measured well past the fixed width and was truncated to
         * "OUTBOUND/PM FOR...". `autoWidth` sizes from the header, and it wins
         * over `width` in `floorOf`, so the fixed value can stay for the page
         * that still uses the short name.
         */
        Site_Acc: { label: 'Outbound/PM Forecast', group: 'fcst', autoWidth: true },
        Site_Outbound_Qty: { label: 'Outbound', group: 'siteout' },
        Site_Forecast_Qty: { label: 'Forecast', group: 'siteout' },
        Site_Fc_Acc: { label: 'Acc%', group: 'siteout' },
      }
      list = list.map((c) => (SECTIONS[c.key] ? { ...c, ...SECTIONS[c.key] } : c))

      const take = (keys) => keys.map((k) => list.find((c) => c.key === k)).filter(Boolean)

      /*
       * Both bands are ordered EXPLICITLY, not left to COLUMN_ORDER.
       *
       * None of the four Site_* keys appears in COLUMN_ORDER, so they all rank
       * last and sort to the end of the table. That is harmless while they are
       * ungrouped, and wrong the moment they carry a group: `Site_Acc` would
       * have landed at the far right while the rest of Product mix sat on the
       * left, leaving the band in two pieces - and a group's shading and its
       * collapse control both need its columns to be contiguous.
       *
       * Adding the keys to COLUMN_ORDER would have fixed the order and moved
       * `Site_Acc` on Stock Article, which is not allowed to change. Listing
       * both runs here keeps the fix on this page.
       */
      const mixRun = take([
        'Component_Forecast_Qty',
        'Component_Actual_Qty',
        'Sales_Accuracy',
        'Site_Acc',
      ])
      // In the order asked for: Outbound, Forecast, Acc%.
      const outbound = take(['Site_Outbound_Qty', 'Site_Forecast_Qty', 'Site_Fc_Acc'])
      const stockRun = list.filter((c) => c.group === 'whstock')
      const moved = new Set([...mixRun, ...outbound, ...stockRun].map((c) => c.key))

      /*
       * The two bands go where Product mix already started, so the dimension
       * columns keep their place on the left and the Stock run stays far right.
       */
      const startsAt = list.findIndex((c) => c.group === 'fcst' && moved.has(c.key))
      const head = (startsAt === -1 ? list : list.slice(0, startsAt)).filter(
        (c) => !moved.has(c.key)
      )
      const tail = (startsAt === -1 ? [] : list.slice(startsAt)).filter((c) => !moved.has(c.key))

      list = [...head, ...mixRun, ...outbound, ...tail, ...stockRun]
    } else {
      /*
       * Site outbound only where the warehouse half is hidden.
       *
       * On Stock Article the warehouse column is the meaningful measure and
       * this one would sit beside it answering a question nobody asked there.
       */
      /*
       * Site outbound goes, and so do both of the PA forecast's own columns.
       *
       * `Site_Forecast_Qty` and `Site_Fc_Acc` are new on 29 Sep 2026 and belong
       * to the production pages: this page is the BOUGHT half, where the
       * warehouse forecast is the second opinion and the kitchens have nothing
       * to say. They are filtered rather than never stamped so that the server
       * keeps one code path for both pages.
       */
      list = list.filter(
        (c) =>
          c.key !== 'Site_Outbound_Qty' &&
          c.key !== 'Site_Forecast_Qty' &&
          c.key !== 'Site_Fc_Acc' &&
          /*
           * `Site_Acc` goes too, from 1 Oct 2026 on request.
           *
           * The note below records why it was left: it reached this page only
           * because the filter dropped the outbound QUANTITY and not the ratio
           * built on it, so the page showed a figure whose numerator was
           * hidden - and every row of it read as a dash, because this is the
           * bought half and no site issues these articles. Removing it was
           * already the right fix; the standing instruction not to change this
           * page is what held it back, and that instruction has now been
           * lifted for this column.
           *
           * The production pages are unaffected: this whole branch runs only
           * when `noWarehouse` is false, and those pages place `Site_Acc` in
           * their own Product mix run above.
           */
          c.key !== 'Site_Acc'
      )

      /*
       * Actual ACC% is left exactly as Stock Article already had it.
       *
       * That column reaches this page only because the filter above drops the
       * outbound quantity and not the ratio built on it - so the page shows a
       * figure whose numerator is hidden. It is a leak, and removing the column
       * is the right fix, but this page is under a standing instruction not to
       * change, so the 29 Sep 2026 work is held off it instead: `siteAcc` keeps
       * the old ratio here, the fold does not re-derive it, and the totals cell
       * stays empty rather than gaining the new weighted score.
       */
    }
    return list
  }, [future, stockDetail, noWarehouse])

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
    /*
     * The Stock Article restyle is scoped to this class, exactly as the
     * Overview's is to `.ovr`. `.scroll` is a spaced flex column and this
     * div becomes its only child, so the class reproduces that column.
     */
    <div className="cmp">
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
        {/*
          * The Outbound card was removed on 30 Sep 2026, on request.
          *
          * The figure itself is untouched - `summary.consumed` still feeds the
          * Outbound column, the Outbound vs forecast card beside it and the
          * accuracy scoring. Only this summary tile is gone.
          */}
        {/*
          * No accuracy on a window that has not happened.
          *
          * Nothing has been issued against a future requirement, so the card
          * reads 0.0% — which looks like a catastrophic forecast rather than an
          * absence of evidence. The columns it summarises are already dropped
          * for a future window; the card was the piece left behind.
          */}
        {/*
          * Kept on the Production page, unlike the two warehouse cards it sits
          * between.
          *
          * It was gated with them on 27 Sep 2026 and should not have been: it
          * scores the RECIPE side, Component forecast against Component actual,
          * and never reads an outbound figure. That is exactly the question a
          * prep step or a prepared article can answer — the warehouse cards are
          * the ones with nothing to measure here.
          */}
        {!future && (
          <MetricCard
            label="Product mix accuracy"
            calc="card-product-mix,component-forecast,outbound"
            hint="How close the recipe side was, averaged across articles: 1 − |Forecast − Actual| ÷ the larger of the two."
            accent={summary.overall === null ? 'slate' : summary.overall >= 0.9 ? 'green' : 'amber'}
            progress={summary.overall ?? 0}
            loading={busy}
            value={summary.overall === null ? '–' : fmtPct(summary.overall, 1)}
            foot={
              summary.overall === null ? (
                /*
                 * Which of the two reasons it actually is.
                 *
                 * It said "nothing has sold" whatever the cause, so a view of
                 * raw articles - none of which have a recipe to explode, and
                 * most of what the warehouse ships - was told the shops had
                 * sold nothing. Phrased like the warehouse card beside it,
                 * which has the same shape of answer.
                 */
                summary.recipeRows ? (
                  'Nothing has sold in this window yet'
                ) : (
                  'Needs a recipe article to compare against'
                )
              ) : (
                <>
                  Average article · {fmtInt(summary.mixArticles)} scored
                  {summary.overallByVolume !== null && (
                    <>
                      <br />
                      Volume accuracy · {fmtPct(summary.overallByVolume, 1)}
                    </>
                  )}
                </>
              )
            }
          />
        )}
        {/*
          * The Fulfilment accuracy card was removed on 30 Sep 2026, on request.
          *
          * Its figure has not gone anywhere: it is the total of the Acc% column
          * under Outbound forecast, computed by the same `siteAccTotal`, so the
          * table still answers the question the card answered. What went is the
          * headline, which sat beside Product mix accuracy and invited the two
          * to be read as one score when they judge different forecasts.
          */}
        {/*
          * The other forecast, scored the same way.
          *
          * Beside the recipe accuracy rather than instead of it: the two are
          * measured over different sets of articles — one needs a recipe, the
          * other needs six months of warehouse history — so neither is a
          * substitute for the other, and where they disagree is the finding.
          */}
        {/*
          * Volume accuracy leads; the article average sits under it.
          *
          * The two describe the same forecast and disagree by around twenty
          * points — 79.1% against 55.6% on the same August window — because
          * the article average weights every line equally. Measured across
          * April-August: the top tenth of articles by volume carry 82% of
          * everything the warehouse ships and score 82.3%, while the bottom
          * half carry 0.3% of the volume and score 49.4%. Leading with the
          * equal-weighted figure therefore answered a question nobody was
          * asking — how did the typical *line* do — in the place people read
          * for how the *orders* did.
          *
          * Both stay on the card. Where they diverge is the finding: a wide
          * gap means the long tail is being missed while the volume is fine,
          * which is a different problem from the volume itself being wrong.
          */}
        {!future && !noWarehouse && (
          <MetricCard
            label="Warehouse accuracy"
            calc="card-warehouse,wh-forecast,outbound"
            hint="How close the WH forecast was to what shipped, weighted by volume: 1 − |Forecast − Outbound| ÷ the larger of the two."
            accent={
              summary.whOverallByVolume === null
                ? 'slate'
                : summary.whOverallByVolume >= 0.9
                  ? 'green'
                  : 'amber'
            }
            progress={summary.whOverallByVolume ?? 0}
            loading={busy}
            value={
              summary.whOverallByVolume === null ? '–' : fmtPct(summary.whOverallByVolume, 1)
            }
            foot={
              summary.whOverall === null ? (
                'Needs warehouse history to compare against'
              ) : (
                <>Volume weighted · {fmtInt(summary.whMeasured)} scored</>
              )
            }
          />
        )}

        {/*
          * The `New` column, for the whole of what the table is showing.
          *
          * Outbound over forecast, summed then divided. It answers a question
          * the card above it cannot: WH accuracy is capped at 100% and loses
          * the direction of the error, so a warehouse issuing half again what
          * was predicted and one issuing a third less can score alike. Here
          * over 100% means more went out than was forecast, under 100% means
          * less.
          *
          * Both directions are a miss, so the accent is green only near 100%
          * and amber either side — unlike accuracy, higher is NOT better.
          */}
        {!future && !noWarehouse && (
          <MetricCard
            label="Outbound vs forecast"
            calc="wh-forecast,outbound"
            hint="Outbound ÷ WH forecast. Over 100% shipped more than forecast — higher is not better."
            accent={
              summary.newRatio === null
                ? 'slate'
                : Math.abs(summary.newRatio - 1) <= 0.1
                  ? 'green'
                  : 'amber'
            }
            /* Clamped: a ratio of 1.5 would otherwise run the bar off its track. */
            progress={summary.newRatio === null ? 0 : Math.min(1, summary.newRatio)}
            loading={busy}
            value={summary.newRatio === null ? '–' : fmtPct(summary.newRatio, 1)}
            foot={
              summary.newRatio === null ? (
                'Needs a forecast and an outbound figure on the same article'
              ) : (
                <>
                  {fmtQty(summary.newOut)} out vs {fmtQty(summary.newFc)} forecast
                  <br />
                  {/* Says what the figure IS, because it is now an average of
                      articles rather than one big division. */}
                  average of {fmtInt(summary.newScored)} articles ·{' '}
                  {summary.newRatio >= 1 ? 'more shipped than forecast' : 'less shipped than forecast'}
                </>
              )
            }
          />
        )}

        {/*
          * Counted over what the table is showing, like every other card here.
          *
          * This one read `rows` while its own foot read the narrowed set, so a
          * search for one article produced "1,860" above "1 recipe groups" -
          * two answers to the same question in one card. The population is
          * still reported, in the place that belongs to it: the panel heading
          * below says how many rows there are and how many the search matched.
          */}
        <MetricCard
          label="Articles"
          calc="article-counts"
          hint="Distinct articles in this view, and the recipe groups they come from."
          accent="slate"
          progress={0.72}
          loading={busy}
          value={fmtInt(articleCount)}
          foot={`${fmtInt(groups)} recipe group${groups === 1 ? '' : 's'}`}
        />
        <MetricCard
          label="Largest requirement"
          calc="article-counts,component-forecast"
          hint="The article the forecast asks for most of, in its own base unit."
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
        calc="component-forecast,component-actual,acc-pct,wh-forecast,outbound,wh-acc,sales-acc,supply,site-outbound,site-acc,prod-source,prod-type,store-soh,store-negative,store-cover,store-dtl,wh-soh,variance,article-usage"
        /*
         * On the PANEL, not on the table inside it.
         *
         * The table's own `busy` only fires once the table renders - and on a
         * first load it does not render at all, the skeleton stands in its
         * place. So the page showed a grey box with nothing saying it was
         * loading, which is the case this was meant to cover. The panel wraps
         * both branches, so one indicator serves the first load and every
         * reload after it.
         */
        busy={busy}
        title="Article detail"
        count={busy ? undefined : `${rows.length.toLocaleString()} rows`}
        sub="What the forecast implies you need, beside what actually left the warehouse"
        flush
        fill
        tools={
          <>
          {/*
            * Put the stock-rule rows aside, or look at only them.
            *
            * About four rows in five meet the `2 x forecast <= Store SOH`
            * condition and score 100% without the forecast being measured at
            * all, so a reader judging forecast quality is mostly reading rows
            * that say nothing about it. The dot on the cell marks them one at a
            * time; this takes them out of the table in one go.
            *
            * Hidden on a future window, where nothing is scored and every
            * choice would return the same rows.
            */}
          {/*
            * ...and not where the warehouse columns are gone.
            *
            * The slicer sorts rows by whether their WH ACC% was earned or
            * handed to them by the stock rule. With no WH ACC% column on the
            * page there is no score to sort, so every choice returns the same
            * rows - and the two it offers name a column the reader cannot see.
            */}
          {!future && stockDetail && !noWarehouse ? (
            <label className="tgroup">
              <span title="WH ACC% of 100% can mean the forecast was right, or that the shops were already stocked. This separates the two.">
                Scoring
              </span>
              <select value={covered ?? ''} onChange={(e) => setCovered(e.target.value || null)}>
                <option value="">All rows</option>
                <option value="scored">Measured only (exclude stock-covered)</option>
                <option value="stock">Stock-covered 100% only</option>
              </select>
            </label>
          ) : null}
          {/*
            * The answer to "this article is missing".
            *
            * The search box beside it filters the rows on screen, which cannot
            * tell a reader why something is not there. This looks the article up
            * whether or not the page shows it, and says which of the reasons
            * applies — so the question gets settled here instead of by email.
            */}
          <button
            type="button"
            className="btn"
            onClick={() => setFinding(true)}
            title="Check whether any article is in the forecast, and see its twelve-month history"
          >
            Find an article
          </button>
          <button
            type="button"
            className="btn"
            disabled={!rows.length}
            onClick={() =>
              downloadCsv(
                exportName,
                view?.rows ?? priced,
                view?.columns ?? columns.map(({ key, label }) => ({ key, label }))
              )
            }
          >
            <IconDownload size={12} />
            CSV
          </button>
          </>
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
            // Type three letters and pick the article, rather than typing
            // enough of its name to be sure you have the right one.
            suggest={{ label: 'Item', code: 'Item No.' }}
            tableId="component-detail-v2"
            /*
             * Any shaded section can be put away, same as Replenishment
             * Planning. Safe without an opt-out here because the columns that
             * identify a row - Recipe, Article, Type, Unit, Article No. - carry
             * no group at all, so no collapse can reach them.
             */
            collapsibleGroups
            /*
             * No Freeze control where the warehouse columns are gone.
             *
             * Removing the warehouse and variance groups takes about fifteen
             * columns off the table, and what is left fits without scrolling
             * sideways - so there is nothing for a pinned first column to hold
             * still against.
             */
            freezable={!noWarehouse}
            onColumnsChange={setHiddenCols}
            onViewChange={setView}
            onRowClick={(row) => setUsage(row)}
            /*
              * The table scrolls inside itself, from 16 Sep 2026.
              *
              * It used to grow to whatever its page of rows needed. At the
              * default fifty rows that is about 1,800px of table, and every one
              * of those pixels sat between this table and the Replenishment
              * Planning table below it - so reaching the second table meant
              * scrolling the whole of the first, past rows nobody was reading.
              *
              * Capped instead, with its own scrollbar. Nothing about the table
              * changes: same rows, same page size, same sort, search, grouping
              * and totals, and the header stays stuck to the top of its own
              * scroll area so the columns are still labelled wherever you are
              * in it. 620px is roughly seventeen rows, which is enough to read
              * a band of articles without the page itself moving.
              *
              * `fill` is what has to go rather than be tuned: it makes the
              * table a flex item that grows to its content, and `maxHeight`
              * is only honoured when it is off.
              */
            maxHeight={620}
            groups={{
              /*
                * The production pages get their own text - 30 Sep 2026.
                *
                * `HELP.fcst` describes Stock Article's columns: "Forecast qty",
                * "Actual qty", and an ACC% with nothing else beside it. On these
                * pages the same columns are renamed PM Forecast and PM Actual
                * and a fourth one sits with them, so the panel was explaining
                * three columns that are not on screen under headings that are.
                * Reported with a screenshot of exactly that.
                */
              fcst: {
                label: 'Product mix',
                help: noWarehouse ? HELP.fcstProduction : HELP.fcst,
              },
              /*
                * The measured half, on the production pages only - 29 Sep 2026.
                *
                * Product mix above is what the RECIPES imply; this is what the
                * kitchens actually issued and the forecast built from that
                * history. Two bands rather than one long run, so the two methods
                * can be read against each other and either can be collapsed.
                *
                * Only where the warehouse half is hidden. Stock Article has its
                * own Warehouse band for the same purpose and none of these
                * columns.
                */
              ...(noWarehouse
                ? { siteout: { label: 'Outbound forecast', help: HELP.siteout } }
                : {}),
              ...(noWarehouse ? {} : { wh: { label: 'Warehouse', help: HELP.wh } }),
              /*
                * The two comparisons and their score, given a heading of their
                * own on 26 Sep 2026 so the section can be collapsed.
                *
                * They were ungrouped, which meant permanently on screen: the
                * collapse control works per shaded group, and a column with no
                * group belongs to none. Grouping them is what makes them
                * optional, and they read as a set anyway - both variances and
                * the score derived from the second one.
                */
              ...(noWarehouse ? {} : { variance: { label: 'Variance', help: HELP.variance } }),
              /*
                * "Stock", renamed 16 Sep 2026.
                *
                * It was "Warehouse stock" while every column under it was the
                * warehouse's. Store SOH now sits in the same run, so the
                * heading has to cover both sides - and each column's own
                * tooltip says which side it describes, which is where that
                * distinction belongs rather than in a heading nobody can fit
                * it into.
                */
              ...(stockDetail ? { whstock: { label: 'Stock', help: HELP.whstock } } : {}),
              ...(STORE_COLUMNS_ON && stockDetail
                ? {
                    stock: { label: 'Store inventory', help: HELP.stock },
                    ...(REPL_COLUMNS_ON
                      ? { repl: { label: 'Replenishment', help: HELP.repl } }
                      : {}),
                  }
                : {}),
            }}
          />
        )}
      </Panel>
      {/*
        * Replenishment Planning, directly below Article Detail.
        *
        * Asked for on 16 Sep 2026 as a SEPARATE table, not as more columns on
        * Article Detail: it is one row per article rather than per recipe line,
        * and it answers a different question - what to order and when, rather
        * than what was needed and what moved. It is fed the same rows, so the
        * two tables cannot disagree about a forecast.
        *
        * Admin only, on the same footing as the warehouse stock columns it
        * builds on, and withheld on a future window because a plan made from a
        * forecast the engine had to extrapolate would read as firmer than it is.
        */}
      {stockDetail && !noWarehouse && (
        <ReplenishmentPlanning rows={priced} filters={filters} busy={busy} />
      )}
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
          {/*
            * The warehouse band goes with the warehouse columns.
            *
            * On the Production page it read 889 of 896 articles "Not scored",
            * which is not a distribution - it is the page saying the warehouse
            * never ships these, once per article.
            */}
          {noWarehouse ? null : (
            <BandChart
              label="WH ACC%"
              bands={BANDS}
              counts={bandCounts}
              active={band}
              total={grouped.length}
              onPick={(k) => setBand(band === k ? null : k)}
            />
          )}
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
          <Panel calc="top-by-unit,component-forecast" title="Top components by unit">
            <Empty />
          </Panel>
        ) : (
          <>
            {facets.slice(0, 3).map((facet) => (
              <Panel
                key={facet.unit}
                title={`Top by ${facet.unit.toLowerCase()}`}
                calc="top-by-unit,component-forecast"
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

      {finding && <ArticleFinder onClose={() => setFinding(false)} />}

      {usage && (
        <ArticleUsage
          article={usage}
          filters={filters}
          onClose={() => setUsage(null)}
        />
      )}
    </div>
  )
}
