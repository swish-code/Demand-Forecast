/**
 * Every figure the app shows, and where it comes from.
 *
 * Written for the person who has to answer "why does that number say that?"
 * without reading the source. Each entry names the visual, says whether the
 * figure is a measure evaluated inside a Power BI model or arithmetic this app
 * does itself, and gives the exact expression in both cases.
 *
 * One honest limitation, stated here because the admin screen states it too:
 * a Power BI measure cannot be edited from here. The REST endpoint this app
 * uses — `executeQueries` — evaluates DAX and returns rows; it has no write
 * side. Changing `[Total_Actual_Qty]` means editing the semantic model in
 * Power BI Desktop, or writing to the XMLA endpoint, which needs Premium
 * capacity and a different set of permissions entirely. What this catalogue
 * gives you is the exact text to search for once you are in there.
 *
 * The app's own arithmetic is a different matter: it is listed with the same
 * detail, and the parts of it that are policy rather than definition — the
 * six-month window, the accuracy bands, the "low accuracy" line — are marked
 * `tunable`, because those are the ones worth changing without touching a
 * model.
 *
 * Kept beside the code it documents rather than in a wiki, so that a formula
 * changing and its description changing are one edit and not two.
 */

/** Where a figure is computed. */
const PBI = 'Power BI measure'
const LOCAL = 'Calculated by this app'
const COPY = 'Read from the local copy'

export const CALCULATIONS = [
  /* ------------------------------------------------ Overview ------------- */
  {
    id: 'actual-qty',
    page: 'Overview',
    visual: 'Actual qty card, Demand tracking chart',
    label: 'Actual Qty',
    source: PBI,
    expression: '[Total_Actual_Qty]',
    detail:
      'Evaluated per brand model, grouped by whatever the page is split on. The app never ' +
      'recomputes it — the same measure answers the card, the chart and the CSV.',
  },
  {
    id: 'forecast-qty',
    page: 'Overview',
    visual: 'Forecast qty card, Demand tracking chart',
    label: 'Forecast Qty',
    source: PBI,
    expression: '[Total_Forecast_Qty]',
  },
  {
    id: 'variance-pct',
    page: 'Overview',
    visual: 'Performance card — Variance',
    label: 'Variance %',
    source: PBI,
    expression: '[Variance%]',
    detail: 'The model’s own measure, shown as returned. Signed: negative means under forecast.',
  },
  {
    id: 'forecast-accuracy',
    page: 'Overview',
    visual: 'Performance card — Forecast accuracy',
    label: 'Forecast Accuracy %',
    source: PBI,
    expression: '[Forecast Accuracy %]',
  },

  /* ------------------------------------------- Product mix group --------- */
  {
    id: 'component-forecast',
    page: 'Stock Article',
    visual: 'Product mix — Forecast qty',
    label: 'Component_Forecast_Qty',
    source: PBI,
    expression: '[Component_Forecast_Qty]',
    detail:
      'The recipe explosion: forecast sales multiplied by the recipe quantity, summed over every ' +
      'recipe that names the article. Grouped by RECIPE TABLE columns. Blank for articles no ' +
      'recipe names — those are forecast on the warehouse side instead.',
  },
  {
    id: 'component-actual',
    page: 'Stock Article',
    visual: 'Product mix — Actual qty',
    label: 'Component_Actual_Qty',
    source: PBI,
    expression: '[Component_Actual_Qty]',
    detail:
      'The same explosion against the sales that actually happened. Because both sides use the ' +
      'same recipe at the same quantities, the recipe cancels between them — which is what makes ' +
      'ACC% beside them a sales measure rather than a recipe one.',
  },
  {
    id: 'acc-pct',
    page: 'Stock Article',
    visual: 'Product mix — ACC%',
    label: 'ACC% (per article)',
    source: LOCAL,
    expression: `MAX(0, 1 - ABS(Actual Qty - Forecast Qty) / Actual Qty)

Footer and card use the same expression over the column totals,
rather than averaging the per-article scores.`,
    detail:
      'One minus the size of the report’s Variation Percentage MTD, so it matches the brand ' +
      'dashboards: the denominator is actual, not the larger of the two. A consequence worth ' +
      'knowing — anything over-forecast by more than 2x actual goes negative and floors at 0%, ' +
      'so 0% covers everything from "twice too high" to "twenty times too high". Blank when ' +
      'nothing sold, because a forecast against no sales has no answer.',
    tunable: 'The floor and the choice of denominator.',
  },

  /* ---------------------------------------------- Warehouse group -------- */
  {
    id: 'outbound',
    page: 'Stock Article, Warehouse Insights',
    visual: 'Warehouse — Outbound',
    label: 'Outbound',
    source: COPY,
    expression: `SUMMARIZECOLUMNS(
  fact_outbound_line[Mapped Transfer To],
  fact_outbound_line[Article No.],
  TREATAS({"Central Warehouse"}, fact_outbound_line[Mapped Cost Center/Store]),
  DATESBETWEEN(dim_date[Date], <from>, <to>),
  FILTER(ALL(fact_outbound_line[Status Group]),
         fact_outbound_line[Status Group] IN {"BOOKED","DELIVERED","DECLINED"}),
  "Qty", SUM(fact_outbound_line[Action Base Qty])
)`,
    detail:
      'Run against the Warehouse Analytics model, then kept in a local copy that the pages read ' +
      'from. Source is the Central Warehouse; destinations are every location except the ' +
      'warehouse itself, which is what excludes internal self-transfers. dim_date[Date] follows ' +
      'Requested Delivery Date. Destinations belonging to no forecast brand — central kitchen, ' +
      'bakery, head office, R&D — are bucketed and added once, after the brands are merged.',
    tunable: 'The source location (WH_SUPPLY_SOURCE) and the status list (WH_STATUSES).',
  },
  {
    id: 'wh-forecast',
    page: 'Stock Article, Warehouse Insights',
    visual: 'Warehouse — WH forecast',
    label: 'WH forecast (six-month constant)',
    source: LOCAL,
    expression: `rate(month)  = outbound(article, month) / actual sales(brand, month)
constant     = mean of rate over the last 6 whole months
WH forecast  = constant * forecast sales for the window on screen`,
    detail:
      'Two guards decide which months count. A month where the brand had no sales is dropped — ' +
      'no denominator, and one infinity poisons the average. Months before the article’s ' +
      'first ever delivery are skipped, or an article launched in June averages four zeros and ' +
      'comes out at a third of its true rate. Returns nothing under a branch, product or article ' +
      'filter: both halves are brand-level facts, so narrowing one side and not the other would ' +
      'read several times too high.',
    tunable: 'The six-month window, and the two guards.',
  },
  {
    id: 'wh-acc',
    page: 'Stock Article, Warehouse Insights',
    visual: 'Warehouse — WH ACC%',
    label: 'WH ACC% (per article)',
    source: LOCAL,
    expression: '1 - ABS(WH forecast - Outbound) / Outbound',
    detail:
      'Divided by what actually left the warehouse, so the column, its footer and the card all ' +
      'use one formula. Signed and not floored: over-forecast by more than twice what moved and ' +
      'the answer is negative, and how negative is the point — 17 forecast against 5 issued is ' +
      'four times worse than 82 against 40, and flooring both at 0% said they were the same. ' +
      'Blank where there is nothing to divide by: no outbound at all, or no history for the ' +
      'article. Those cannot be measured, which is not the same as measuring badly.',
  },
  {
    id: 'variance',
    page: 'Warehouse Insights',
    visual: 'Warehouse article detail — Variance',
    label: 'Variance',
    source: LOCAL,
    expression: 'WH forecast - Outbound',
    detail: 'Positive is over-forecast, negative is under-forecast. Blank where either side is.',
  },

  /* ----------------------------------------------------- cards ----------- */
  {
    id: 'card-product-mix',
    page: 'Stock Article',
    visual: 'Product mix accuracy card',
    label: 'Product mix accuracy',
    source: LOCAL,
    expression: '1 - ABS(SUM(Actual qty) - SUM(Forecast qty)) / SUM(Actual qty)',
    detail:
      'The totals of the two columns the card sits above, compared — so it can be checked by ' +
      'hand against the totals row, and the ACC% footer computes the identical figure. Non-recipe ' +
      'articles take no part: they have no demand forecast, so they could only enter as a ' +
      'denominator with nothing above it. Until 6 Sep 2026 this compared the recipe requirement ' +
      'against Outbound instead — a warehouse measure under a product-mix name, which is why the ' +
      'card could read 0.0% while the column beside it read 95.8%.',
  },
  {
    id: 'card-warehouse',
    page: 'Stock Article, Warehouse Insights',
    visual: 'Warehouse accuracy card',
    label: 'Warehouse accuracy',
    source: LOCAL,
    expression: 'MAX(0, 1 - ABS(SUM(WH forecast) - SUM(Outbound)) / SUM(Outbound))',
    detail:
      'Totals compared, over the scored articles only — both sums come from that same set, or ' +
      'it would compare a forecast for one population against outbound for another. This is why ' +
      'it differs from the WH ACC% column footer: the card adds the quantities up first, so a ' +
      'large article dominates and opposite errors cancel, while the footer averages the ' +
      'per-article scores, where a tiny article counts as much as a large one. The gap between ' +
      'them is a real finding, not a discrepancy.',
  },

  /* --------------------------------------------------- the rest ---------- */
  {
    id: 'sales-acc',
    page: 'Stock Article',
    visual: 'Sales ACC% column',
    label: 'Sales ACC% (per day)',
    source: COPY,
    expression: 'MAX(0, 1 - ABS(actual sales - forecast sales) / actual sales)',
    detail:
      'One number per trading day, repeated on every row of that day, from the same daily totals ' +
      'the Overview chart draws. Not FORECAST[Actual Sales]: that table holds only Patisserie ' +
      'rows in every model — the same 12,782 rows copied everywhere, populated in PAT alone — so ' +
      'Variation Percentage MTD returns DIVIDE(0,0,0) = 0% for the other eight brands.',
  },
  {
    id: 'supply',
    page: 'Stock Article, Warehouse Insights',
    visual: 'Supply column and slicer',
    label: 'Warehouse / Direct Supply',
    source: COPY,
    expression: 'Warehouse  = the warehouse has issued this article in the last 6 months\nDirect Supply = it has not',
    detail:
      'Direct supply reaches the CPU or the branch without passing through the warehouse, so it ' +
      'has no outbound by definition. That is the answer, not missing data.',
    tunable: 'The six-month lookback.',
  },
  {
    id: 'bands',
    page: 'Stock Article, Warehouse Insights',
    visual: 'Accuracy group charts',
    label: 'Accuracy bands',
    source: LOCAL,
    expression: '0-20% | 20-40% | 40-60% | 60-85% | 85-100%',
    detail:
      'Cut on WH ACC% for the warehouse chart and on ACC% for the product mix chart. Articles ' +
      'that cannot be scored fall in no band rather than in the lowest one.',
    tunable: 'The band boundaries.',
  },
  {
    id: 'low-accuracy',
    page: 'Warehouse Insights',
    visual: 'Low accuracy articles card',
    label: 'Low accuracy threshold',
    source: LOCAL,
    expression: 'WH ACC% < 40%',
    tunable: 'The 40% line.',
  },
]

/** The catalogue, plus the standing caveat the admin screen shows with it. */
export const calculationsPayload = () => ({
  calculations: CALCULATIONS,
  editable: false,
  note:
    'Power BI measures are shown for reference and cannot be edited from here: the REST API this ' +
    'app uses evaluates DAX and returns rows, and has no write side. Changing a measure means ' +
    'editing the semantic model in Power BI Desktop, or the XMLA endpoint on Premium capacity. ' +
    'Entries marked tunable are this app’s own policy and can be changed without touching a model.',
})
