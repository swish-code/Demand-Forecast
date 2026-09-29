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
/*
 * A column read straight out of a model, rather than a measure evaluated in it.
 *
 * Added 16 Sep 2026 for the replenishment planning sheet, which is a table of
 * typed settings - safety stock days, lead time, supplier - not arithmetic.
 * Calling those "measures" would send somebody looking for DAX that does not
 * exist; calling them local would suggest this app decides them, and it does
 * not. They are somebody's decisions, read as written.
 */
const TABLE = 'Read from a Power BI table'

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
    visual: 'Performance card — Accuracy',
    label: 'Accuracy %',
    source: LOCAL,
    expression: 'Product_Accuracy, falling back to [Forecast Accuracy %]',
    detail:
      'The card shows the volume-weighted product accuracy — the SAME number the Products page ' +
      'headline shows, by the same function; see "Overall product accuracy %". Made consistent on ' +
      '26 Sep 2026 on request, because the two pages were showing different figures for the same ' +
      'window and the model measure was the odd one out. `[Forecast Accuracy %]` is still the ' +
      'fallback for a response that carries no product breakdown, so a blank is never shown where ' +
      'the model can answer; when it is used, it is the model measure applied to the totals, which ' +
      'is NOT volume weighted and can differ by a point or two.',
  },
  {
    id: 'summary-today',
    page: 'Overview',
    visual: "Today's forecast card",
    label: 'Today_Forecast_Qty',
    source: PBI,
    expression: '[Total_Forecast_Qty] for TODAY only',
    detail:
      'A single-day evaluation, fetched separately from the window figures and not affected by the ' +
      'date slicer — the card answers "what does today expect" whatever range is selected. Blank, ' +
      'not zero, when the model has no row for today.',
  },
  {
    id: 'summary-tomorrow',
    page: 'Overview',
    visual: "Tomorrow's forecast card",
    label: 'Tomorrow_Forecast_Qty',
    source: PBI,
    expression: '[Total_Forecast_Qty] for TOMORROW only',
    detail:
      'The prep number: what to make tonight for tomorrow. Like the card beside it, it ignores the ' +
      'date slicer and is fetched on its own, so it keeps its meaning on a historical range.',
  },
  {
    id: 'summary-varspark',
    page: 'Overview',
    visual: 'Performance card — daily variance sparkline',
    label: 'Daily variance series',
    source: LOCAL,
    expression: '(Actual qty - Forecast qty) / Forecast qty, per day',
    detail:
      'One point per completed day in the range, so the headline variance can be read as typical or ' +
      'as one bad day. Days with no actual, or no forecast, are dropped rather than plotted at zero ' +
      '— a flat run at zero would read as a perfect forecast instead of a missing day. Divided by ' +
      'FORECAST here, unlike the accuracy figures, because this is a variance against plan.',
  },
  {
    id: 'summary-band',
    page: 'Overview',
    visual: 'Demand tracking — the grey band',
    label: 'Where a normal day lands',
    source: LOCAL,
    expression: `daily error  = |Actual - Forecast| / Actual, per day
band         = 25th to 75th percentile of those errors
trust        = 1 / (1 + error), inverted to read as "share of the plan that sold"`,
    detail:
      'The middle HALF of days, not the middle eight-tenths. Percentiles rather than a standard ' +
      'deviation because daily variance is not symmetric and one closure or one promotion widens an ' +
      'SD exactly when the band matters most. The 10th-to-90th band came out seventeen points wide ' +
      '(87-104 for every 100 prepped), which is too loose to prep against; the quartiles describe ' +
      'the day a section leader is actually likely to get, and the two best and two worst days in a ' +
      'month sit outside it on purpose. Needs a minimum number of completed days or the panel says ' +
      'so instead of drawing a band.',
    tunable: 'The 25/75 percentiles — BAND_LOW and BAND_HIGH in server/insights/context.js.',
  },
  {
    id: 'summary-gap',
    page: 'Overview',
    visual: 'Gap contributors table',
    label: 'Share of the total miss',
    source: LOCAL,
    expression: `gap  = Actual qty - Forecast qty        (per product)
abs  = |gap|
pct  = gap / Forecast qty
cum  = running SUM(abs) / SUM(abs) over all products with a gap`,
    detail:
      'A Pareto: products ranked by the SIZE of their miss regardless of direction, so an ' +
      'over-forecast and an under-forecast of the same size rank equally — both cost money. The ' +
      'cumulative share is computed over EVERY product with a gap, then only the top 8 are shown, ' +
      'so the subtitle "the top 5 explain 64% of the miss" is a share of the real total and not of ' +
      'the eight rows displayed. Products with no forecast are excluded: there is no gap to a plan ' +
      'that does not exist.',
  },
  {
    id: 'summary-rolling',
    page: 'Overview',
    visual: 'Rolling 7-day accuracy chart',
    label: '7-day rolling accuracy',
    source: LOCAL,
    expression: `accuracy(day) = 1 - |SUM(Actual) - SUM(Forecast)| / SUM(Forecast)
                over that day and the 6 completed days before it
drift         = last point - first point, in percentage points`,
    detail:
      'Totals first, then one ratio — not an average of seven daily ratios, which would let a quiet ' +
      'day count as much as a busy one. A single day is too noisy to read a trend from, which is ' +
      'why the window exists. Points need at least 3 completed days in the window, so a range opens ' +
      'a little way in rather than starting on a one-day figure. Divided by FORECAST, which makes ' +
      'this chart NOT directly comparable with the Accuracy card above it — that one divides by the ' +
      'larger of the two and is volume weighted.',
    tunable: 'The 7-day window and the 3-day minimum, in pages/ForecastSummary.jsx.',
  },
  {
    id: 'summary-dow',
    page: 'Overview',
    visual: 'Accuracy by day of week chart',
    label: 'Weekday bias',
    source: LOCAL,
    expression: `bias     = (SUM(Actual) - SUM(Forecast)) / SUM(Forecast)   per weekday
accuracy = 1 - |bias|`,
    detail:
      'The window is bucketed by day of week and each bucket totalled, which is what exposes a ' +
      'standing pattern — "Fridays are always over-forecast" — that the daily line averages away. ' +
      'Monday first. Signed: positive means more sold than was forecast. Only completed days count, ' +
      'and a weekday with no completed day in the range is left out rather than drawn at zero.',
  },
  {
    id: 'summary-products',
    page: 'Overview',
    visual: 'Products by quantity chart',
    label: 'Variance % per product',
    source: LOCAL,
    expression: '(Actual qty - Forecast qty) / Forecast qty',
    detail:
      'The bars are [Total_Actual_Qty] and [Total_Forecast_Qty] straight from the model; only the ' +
      'delta label on each bar is worked out here. Blank where a product has no forecast. Every ' +
      'product is listed, so the panel scrolls rather than truncating.',
  },
  {
    id: 'summary-location-acc',
    page: 'Overview',
    visual: 'By location — Accuracy column',
    label: 'Branch accuracy %',
    source: LOCAL,
    expression: '1 - |Actual qty - Forecast qty| / Actual qty',
    detail:
      'Per branch, from the model’s own actual and forecast. Note this divides by ACTUAL, which is ' +
      'NOT the formula the Accuracy card and the Products page use — those divide by the LARGER of ' +
      'actual and forecast, which bounds the score at 0-100%. This one is unbounded below, so a ' +
      'branch that sold far less than was forecast can show a large negative. The two are ' +
      'deliberately left as they are rather than quietly unified; `forecastAccuracy()` on the ' +
      'server is this same formula, and both numbers appear on this page. Blank when either side is ' +
      'zero: a branch that sold with no forecast at all is unforecast, not 0% accurate.',
  },
  {
    id: 'product-acc',
    page: 'Products',
    visual: 'Accuracy % column, Performance card — Accuracy',
    label: 'Product accuracy %',
    source: LOCAL,
    expression: '1 - ABS(Actual qty - Forecast qty) / MAX(Actual qty, Forecast qty)',
    detail:
      'Per product, then averaged for the card and the column total. Divided by the LARGER ' +
      'of the two rather than by actual, so the gap can never exceed the denominator and the ' +
      'score is bounded 0-100% by construction — dividing by actual sent products with a tiny ' +
      'actual to absurd negatives (1 sold against a forecast of 8 scored -600%). Blank when ' +
      'either side is zero: a product that sold nothing has no accuracy to report, and neither ' +
      'has one nobody forecast. Changed 27 Sep 2026; it is the same shape WH ACC% uses.',
  },
  {
    id: 'product-acc-weighted',
    page: 'Products',
    visual: 'Performance card — Accuracy, Accuracy % column total',
    label: 'Overall product accuracy %',
    source: LOCAL,
    expression: 'SUM(Actual qty x product accuracy) / SUM(Actual qty)',
    detail:
      'Volume weighted, so a product moving 10,000 units counts two thousand times one moving ' +
      '5 — the low-volume rows that score harshly cannot move the headline. Weighted by ACTUAL, ' +
      'never by the forecast: weighting by the forecast would let the thing being judged decide ' +
      'how much it counts. The card and the column total call the same function, so they cannot ' +
      'disagree. It replaced the measure applied to the totals, 1 - |SUM(A) - SUM(F)| / SUM(A).',
  },

  {
    id: 'variance-qty',
    page: 'Overview',
    visual: 'Var. qty column, Performance card foot',
    label: 'Variance_Qty',
    source: LOCAL,
    expression: 'Actual qty - Forecast qty',
    detail:
      'Units, signed: negative means less sold than was forecast. Totalled by summing the column, ' +
      'which is the same as the difference of the two totals — so the total row agrees with the ' +
      'cards above it by construction. Derived beside the KPIs in `deriveKpis()` rather than being ' +
      'a second definition anywhere.',
  },
  {
    id: 'demand-shift',
    page: 'Products',
    visual: 'Demand vs prev column',
    label: 'Demand_Shift_Pct',
    source: LOCAL,
    expression: '(Actual qty this window - Actual qty previous window) / Actual qty previous window',
    detail:
      'The SAME articles over the window immediately before the selected one, fetched as a second ' +
      'query. It is placed beside the variance it explains: a product 28% down on last month with a ' +
      'matching variance is a demand event, not a bad forecast. Note this is the app’s own ' +
      'comparison and NOT the model’s `[Demand Change %]`, which uses a two-weekday baseline.\n\n' +
      'What "the same thing, last month" means follows the grain. Split by branch, it is that ' +
      'branch’s own history — comparing one branch against the chain total would read as a collapse ' +
      'everywhere. Split by DAY the comparison is dropped entirely, because the row is a single ' +
      'Tuesday and the window before it is a month; left in, it read +1,665% on a row that had ' +
      'barely moved. Blank when nothing sold in the previous window: a product that did not exist ' +
      'last month has no demand change, and +100% would be a lie about a new listing.',
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
    expression: '1 - ABS(WH forecast - Outbound) / MAX(WH forecast, Outbound)',
    detail:
      'Divided by the larger of the two, so the column, its footer, the card and the daily trend ' +
      'all use one formula. Symmetric and bounded between 0% and 100% by construction — the gap ' +
      'can never exceed the denominator, so nothing has to be floored and nothing runs off the ' +
      'scale. Equal quantities score 100%, one side twice the other scores 50%, and a real ' +
      'forecast against nothing issued scores 0%. Blank only where there is nothing to compare: ' +
      'no outbound figure at all, or nothing forecast and nothing moved.',
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
    expression: 'AVERAGE over articles of MAX(0, ACC%)  —  same as the column footer',
    detail:
      'The mean of the per-article scores, one entry per article, with each floored at zero. The ' +
      'score divides by what actually moved and so has no lower bound — Pepsi Cola Can scores ' +
      '-1,008,417% since that line stopped shipping in July, and twelve like it out of 1,085 ' +
      'pulled the mean to -1087%. Zero is what "completely wrong" is worth to an average; below ' +
      'it the number grades the size of the denominator rather than the forecast. The column ' +
      'itself keeps the true signed value, and the band chart shows the distribution.',
  },
  {
    id: 'card-warehouse',
    page: 'Stock Article, Warehouse Insights',
    visual: 'Warehouse accuracy card',
    label: 'Warehouse accuracy',
    source: LOCAL,
    expression: 'AVERAGE over articles of MAX(0, WH ACC%)  —  same as the column footer',
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
      'has no outbound by definition. That is the answer, not missing data. Selecting Warehouse ' +
      'on its own also narrows to production type RAW: a warehouse issues the chicken, not the ' +
      '"Brined Chicken Breast" a kitchen makes from it, so a prep or produced item carrying a ' +
      'Warehouse label is an article-number coincidence rather than something it ships. ' +
      'Selecting Direct Supply, or both, leaves production type alone.',
    tunable: 'The six-month lookback, and whether Warehouse implies RAW.',
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

  /* ------------------------------- Replenishment Planning ---------------- *
   *
   * The table below Article Detail. Every formula here was specified against a
   * working spreadsheet and checked against its own printed figures before the
   * table was built, so these are that sheet's definitions rather than a
   * reinterpretation of it. Two deliberate departures from it are marked where
   * they occur: the day count, and the second delivery date.
   *
   * Nothing in this block feeds the warehouse forecast or Store SOH. It reads
   * them; it never changes them.
   */
  {
    id: 'plan-grain',
    page: 'Stock Article',
    visual: 'Replenishment Planning — one row per article',
    label: 'How rows are folded',
    source: LOCAL,
    expression: `group the Article Detail rows by Item No., then per article:
  WH Forecast, Outbound          = summed across its rows
  SOH, Pending, SS, Lead, Freq   = taken once, never summed
  ACC%                           = re-scored on the folded totals`,
    detail:
      'Article Detail is one row per recipe line, so an article appears once per recipe group and ' +
      'again for the catch-all row its warehouse figures arrive on. A purchase order is placed ' +
      'once for the article, not once per recipe. Quantities are summed, which also sums an ' +
      'article shared by several brands — one warehouse buys it once, so that is the right ' +
      'total. The per-article settings are stamped identically on every one of those rows by the ' +
      'server, so adding them would report an article in three brands as holding three times the ' +
      'stock.',
  },
  {
    id: 'plan-sheet',
    page: 'Stock Article',
    visual: 'Replenishment Planning — Supplier name, Purchase Unit, Base Unit, SS days, Lead time, Delivery freq',
    label: 'The planning sheet lookups',
    source: TABLE,
    expression: `SUMMARIZECOLUMNS(
  'Replan Planning'[Code],
  'Replan Planning'[SS],
  'Replan Planning'[LEAD TIME],
  'Replan Planning'[DeliveryFreq],
  'Replan Planning'[last Supplier Name],
  'Replan Planning'[PURCH UNIT],
  'Replan Planning'[BASE UNIT],
  'Replan Planning'[CURRENT STOCK WAC]
)

matched on  [Code] = Item No.`,
    detail:
      'One query against the FM Sales model, cached, and one row per article — 2,246 rows, 2,224 ' +
      'distinct codes each appearing exactly once, plus 22 rows carrying no code which are ' +
      'dropped. 2,154 match the article master. No mapping table and no fuzzy matching: the ' +
      'values are trimmed and an empty string becomes a dash. [CURRENT STOCK WAC] is read on the ' +
      'same query and stamped as Avg_Cost, though no column shows it since 17 Sep 2026: it is ' +
      "[CURRENT STOCK WAC], the weighted average cost of ONE BASE UNIT at ARTICLE level - not a " +
      'menu-item or recipe cost, and it cannot be one: this sheet has no menu-item dimension. It ' +
      'was asked for from the recipe table, which has no cost column at all, and none of ' +
      'PRODUCTS, PRODUCTS (2) or ITEM TABLE key on an article (zero of 9,803 SKUs match). Per ' +
      'base unit rather than per pack, verified: where it differs from [Last PP] the ratio is ' +
      'the pack size exactly, and on the 814 articles bought in their base unit the two agree. ' +
      'SS is DAYS, not a quantity, ' +
      'despite its name — it holds eight distinct values of which "OnDemand" (608 rows) and ' +
      '"NoNeed" (447) are words rather than numbers. Delivery freq is a count of deliveries and ' +
      'the source does not say over what period, so no unit is shown.',
  },
  {
    id: 'plan-perday',
    page: 'Stock Article',
    visual: 'Replenishment Planning — Per day qty',
    label: 'Per day qty',
    source: LOCAL,
    expression: 'Per day qty = WH Forecast / days in the selected range',
    detail:
      'Days are counted INCLUSIVELY: 15 Sep to 5 Nov is 52 days, not 51. That is one of the two ' +
      'departures from the source spreadsheet, which counted end minus start; inclusive matches ' +
      'every other window calculation in this dashboard. Blank rather than zero when the forecast ' +
      'is zero or missing, because this is the divisor for almost everything to its right and a ' +
      'zero divisor is what would put Infinity on the screen. Note this column does double duty: ' +
      'widening the range lowers the daily rate, so the same stock appears to last longer.',
  },
  {
    id: 'plan-ssqty',
    page: 'Stock Article',
    visual: 'Replenishment Planning — SS Qty',
    label: 'Safety stock quantity',
    source: LOCAL,
    expression: 'SS Qty = SS days * Per day qty',
    detail:
      'Derived from the FORECAST rather than from Outbound, deliberately: outbound is the thing ' +
      'being judged elsewhere on the page, and sizing a buffer from it would shrink the buffer ' +
      'every time the warehouse had a bad month. "NoNeed" is zero days, so zero units — answered ' +
      'without needing a forecast at all. "OnDemand" is blank, not zero: there is no standing ' +
      'cover to size, and zero would read as "no buffer needed", which is a different statement.',
  },
  {
    id: 'plan-soh',
    page: 'Stock Article',
    visual: 'Replenishment Planning — SOH',
    label: 'Warehouse SOH (current)',
    source: TABLE,
    expression: `VAR AsOf = MAXX(ALL(cc_daily_inventory), cc_daily_inventory[Movement Date])
RETURN
SUMMARIZECOLUMNS(
  cc_daily_inventory[Article No.],
  FILTER(ALL(cc_daily_inventory[Movement Date]), cc_daily_inventory[Movement Date] = AsOf),
  FILTER(ALL(cc_daily_inventory[Location]), cc_daily_inventory[Location] IN {<warehouse locations>}),
  "SOH", SUM(cc_daily_inventory[Closing Stock Qty]),
  "AsOf", AsOf
)`,
    detail:
      'The warehouse balance as the feed last knew it, NOT the selected window’s closing balance. ' +
      'DTL asks when stock runs out from where it stands today: a window that has not finished ' +
      'has no closing balance, and a window in the past has one that has since been overtaken. ' +
      'The as-of date is shown in the panel heading rather than implied. Note it is a CURRENT ' +
      'balance, and the dates beside it are counted from today for that reason. Warehouse ' +
      'locations only ' +
      '— this is never Store SOH, which is the shops’ stock and cannot be issued by the ' +
      'warehouse. A dash means the feed has never seen the article there, which is not zero.',
  },
  {
    id: 'plan-pending',
    page: 'Stock Article',
    visual: 'Replenishment Planning — Pending Qty; Article Detail — Pending PO',
    label: 'Pending PO quantity',
    source: PBI,
    expression: `SUMMARIZECOLUMNS(
  'CC Item Location'[Article No.],
  FILTER(ALL('CC Item Location'[Location]),
         'CC Item Location'[Location] IN {<warehouse locations>}),
  FILTER(ALL('CC Date'[Movement Date]),
         'CC Date'[Movement Date] <= <end of selected range>),
  "Qty",   [CC Open PO Qty],
  "Value", [CC Open PO Pending Value]
)`,
    detail:
      'The Inventory Control model’s own measures, so this column and that dashboard cannot ' +
      'disagree. They net receipts through fact_po_period_lifecycle where Inbound Match Status is ' +
      '"Matched", MAXX of PO Base Qty against SUMX of Allocated GRN Base Qty per PO, each floored ' +
      'at zero. Switched to them on 17 Sep 2026, replacing a hand-rolled join of CC Open PO Core ' +
      'to CC PO Receipt Core: the two agreed on 399 of 411 articles to the unit, and the model’s ' +
      'own allocation is the one the business reconciles to. Grouped on CC Item Location[Article ' +
      'No.] because that is where the measures read their filter context - grouped anywhere else ' +
      'they answer with the company-wide total on every row. It now MOVES WITH THE DATE RANGE: ' +
      "[CC End Date] is MAXX(ALLSELECTED('CC Date'[Movement Date])), so the window is filtered " +
      "onto 'CC Date' - filtering cc_daily_inventory does nothing, because CC Date is a " +
      'calculated DISTINCT table. POs raised on or before the end of the range count, and a ' +
      'range ending past the inventory feed clamps to the feed’s last day.',
  },
  {
    id: 'plan-dtl',
    page: 'Stock Article',
    visual: 'Replenishment Planning — DTL',
    label: 'DTL (days to last)',
    source: LOCAL,
    expression: 'DTL = MAX(0, Warehouse SOH + Pending Qty) / Per day qty',
    detail:
      'How long the WAREHOUSE can keep issuing, counting what is already bought. Store SOH is ' +
      'deliberately excluded: stock sitting in the shops is not available for the warehouse to ' +
      'issue, and including it would overstate cover by exactly the amount already distributed. ' +
      'Negative stock is a posting fault, not negative cover, so it is floored at zero. Shown as ' +
      'a whole number; the underlying value keeps its precision, so figures derived from it do ' +
      'not shift.',
  },
  {
    id: 'plan-cover',
    page: 'Stock Article',
    visual: 'Replenishment Planning — Forecasted OOS Date, Target Cover',
    label: 'Forecasted OOS Date, and Target Cover',
    source: LOCAL,
    expression: `stock-out date = TODAY + DTL
Target Cover   = (last selected date - stock-out date) + SS days`,
    detail:
      'The days of cover still to be bought: the gap between running out and the end of the plan, ' +
      'plus the buffer that has to survive it. Legitimately NEGATIVE when stock already outlasts ' +
      'the selected range, and shown that way — it is the reader’s signal that nothing needs ' +
      'ordering. Only the quantity below is floored at zero. Blank on "OnDemand", which has no ' +
      'day count to add.',
  },
  {
    id: 'plan-reqqty',
    page: 'Stock Article',
    visual: 'Replenishment Planning — Req Qty',
    label: 'Requested quantity',
    source: LOCAL,
    expression: 'Req Qty = MAX(0, Target Cover * Per day qty)',
    detail: 'Floored at zero: a negative cover means nothing needs ordering, not a negative order.',
  },
  {
    id: 'plan-reqdate',
    page: 'Stock Article',
    visual: 'Replenishment Planning — Req Date',
    label: 'Requested date',
    source: LOCAL,
    expression: `Req Date = (TODAY + DTL) - Lead Time - SS days`,
    detail:
      'The latest day the order can be placed. Counted BACKWARDS from the day stock runs out, ' +
      'allowing for the lead time and the buffer. Anchored on TODAY, the system date — the ' +
      'stock it divides is a current balance, so the clock has to start where the stock was ' +
      'counted. It therefore lands in ' +
      'the past whenever Lead Time + SS days exceeds DTL, and that is the finding rather than an ' +
      'error: the order is already late. Those rows are marked red with a warning. Worked example: ' +
      '7.4 days of stock against a 30-day lead time and a 15-day buffer needs 45 days of notice, ' +
      'so the order was due about 38 days ago. Blank without a lead time or a day count.',
  },
  {
    id: 'plan-d1',
    page: 'Stock Article',
    visual: 'Replenishment Planning — 1st delivery by, 1st delivery qty',
    label: 'First delivery',
    source: LOCAL,
    expression: `1st delivery by  = first selected date + (DTL - SS days)
1st delivery qty = Req Qty / Delivery Freq`,
    detail:
      'The ONLY date in this table counted from the first day of the selected range rather than ' +
      'from today — changed 16 Sep 2026 to reproduce the source spreadsheet, which anchors this ' +
      'one cell on the slicer start and its other three on TODAY(). One consequence: the gap ' +
      'between Forecasted OOS Date and this column is no longer exactly the safety stock, but ' +
      'SS + (today - first selected day). ' +
      'A DEADLINE, not a plan — which is why the header says "by". It is the day stock falls TO ' +
      'the safety buffer rather than to nothing, so it is the last date the first delivery can ' +
      'land without eating into the buffer. Negative offsets are common and mean the deadline has ' +
      'passed; the date is shown with the day offset in its tooltip. Blank quantity when Delivery ' +
      'Freq is zero, missing, "NoNeed" or "OnDemand" — none of those is a number to divide by.',
  },
  {
    id: 'plan-d2',
    page: 'Stock Article',
    visual: 'Replenishment Planning — 2nd delivery by, 2nd delivery qty',
    label: 'Second delivery',
    source: LOCAL,
    expression: `2nd delivery qty = Req Qty - 1st delivery qty
2nd delivery by  = TODAY + ((1st delivery qty / Per day qty) + DTL - SS days)
                   shown only while 2nd delivery qty > 0`,
    detail:
      'The first deadline pushed out by however long the first delivery lasts at the daily rate. ' +
      'The "only while the quantity is positive" guard is the second departure from the source ' +
      'spreadsheet, added 16 Sep 2026: on a Delivery Freq of 1 — the commonest setting, 928 rows ' +
      'of the sheet — the whole request arrives once, the remainder is nought, and the sheet still ' +
      'printed an offset for it. A stray number in a spare cell is harmless; a date under a column ' +
      'headed "2nd delivery by" reads as a commitment. The quantity is left exactly as specified ' +
      'and still reads 0, because that is a true remainder.',
  },
  {
    id: 'plan-buffered',
    page: 'Stock Article',
    visual: 'Replenishment Planning — Total SOH, New WH Forecast, New ACC%',
    label: 'Buffered view',
    source: LOCAL,
    expression: `Total SOH       = Warehouse SOH + Pending Qty + Outbound
New WH Forecast = WH Forecast + SS Qty
New ACC%        = Total SOH / New WH Forecast`,
    detail:
      'Everything the warehouse has had available across the range, against the requirement with ' +
      'the buffer added. New ACC% is a COVERAGE RATIO, not an accuracy score: it can exceed 100%, ' +
      'and it is not comparable with the ACC% or WH ACC% columns, which is why it sits in its own ' +
      'column group. New WH Forecast is a test figure — the live warehouse forecast is unchanged ' +
      'by it and by everything else in this table.',
  },

  /* ------------------------------------- Shared explanatory panels ------- */
  {
    id: 'why-gap',
    page: 'Shared',
    visual: 'Why forecast and actual differ',
    label: 'The named cause',
    source: LOCAL,
    expression: `first match wins, in this order:
  insufficient  fewer completed days than the analysis needs
  demand-shift  weekly demand moved >= 5% and the forecast lags it by >= 3%
  weekday       one weekday leans >= 8% and fixing it would save >= 1pp
  lean          |bias| >= 3% AND |bias| > day-to-day noise
  noise         noise >= |bias|  — no consistent lean
  unexplained   none of the above`,
    detail:
      'One sentence, chosen on the server so that a branch and head office read the SAME ' +
      'explanation rather than each forming their own. Ordered by what to do about it: a demand ' +
      'move the forecast has not followed is the biggest single cause when it happens, and it is ' +
      'the one most often mistaken for a bug.\n\n' +
      'The `unexplained` case is the reason the other four are worth believing. When none of the ' +
      'usual causes account for the gap the panel says exactly that and points at the forecast ' +
      'itself — a panel that always finds an outside explanation stops being read.',
    tunable: 'All the thresholds above, in the `explain` section of server/insights/context.js.',
  },
  {
    id: 'why-bias-noise',
    page: 'Shared',
    visual: 'Why forecast and actual differ — the supporting figures',
    label: 'bias, noise, typical, lean',
    source: LOCAL,
    expression: `daily error = (Forecast - Actual) / Actual
bias        = MEAN(daily error)          — signed, the standing offset
typical     = MEAN(|daily error|)        — the size of a normal day's gap
noise       = day-to-day scatter around the bias
lean        = (Forecast - Actual) / Actual, per branch or per weekday`,
    detail:
      'The distinction that decides the diagnosis: BIAS is signed and survives averaging, so it is ' +
      'a fixable offset; NOISE cancels and is not. A brand with a 1% bias and 12% noise has a good ' +
      'forecast having a rough week; one with a 12% bias and 1% noise has a forecast that is ' +
      'quietly wrong every day. Both can show the same gap on any single day, which is why the ' +
      'panel compares them rather than quoting either alone.',
  },
  {
    id: 'nonrecipe',
    page: 'Admin',
    visual: 'Items with no recipe',
    label: 'Non-recipe forecast',
    source: LOCAL,
    expression: `constant   = last month's sales / last month's outbound of the item
next month = next month's sales / constant
           = last month's outbound x (next sales / last sales)`,
    detail:
      'A forecast for the things no recipe covers — gloves, cleaning materials, uniforms, till ' +
      'rolls and a long tail of packaging. Nothing derives their requirement from the sales ' +
      'forecast, so the planning sheet reads "Not Exist" against them, yet they still move with ' +
      'trade.\n\n' +
      'The relationship is MEASURED rather than derived: one constant per item per brand, being how ' +
      'many units of sale went with one unit of the item last month. Reported as sales per unit ' +
      'because that is the readable direction — a constant of 4,000 says one glove box per four ' +
      'thousand items sold. Nothing is invented; it is last month’s real usage moved in proportion ' +
      'to expected sales. Kept on the Admin page rather than the report pages because it is a ' +
      'method under review, not a settled figure to order from.',
  },
  {
    id: 'article-usage',
    page: 'Shared',
    visual: 'Article usage popup (click an article name)',
    label: 'Which menu items use an article',
    source: PBI,
    expression: `per product naming the article in 'RECIPE TABLE':
  rate  = quantity of the article per one unit of that product
  usage = product forecast units x rate`,
    detail:
      'Answers the question the table itself cannot: the table says you need 296,470 shawarma ' +
      'breads, and this says which products that requirement comes from and at what rate. The ' +
      'quantities come from the SAME `RECIPE TABLE` rows the component forecast is exploded from, ' +
      'so this is the arithmetic BEHIND Forecast qty rather than a second opinion about the recipe ' +
      '— the usage figures sum to the article’s forecast.\n\n' +
      'Rates are per single unit and are often very small. Non-admins see the product names and the ' +
      'rate; the full column set is admin-only.',
  },
  {
    id: 'model-review',
    page: 'Admin',
    visual: 'Model review findings',
    label: 'How the forecast is built, brand by brand',
    source: LOCAL,
    expression: 'each finding is checked against the LIVE model, not asserted from reading the DAX',
    detail:
      'A review of the WAY the forecast predicts, as distinct from what it predicted — problems in ' +
      'the measures and in the shape of the data that reading the numbers will never reveal. Every ' +
      'finding carries its evidence and the change that would fix it, because a review that only ' +
      'lists problems is a complaint.\n\n' +
      'Findings are verified against the live model rather than asserted from the DAX, so a formula ' +
      'that looks wrong but never meets the data that would make it wrong is not reported as a ' +
      'fault.',
  },

  /* ------------------------- Stock Article / Production — stock ---------- */
  {
    id: 'store-soh',
    page: 'Stock Article',
    visual: 'Store SOH column',
    label: 'Store_SOH',
    source: PBI,
    expression: `SUM(cc_daily_inventory[Closing Stock Qty])
  WHERE Movement Date = the LAST day of the selected range
    AND Location IN the shops of the selected brands`,
    detail:
      'The shops’ stock — never the warehouse’s. ONE day’s reading, the last day of the range, not ' +
      'a sum over it: stock is a level, and adding daily closing balances would count the same ' +
      'units once per day. A range whose last day has not happened yet therefore has NO reading at ' +
      'all, and the column is blank rather than zero.\n\n' +
      'Locations are resolved through the same brand mapping the rest of the app uses (227 mapped), ' +
      'so a brand filter narrows the shops counted. Blank where the inventory model has never held ' +
      'the article: that is a different fact from holding none of it, and the cell says nothing ' +
      'rather than claiming zero.\n\n' +
      'It is stamped on ONE row per article — the article is spread over one row per recipe group, ' +
      'and a per-article level repeated on each would be counted once per recipe by any total. That ' +
      'anchor row is the one carrying the warehouse figures where the article has them, and ' +
      'otherwise the first row for the article; the fallback was added on 29 Sep 2026 after prepared ' +
      'articles on the Production page read blank because they have no warehouse figure to hang on.',
  },
  {
    id: 'store-negative',
    page: 'Stock Article',
    visual: 'Store SOH column — negative balances',
    label: 'How a negative balance is treated',
    source: LOCAL,
    expression: 'onHand = MAX(0, Store SOH)   wherever stock is USED in a calculation',
    detail:
      'The negative is SHOWN as it stands, and treated as empty everywhere it is used. The ERP lets ' +
      'a shop record consumption against stock it has already run out of — a delivery booked late, ' +
      'a transfer never posted, a count not yet done — so the book balance goes below zero and stays ' +
      'there until somebody counts. Measured across the shops: 2.0% of articles on 30 Jun, 0.6% on ' +
      '31 Jul, 5.9% on 31 Aug, together -133,701 units, the largest being CPUSH Sunflower Oil at ' +
      '-73,950.\n\n' +
      'Treated as empty rather than as a debt to be made up: subtracting a negative from a target ' +
      'ADDS it to the requirement, which told the page to ship 66,941 units of an article needing ' +
      '15,341 — four times too much, to refill a hole that exists only in the books.',
  },
  {
    id: 'store-cover',
    page: 'Stock Article',
    visual: 'Stock cover column, SOH status column',
    label: 'Stock_Cover, SOH_Status',
    source: LOCAL,
    expression: `monthly = WH forecast x 30.44 / days in the selected range
cover   = Store SOH / monthly          (months of cover)
status  = 'No store stock'          when SOH <= 0
          'Low stock'               when cover < the low band
          'Normal'
          'Store already stocked'   at or above the stocked band`,
    detail:
      'Months of shop cover at the current requirement. Blank when there is no demand to divide by: ' +
      'dividing by a forecast of zero is infinity, and an article with stock and no forecast is not ' +
      'infinitely well covered — it is an article nobody has asked for. Also blank on a negative ' +
      'balance, because "-4.20 months of cover" is not a length of time. The requirement is ' +
      'annualised to a month from whatever range is selected, so the figure is comparable across ' +
      'windows of different lengths.',
    tunable: 'SOH_BANDS and TARGET_COVER_MONTHS, in server/insights/storeStock.js.',
  },
  {
    id: 'store-dtl',
    page: 'Stock Article',
    visual: 'Store DTL column',
    label: 'Store_DTL',
    source: LOCAL,
    expression: `Combined Purchase = SUM(Purchase Qty) + SUM(Transfer In Qty)
                    over the range, this article, these shops
Average Purchase  = Combined Purchase / calendar days in the range
Store DTL         = Store SOH / Average Purchase`,
    detail:
      'How many days of intake the shelf is currently worth. It DIVIDES the Store SOH figure above ' +
      'and does not recompute it. Every blank is a different refusal: no purchase feed means the ' +
      'query failed or the model is off, so unknown rather than zero; an average of zero means ' +
      'nobody ordered it, which is no answer rather than infinite cover (826 of 2,991 articles over ' +
      'a 90-day window); and a negative SOH gives a negative number of days, which is not a length ' +
      'of time. A Store SOH of exactly zero against real intake is NOT blank — nothing on the shelf ' +
      'is a true and useful answer, and it reads 0.',
  },
  {
    id: 'wh-soh',
    page: 'Stock Article',
    visual: 'WH opening SOH, WH closing SOH columns',
    label: 'WH_Opening_SOH, WH_Closing_SOH',
    source: PBI,
    expression: `opening = SUM(cc_daily_inventory[Closing Stock Qty]) the day BEFORE the range
closing = SUM(cc_daily_inventory[Closing Stock Qty]) the LAST day of the range
          over WAREHOUSE locations only`,
    detail:
      'The warehouse’s own shelf, which is what decides whether it could ship at all — distinct ' +
      'from Store SOH above in both the locations counted and the question asked. Opening is read ' +
      'the day BEFORE the range starts, so it is the stock the range began with rather than its ' +
      'first day’s close. Blank means the inventory model has never held the article, not that it ' +
      'holds none: a range whose last day is in the future has no closing reading.',
  },

  /* ------------------- Production pages — site outbound & source -------- */
  {
    id: 'site-outbound',
    page: 'Production',
    visual: 'Outbound column on Production, Bakery, CK, YELO Factory, Unclassified',
    label: 'Site_Outbound_Qty',
    source: PBI,
    expression: `SUM(fact_outbound_line[Action Base Qty])
  WHERE Cost Center/Store IN ('Central Production Unit', 'Centeral Kitchen',
                              'Swish Bakery', 'Yelo Factory')
    AND Mapped Transfer To = the selected brand
    AND Request Created DateTime within the selected range
    AND Status Group IN the configured statuses`,
    detail:
      'What a PRODUCTION SITE issued, which is not what the warehouse Outbound column measures. The ' +
      'warehouse column filters `Mapped Cost Center/Store = "Central Warehouse"`: the right question ' +
      'for a bought article and the wrong one for a prepared one, because a prepared article is made ' +
      'at a kitchen and issued from there, so the warehouse has no line for it and never will. Added ' +
      '29 Sep 2026 after the warehouse column was put on these pages and read blank on almost every ' +
      'row.\n\n' +
      'Same fact table, same measure, ONE filter changed — the sites replace the warehouse as the ' +
      'source. The destination filter is unchanged, so a figure still belongs to the brand whose ' +
      'shops received it. Both "Central Production Unit" and "Centeral Kitchen" (the source’s own ' +
      'spelling) count: the audit on 28 Sep found them to be one cost centre renamed in early 2026, ' +
      'and either way both are genuinely production. Deliberately NOT included: `FM- CPU` belongs to ' +
      'a separate company, `ERMG CK` to a dormant entity, and `Staff Meal` is a canteen.\n\n' +
      'Blank, not zero, where nothing is available to measure — a zero against an article nothing ' +
      'can measure reads as a forecast that missed completely. Note it is stamped on EVERY recipe ' +
      'line of an article, so a totals row over an article spread across several recipe groups ' +
      'counts it once per group; a known defect as of 29 Sep 2026.',
  },
  {
    id: 'site-acc',
    page: 'Production',
    visual: 'Actual ACC% column',
    label: 'Site_Acc',
    source: LOCAL,
    expression: 'Actual ACC% = Site outbound / Forecast qty',
    detail:
      'A COVERAGE RATIO, not an accuracy score: it is unbounded above and 133% means the kitchens ' +
      'issued a third more than the recipe explosion asked for. Corrected to this direction on ' +
      '29 Sep 2026 — it was briefly forecast/outbound — and renamed from "Site ACC%" at the same ' +
      'time. Blank unless the forecast is above zero and an outbound figure exists on the same row; ' +
      'a ratio needs both sides, and dividing by a forecast of zero is infinity.',
  },
  {
    id: 'prod-source',
    page: 'Production',
    visual: 'Prod. source column, the Bakery / CK / Factory / Unclassified pages',
    label: 'Prod_Source',
    source: LOCAL,
    expression: `the site that has issued this article, from outbound history:
  Central Kitchen / CPU, Bakery, YELO Factory, or Unclassified`,
    detail:
      'Classified from what each site has ACTUALLY ISSUED over the last months rather than from a ' +
      'hand-kept list — the first version of this column was typed in by hand. An article no site ' +
      'has issued falls to Unclassified, which is why that page exists: those articles have no ' +
      'agreed route yet and are held separately rather than being assigned a site on a guess. Live ' +
      'classification on 29 Sep 2026 over 1 Mar-31 Aug: Central Kitchen / CPU 954, Bakery 107, ' +
      'YELO Factory 9.\n\n' +
      'Two things about it are still open and worth knowing before acting on it: the CK/CPU split is ' +
      'unconfirmed by the business, and Swish Bakery is matched through the existing ' +
      '`Mapped Cost Center/Store` field as agreed on 28 Sep.',
  },
  {
    id: 'prod-type',
    page: 'Stock Article',
    visual: 'Prod. type column',
    label: 'Node type — RAW, PREP, PA',
    source: PBI,
    expression: "Read from 'RECIPE TABLE', per article",
    detail:
      'RAW is bought from a supplier, PREP is a kitchen step, PA is a prepared article the ERP ' +
      'stocks. It is what separates the two pages: Stock Article is locked to RAW — what somebody ' +
      'BUYS — and Production to PREP and PA, what the kitchens MAKE.\n\n' +
      'Read from the FULL `RECIPE TABLE`, not from the local component copy. The first version read ' +
      'the copy and left direct-supply articles blank, because the copy holds only articles a ' +
      'forecast recipe explodes to — so an article nobody has a recipe for had no row to read a type ' +
      'from, which is precisely the direct-supply case.',
  },
  {
    id: 'article-counts',
    page: 'Stock Article',
    visual: 'Articles card, Largest requirement card',
    label: 'Articles, Largest requirement',
    source: LOCAL,
    expression: `Articles            = DISTINCT articles after all filters
Largest requirement = MAX(Forecast qty) across those articles`,
    detail:
      'DISTINCT articles rather than rows, for the same reason as on Warehouse Insights: an article ' +
      'appears once per recipe group, so a row count overstates it. "Largest requirement" is a ' +
      'single article’s figure, not a total — it answers "what is the biggest single thing on this ' +
      'list".',
  },
  {
    id: 'top-by-unit',
    page: 'Stock Article',
    visual: 'Top components by unit',
    label: 'Top articles within each unit of measure',
    source: LOCAL,
    expression: 'the largest Forecast qty values, grouped by the article’s base unit',
    detail:
      'Split by UNIT because that is the only way these quantities can honestly be ranked: 400 kg ' +
      'and 400 pieces are not comparable, and a single list sorted by quantity would put whichever ' +
      'unit happens to be counted in small increments at the top. Each facet is a league table ' +
      'within one unit.',
  },

  /* ------------------------------------------------ Admin ---------------- */
  /*
   * The only page whose figures come from this app's OWN database rather than
   * from Power BI - so it is the only place a figure can be changed by somebody
   * using the app rather than by a data refresh.
   */
  {
    id: 'admin-users',
    page: 'Admin',
    visual: 'Total users, Active, Seen in 30 days, Pending or blocked',
    label: 'User counts',
    source: LOCAL,
    expression: `total            = COUNT(users)
active           = COUNT WHERE status = 'active'
seen_recently    = COUNT WHERE last_login_at >= now() - 30 days
pending_or_blocked = COUNT WHERE status IN ('pending','suspended','disabled')`,
    detail:
      'From the app’s own `users` table, not from Power BI. "Seen in 30 days" counts people whose ' +
      'LAST sign-in falls in the window, so it is a headcount and not a visit count. Active and ' +
      '"pending or blocked" are complementary and sum to the total; "seen in 30 days" overlaps both ' +
      'and is not part of that sum. Dates are compared as text in `YYYY-MM-DD HH24:MI:SS`, where ' +
      'lexical and chronological order agree — which is the whole reason that format was chosen.',
  },
  {
    id: 'admin-signins',
    page: 'Admin',
    visual: 'Sign-in activity chart, Recent sign-in attempts',
    label: 'Daily sign-ins',
    source: LOCAL,
    expression: `users    = COUNT(DISTINCT user_id) per day WHERE success = 1
logins   = COUNT(*) per day        WHERE success = 1
failures = COUNT(*) per day        WHERE success = 0`,
    detail:
      'The chart plots DISTINCT PEOPLE per day, not raw events — one person signing in six times is ' +
      'one user, not six. `logins` and `failures` are raw event counts and are carried alongside, ' +
      'so a day with few users and many failures is visible as what it is. Grouped on the first ten ' +
      'characters of the timestamp, so a "day" is UTC as stored.',
  },
  {
    id: 'admin-usage',
    page: 'Admin',
    visual: 'Where the app is used',
    label: 'Usage per brand and per store',
    source: LOCAL,
    expression: `users  = COUNT(DISTINCT user_id) over DISTINCT (user, brand) grants
logins = COUNT(login events in the window) for those users`,
    detail:
      'Resolved through each user’s GRANTS rather than through anything they did — it answers "who ' +
      'has this brand" and "how active are they", not "which brand did they look at". The DISTINCT ' +
      'subquery matters: a store user granted two locations of one brand has two scope rows, and ' +
      'joining sign-in events straight onto those would count every sign-in twice. A user granted ' +
      'several brands counts once under each, so the columns do not sum to the user total.',
  },

  /* ------------------------------------- Warehouse Insights -------------- */
  {
    id: 'wh-article-counts',
    page: 'Warehouse Insights',
    visual: 'Articles card, Articles with outbound card',
    label: 'Article counts',
    source: LOCAL,
    expression: `Articles             = DISTINCT articles on the page
Articles with outbound = DISTINCT articles where outbound is not blank`,
    detail:
      'DISTINCT articles, not rows — corrected 16 Sep 2026. An article appears once per recipe ' +
      'group, so counting rows overstated it and the figure moved when a slicer changed without the ' +
      'population changing. The gap between the two cards is the useful part: it is how much of the ' +
      'catalogue there is no outbound evidence for at all, and every accuracy figure on the page is ' +
      'measured over the second number, not the first.',
  },
  {
    id: 'wh-runrate',
    page: 'Warehouse Insights',
    visual: 'Sales run rate — This month so far, On course for',
    label: 'Run rate',
    source: COPY,
    expression: `soFar    = SUM(cube_sales_daily.value) WHERE date <= last actual day
runRate  = (soFar / days elapsed) x days in month
projected= what the models themselves expect for the whole month`,
    detail:
      '`cube_sales_daily` holds ONE series that is actual for past dates and forecast for future ' +
      'ones, so the two are told apart by the DATE against the last-actual boundary, never by a ' +
      'column. The boundary is the earliest last-actual date across brands, so no brand is ever ' +
      'read as actual past where its data stops.\n\n' +
      'The run rate is shown only for a month still in progress — quoting it for a finished month ' +
      'would restate the total while implying it was a projection. `runRate` is this app’s own ' +
      'straight-line pace and `projected` is the models’ own expectation; they sit side by side ' +
      'deliberately and are not the same figure.\n\n' +
      'The month is read to its END even when the date slicer stops mid-month. Cutting it at the ' +
      'slicer truncated "still expected" to a few days while the run rate projected the whole ' +
      'month — 828,505 against 2,899,603 on the first run, which read as the month collapsing ' +
      'rather than as two figures measuring different spans.',
  },
  {
    id: 'wh-pace',
    page: 'Warehouse Insights',
    visual: 'Sales run rate — Last full month, Against the same point last month',
    label: 'pace, versusLastMonth',
    source: COPY,
    expression: `samePoint       = SUM(value) for the previous month, days 1..N only
                  where N = days elapsed this month
pace            = soFar / samePoint - 1
versusLastMonth = runRate / previous month total - 1`,
    detail:
      '`pace` is the like-for-like comparison: the same number of days into the previous month. ' +
      'Comparing nine days of this month against ALL of last month reads as a collapse every time, ' +
      'which is the most common way a run-rate figure misleads somebody. `versusLastMonth` is the ' +
      'other honest question — the projected month against last month’s finished total. Both are ' +
      'blank when there is no month in progress or nothing to compare against.',
  },
  {
    id: 'wh-cover',
    page: 'Warehouse Insights',
    visual: 'Stock on hand against what left — Typical stock use',
    label: 'cover',
    source: COPY,
    expression: `per article, per week: ratio = outbound that week / stock held
cover  = MEDIAN(ratio) across articles
trend  = MEDIAN(second half) / MEDIAN(first half) - 1`,
    detail:
      'Of what the warehouse was holding, how much went out. Ten on the shelf and two issued is ' +
      '20% — comfortable. Ten held and twenty issued is 200%: the shelf turned over twice and was ' +
      'refilled mid-week to manage it, which is a warehouse running hot. The line to watch is 100%.\n\n' +
      'A MEDIAN over per-article ratios, never a ratio of totals. Adding every article’s stock ' +
      'together would sum kilograms to pieces to litres and call the result a quantity, and the ' +
      'ratio of two meaningless totals is not more meaningful; a median over per-article ratios is ' +
      'dimensionless and says what the typical article did.\n\n' +
      'The trend compares two HALVES rather than first week against last: the last week of any ' +
      'window is the one most likely to be part-counted, and reading a trend off it would report a ' +
      'fall every time.',
  },
  {
    id: 'wh-short-dry',
    page: 'Warehouse Insights',
    visual: 'Shipped more than held, Shipped with an empty shelf',
    label: 'shortShare, dry',
    source: COPY,
    expression: `short      = articles where outbound > stock held
shortShare = short / articles with both a stock reading and outbound
dry        = articles that shipped while the stock reading was 0`,
    detail:
      'An article with NO stock reading at all is skipped by both counters, not treated as empty: ' +
      'an article the inventory model has never heard of tells us nothing, and counting it as empty ' +
      'would invent a shortage. `dry` is a stockout, or stock that arrived and left inside the same ' +
      'week — the two cannot be told apart from a weekly closing reading.\n\n' +
      'Why this matters rather than being merely interesting: measured on 9 Sep 2026 over roughly ' +
      '47,000 article-weeks, weeks where the warehouse held under a quarter of a week of cover were ' +
      'followed by weeks shipping 0.60x that article’s average, against 1.10x where it held more — ' +
      'and 35.7% of all zero-shipment weeks followed an empty warehouse. A large part of what reads ' +
      'as forecast error is the warehouse being unable to ship what it did not have.',
  },
  {
    id: 'wh-extremes',
    page: 'Warehouse Insights',
    visual: 'Lowest WH accuracy, Most over-forecast, Most under-forecast',
    label: 'The three extreme lists',
    source: LOCAL,
    expression: `Lowest WH accuracy = articles sorted by WH ACC% ascending
Most over-forecast = sorted by (WH forecast - Outbound) descending
Most under-forecast= sorted by (WH forecast - Outbound) ascending`,
    detail:
      'Three different questions, deliberately not one list. Accuracy is a RATIO, so a tiny article ' +
      'off by a handful of units can top the "lowest accuracy" list while costing nothing; the two ' +
      'variance lists are in UNITS and rank by what the miss actually costs. An article can sit high ' +
      'on one and nowhere on the others. All three are over scored articles only.',
  },

  /* ------------------------------------------ Sales plan ----------------- */
  /*
   * The plan chain, in order. Each entry below is one link:
   *
   *   typed target -> seasonal shape -> monthly sales -> units -> products
   *                                                           -> articles
   *
   * The single most important property: a typed target sets the SIZE of the year
   * and never its shape, its mix, or its units-per-dinar. Those come from
   * evidence and do not move when the target does.
   */
  {
    id: 'plan-target',
    page: 'Sales plan',
    visual: 'Brand sales plan — the typed boxes, Target figure',
    label: 'Annual sales target',
    source: TABLE,
    expression: 'cube_sales_plan[value], typed per brand per year',
    detail:
      'Somebody’s decision, stored as written — this app does not derive it or adjust it. It sets ' +
      'how BIG the plan year is and nothing else. Leave a box empty and that brand keeps the ' +
      'existing logic rather than being planned from zero.',
  },
  {
    id: 'plan-shape',
    page: 'Sales plan',
    visual: 'The months table — the percentages',
    label: 'Seasonal shape',
    source: PBI,
    expression: `share(month) = 'Seasonal Effect Branch'[Seasonal Effect] for that month
               / SUM of the brand's twelve factors
fallback     = the plan year's own FORECAST (2)[Totalsale], month by month`,
    detail:
      'WHEN a planned year’s sales happen — twelve weights per brand, normalised to sum to 1. The ' +
      'percentages are the shape itself and do not move when the target does; that separation is ' +
      'the whole point of the panel.\n\n' +
      'The factors are branch-uniform, average almost exactly 1.0, and differ by brand — February ' +
      'is 0.76 for SS, 0.73 for MM, 0.91 for BUR. Until 19 Sep 2026 a plan year was instead shaped ' +
      'by rescaling the BASE year’s own daily sales, which inherited whatever that year did, ' +
      'including things that are not seasonality: BBT January 2026 was -1, so January 2027 came out ' +
      'negative, and CHP January 2026 was 0 against a 10.6M target because CHP opened in March and ' +
      'its history is a launch ramp. Its seasonal factors run 0.87 to 1.16 — perfectly healthy. ' +
      'That contrast is the argument for this table.\n\n' +
      'Where a brand has no usable factor set the Totalsale fallback keeps it plannable rather than ' +
      'refused. A FAILED shape query now returns nothing and stores nothing, rather than being ' +
      'cached as the fallback — fixed after a BBT shape failure stuck as Totalsale.',
  },
  {
    id: 'plan-ratio',
    page: 'Sales plan',
    visual: 'The forecast table — how sales become units',
    label: 'Units-per-sales ratio',
    source: LOCAL,
    expression: `ratio(month)  = product units that month / sales that month   (base year)
brandMedian   = MEDIAN(ratio) over complete base-year months
units(month)  = planned sales for the month x ratio, or x brandMedian
                where the month's own ratio is unusable`,
    detail:
      'Answers "how many units is a dinar". A month’s own ratio is used only when it is within 25% ' +
      'of the brand median — otherwise the median stands in, so one broken month cannot distort the ' +
      'year. Kept deliberately separate from the mix below: that separation is what lets a month ' +
      'with a broken ratio borrow the brand median while still using its own mix, and a month with ' +
      'no mix borrow the year’s while still using its own ratio.',
    tunable: 'THRESHOLD, the 25% validity band, in server/insights/planForecast.js.',
  },
  {
    id: 'plan-mix',
    page: 'Sales plan',
    visual: 'The forecast table — Products level',
    label: 'Product mix',
    source: LOCAL,
    expression: `history(p) = p's share of units in the equivalent base-year month
             (or of the rest of the year, with that month excluded,
              where the month is unusable)
latest(p)  = p's share of units in the last 28 days
w(p)       = 0.25 + 0.50 x (base-year months p appears in / complete months)
mix(p)     = w(p) x history(p) + (1 - w(p)) x latest(p),  re-normalised
forecast   = units(month) x mix(p)`,
    detail:
      'Which products those units are. The history weight SLIDES per product rather than being a ' +
      'flat 75/25: a product present in every complete base-year month keeps the full 0.75, one ' +
      'present in none drops to 0.25, and a product with one month of nine gets about 0.31 — so ' +
      'roughly seven tenths of its weight rests on what is selling now, which is the only evidence ' +
      'there is for it.\n\n' +
      'That sliding weight was added because new products were being badly understated: a flat ' +
      'history weight judged them on months they did not exist in. Nashville Seasoning Powder went ' +
      'from 26.55 to 77.1 and Hot Honey from 28,780 to 66,689 when it went in.\n\n' +
      'The latest-28-days half is what stops a February plan zeroing products that only appeared in ' +
      'June: on 22 Sep 2026 the last 28 days held 95 BBT products February 2026 had never seen, ' +
      'carrying 33.9% of current volume. Where a month is declared unusable its history comes from ' +
      'the rest of the year WITH THAT MONTH REMOVED — a month declared unusable must not come back ' +
      'in through the fallback it triggered. The mix is re-normalised to sum to 1 rather than ' +
      'assumed to, because either half can be empty and a mix that does not sum to one would ' +
      'quietly lose or invent units.',
    tunable:
      'HISTORY_WEIGHT (0.75), HISTORY_WEIGHT_MIN (0.25) and LATEST_DAYS (28), in ' +
      'server/insights/planForecast.js.',
  },
  {
    id: 'plan-articles',
    page: 'Sales plan',
    visual: 'The forecast table — Articles level',
    label: 'Article forecast qty',
    source: LOCAL,
    expression: `for each recipe naming the article:
  qty += product forecast units (by PLU) x recipe rate per unit
summed over every recipe that names it`,
    detail:
      'Derived FROM the product forecast above rather than re-deriving products, so an article and ' +
      'the products it comes from can never disagree — asked for explicitly. Backtested against ' +
      'August 2026: 100.0% volume-weighted agreement, totals within 0.006%.\n\n' +
      'Recipes are scoped to the brand through Recipe Group, because `Product PLU` is not unique ' +
      'across brands — and is an Integer in the BBT model and Text in the others. Without the ' +
      'scoping, 70 articles from other brands leaked in. Prep steps with no article number are kept, ' +
      'keyed by name, so a forecast prep step is not silently dropped.\n\n' +
      'Node types are read from the full `RECIPE TABLE`, not from the forecast-filtered component ' +
      'copy — the copy holds only articles a recipe explodes to, so reading types from it left ' +
      'direct-supply articles blank.',
  },
  {
    id: 'plan-method-note',
    page: 'Sales plan',
    visual: 'What a saved figure does',
    label: 'What a typed figure changes',
    source: LOCAL,
    expression: `changes:      the SIZE of the plan year
does NOT change: the seasonal shape, the product mix, the units-per-sales
                 ratio, or any actual sales`,
    detail:
      'Stated on the page because it is the commonest misreading. A target well above the base ' +
      'year’s sales does not scale article forecasts by the same multiple: the units-per-sales ratio ' +
      'and the mix are evidence from history and are unchanged, so an article can be flat or lower ' +
      'against a much larger target — most often because that article’s products lost mix share, or ' +
      'because the month’s ratio fell back to the brand median.',
  },

  /* ------------------------------------------ Tomorrow's Prep ------------ */
  /*
   * The whole page ignores the date slicer, by design and to match the report:
   * every measure below resolves its own dates off TODAY() inside the model.
   */
  {
    id: 'prep-tomorrow-qty',
    page: "Tomorrow's Prep",
    visual: 'Tomorrow forecast qty card, Production plan table',
    label: 'Tomorrow_Forecast_Qty',
    source: PBI,
    expression: '[Tomorrow Forecast Qty]',
    detail:
      'Resolves its own date off TODAY() as POWER BI sees it — the service’s date, not this ' +
      'browser’s. Overnight the two can be a day apart, and a figure that looks wrong against the ' +
      'report is nearly always that; the banner names the day being planned so the comparison is ' +
      'possible instead of a guess. The date slicer is deliberately NOT applied to this page, which ' +
      'is how the report behaves too. Rows with a forecast of 0 are filtered out — a prep plan lists ' +
      'what to make.',
  },
  {
    id: 'prep-plan-date',
    page: "Tomorrow's Prep",
    visual: 'Planning for… banner',
    label: 'Plan_Date',
    source: PBI,
    expression: 'FORMAT(CALCULATE(MAX(Forecast_Product_Table[Date]), [IsTomorrow] = 1), "yyyy-MM-dd")',
    detail:
      'Read from the model’s own IsTomorrow flag rather than being assumed to be the next day here, ' +
      'so the page and the model can never disagree about which day is being planned.',
  },
  {
    id: 'prep-recent',
    page: "Tomorrow's Prep",
    visual: "Tomorrow's prep vs recent actual chart, Production plan table",
    label: 'Last_Avg_Actual',
    source: PBI,
    expression: '[Last 2 Weekdays Avg Actual]',
    detail:
      'The average of the last TWO matching weekdays — so a Tuesday plan is compared with the two ' +
      'previous Tuesdays, not with yesterday. This is the comparison the prep figure should be read ' +
      'against. Worth knowing its limitation: an average of two days has no protection against an ' +
      'outlier, so one promotion or one closure moves it, and the same two-day baseline is what the ' +
      'model’s AOV and demand flags are built on.',
  },
  {
    id: 'prep-counts',
    page: "Tomorrow's Prep",
    visual: 'Products to prepare / Extra prep / Reduced prep cards',
    label: 'Products_To_Prepare, High_Demand_Products, Low_Demand_Products',
    source: PBI,
    expression: `[Products To Prepare]
[High Demand Products]   -> "Extra prep needed"
[Low Demand Products]    -> "Reduced prep needed"`,
    detail:
      'Counts of PRODUCTS, not units. The high and low counters are built on the model’s ' +
      '[Demand Change %], which compares against the two-weekday baseline above and returns BLANK ' +
      'when that baseline is under 1 — so a product launched this week cannot be flagged as high ' +
      'demand however much it sells. The three do not sum to a total: a product is counted in ' +
      '"to prepare" and may also be in one of the other two.',
  },
  {
    id: 'prep-byproduct',
    page: "Tomorrow's Prep",
    visual: "Tomorrow's prep vs recent actual — top 10 products",
    label: 'Prep vs recent, per product',
    source: LOCAL,
    expression: `Forecast = SUM(Tomorrow_Forecast_Qty)  grouped by product, across branches
Actual   = SUM(Last_Avg_Actual)         grouped by product, across branches
shown    = top 10 by Forecast`,
    detail:
      'The table is per product per branch; this chart folds the branches away to answer "what are ' +
      'we making most of tomorrow". Only the top 10 are drawn, so the bars are readable — the table ' +
      'below carries every row.',
  },
  {
    id: 'prep-lean',
    page: "Tomorrow's Prep",
    visual: 'Weekday lean banner',
    label: 'How this weekday usually runs',
    source: LOCAL,
    expression: 'lean = (Forecast - Actual) / Actual, for the weekday being planned',
    detail:
      'Taken from the same weekday analysis the Overview chart uses, then matched to the weekday of ' +
      'the plan date. Shown only when the lean is at least 5%, and as a warning above 15%. It is ' +
      'read before the plan rather than after the complaint: a branch that knows Wednesdays ' +
      'habitually land under can prepare for it. Needs enough completed days or it is not shown.',
    tunable: 'The 5% and 15% thresholds, in pages/ProductionPlan.jsx.',
  },

  /* ------------------------------------------ Forecast Insights ---------- */
  /*
   * One page, one payload: everything below is computed in
   * server/insights/whDiagnostics.js from the same `rows` array, so no two
   * figures on the page can be built from different populations. Where a
   * threshold decides a count it is named here and marked tunable.
   */
  {
    id: 'wh-diag-accuracy',
    page: 'Forecast Insights',
    visual: 'Forecast accuracy card',
    label: 'Average article accuracy',
    source: LOCAL,
    expression: `per article  = 1 - |Forecast - Outbound| / MAX(Forecast, Outbound)
headline     = AVERAGE( MAX(0, per article) ) over SCORED articles`,
    detail:
      'The average ARTICLE, not the average unit — every article counts once however much it ' +
      'moves, which is what makes this a statement about the method rather than about the big ' +
      'lines. Floored at 0 per article before averaging, exactly as the cards do it, so this page ' +
      'cannot report a different headline from the pages it explains. "Scored" means outbound ' +
      'exists and is above zero; an article the warehouse never issued has no accuracy and is ' +
      'excluded rather than counted as 0%.',
  },
  {
    id: 'wh-diag-articles',
    page: 'Forecast Insights',
    visual: 'Articles looked at card',
    label: 'articles / scored / unscored',
    source: LOCAL,
    expression: `articles = every article with a forecast or an outbound record
scored   = those with outbound > 0
unscored = articles - scored`,
    detail:
      'The split is the point: an article can be forecast and never shipped, or shipped and never ' +
      'forecast, and only the ones with both can be scored at all. Every share on this page is ' +
      'over `scored` unless it says otherwise.',
  },
  {
    id: 'wh-diag-bias',
    page: 'Forecast Insights',
    visual: 'Forecast vs shipped card, Asked for / Shipped bars',
    label: 'biasPct',
    source: LOCAL,
    expression: `totalForecast = SUM(Forecast) over scored articles
totalOutbound = SUM(Outbound) over scored articles
biasPct       = (totalForecast - totalOutbound) / totalOutbound`,
    detail:
      'One ratio over the totals, so it answers "are we ordering too much overall" — a different ' +
      'question from the accuracy card, which asks "is each article right". A page can be badly ' +
      'inaccurate article by article and near-perfect in total, because over- and under-forecasts ' +
      'cancel; that gap between the two cards is deliberate and is most of what this page is for. ' +
      'Signed: positive means more was forecast than shipped. Blank when nothing shipped.',
  },
  {
    id: 'wh-diag-bands',
    page: 'Forecast Insights',
    visual: 'How accurate is each article — accuracy bands',
    label: 'Article counts per accuracy band',
    source: LOCAL,
    expression: 'COUNT(scored articles WHERE accuracy >= lo AND accuracy < hi)',
    detail:
      'Half-open intervals — an article scoring exactly 40% falls in "40-60%", never in both bands ' +
      'or neither, so the bands sum to `scored` exactly. Bands are counts of ARTICLES, not units. ' +
      'Clicking a band filters the article list to it.',
  },
  {
    id: 'wh-diag-direction',
    page: 'Forecast Insights',
    visual: 'Are we ordering too much or too little',
    label: 'Too much / About right / Too little',
    source: LOCAL,
    expression: `errorPct    = (Forecast - Outbound) / Outbound
Too much    = share of scored WHERE errorPct >  +10%
Too little  = share of scored WHERE errorPct <  -10%
About right = 1 - too much - too little`,
    detail:
      'A DIRECTION split, deliberately different from the accuracy bands: accuracy is unsigned, so ' +
      'a 30% over-forecast and a 30% under-forecast land in the same band while being opposite ' +
      'problems with opposite fixes. The ±10% deadband is what "about right" means; it is not an ' +
      'accuracy score and does not correspond to any band above. Divided by OUTBOUND, so it reads ' +
      'as "we ordered 40% more than moved".',
    tunable: 'The ±10% deadband, in server/insights/whDiagnostics.js.',
  },
  {
    id: 'wh-diag-goodshare',
    page: 'Forecast Insights',
    visual: 'What we found — "Most articles are forecast well"',
    label: 'goodShare',
    source: LOCAL,
    expression: 'COUNT(scored WHERE accuracy >= 60%) / COUNT(scored)',
    detail:
      'A share of articles clearing a pass mark, which is a different and more actionable figure ' +
      'than the average: it answers "how much of the catalogue works" rather than "how good is the ' +
      'typical score". 60% is this app’s own pass mark and is not the 85% target — the target is a ' +
      'figure for the average, and the two are not comparable.',
    tunable: 'GOOD, the 60% pass mark, in server/insights/whDiagnostics.js.',
  },
  {
    id: 'wh-diag-lowacc',
    page: 'Forecast Insights',
    visual: 'Articles to look at card',
    label: 'lowAccuracy',
    source: LOCAL,
    expression: 'COUNT(scored articles WHERE accuracy < 40%)',
    detail:
      'A worklist rather than a measure: the articles far enough off to be worth someone’s morning. ' +
      'Counted over scored articles only, so an article nobody shipped never appears here however ' +
      'much was forecast for it — that case is the status ladder’s job.',
    tunable: 'The 40% line, in server/insights/whDiagnostics.js.',
  },
  {
    id: 'wh-diag-cv',
    page: 'Forecast Insights',
    visual: 'Volatility bands, "Accuracy falls when demand jumps about"',
    label: 'cv — how much an article swings',
    source: LOCAL,
    expression: `rate(month) = outbound that month / sales that month
cv          = STDEV(rate) / MEAN(rate)   over the six months`,
    detail:
      'The coefficient of variation of the RATE, not of the raw quantity. That distinction is the ' +
      'whole point: an article whose outbound doubles because the brand sold twice as much is ' +
      'perfectly predictable, and dividing by sales is what separates it from an article that ' +
      'genuinely jumps about. Zero when there are fewer than two months to compare, so a new ' +
      'article reads as steady rather than as wildly unstable — worth knowing when reading the ' +
      '"steady articles only" ceiling. Bands: steady under 0.3, volatile 0.3-0.6, erratic above 1.0.',
    tunable: 'CV_STEADY, CV_VOLATILE and CV_ERRATIC, in server/insights/whDiagnostics.js.',
  },
  {
    id: 'wh-diag-reachable',
    page: 'Forecast Insights',
    visual: '"The best any forecast could do", Best possible column',
    label: 'reachable',
    source: LOCAL,
    expression: 'reachable(cv) = MAX(0, 1 - 0.8cv / (1 + 0.4cv))',
    detail:
      'The best score any forecast could get on an article that swings this much. A forecast landing ' +
      'exactly on the article’s own average is still marked down every month the article misses ' +
      'that average, and `cv` measures how far it misses; working the accuracy formula through for a ' +
      'swing of cv gives this expression.\n\n' +
      'Checked against the population on 8 Sep 2026: the typical article swings ±67% and scored ' +
      '58.9% when given perfect knowledge of its own level, against 57.7% predicted here — close ' +
      'enough to publish. This is the number that separates "the forecast is wrong" from "the ' +
      'article cannot be forecast", which is the only distinction this panel exists to make.',
  },
  {
    id: 'wh-diag-ceiling',
    page: 'Forecast Insights',
    visual: 'Can we reach 85% — the three ceiling cards',
    label: 'Ceiling',
    source: LOCAL,
    expression: `all    = AVERAGE(reachable) over every scored article
active = AVERAGE(reachable) over scored articles whose status is 'active'
steady = AVERAGE(reachable) over scored articles with cv < 0.3
typicalSwing = MEDIAN(cv) over scored articles`,
    detail:
      'Averaged the same way the accuracy card averages, so this is in the card’s own units: the ' +
      'score a forecast would get if it knew every article’s true average and nothing else. It is ' +
      'NOT a prediction of what will be achieved — it is the line above which no method of any kind ' +
      'can go while these articles are the ones being scored.\n\n' +
      'Cut three ways because the difference between them is the whole argument: the population ' +
      'decides the ceiling far more than the method does. `swingFor85` (0.2) is the swing an article ' +
      'must be under for 85% to be possible at all.',
  },
  {
    id: 'wh-diag-segments',
    page: 'Forecast Insights',
    visual: 'What makes the difference',
    label: 'Share forecast well, per segment',
    source: LOCAL,
    expression: `count = articles in the segment
good  = those with accuracy >= 60%
share = good / count`,
    detail:
      'The same pass mark applied to four different cuts of the same scored articles — by ' +
      'volatility, by volume, by months of history, and recipe against non-recipe. Each cut ' +
      'partitions the whole population, so its counts sum to `scored`; the cuts are not independent ' +
      'of each other and are not meant to be added together. Reading it: a cut where the share ' +
      'changes sharply from band to band is a cut that predicts forecastability.',
  },
  {
    id: 'wh-diag-issue',
    page: 'Forecast Insights',
    visual: 'Why each article is off, What to fix',
    label: 'One named reason per article',
    source: LOCAL,
    expression: `first match wins, in this order:
  dormant       no outbound in the six months the rate is built from
  stopped       shipped in the window but nothing in the last two months
  thin-history  fewer than 3 months of deliveries
  erratic       cv >= 1.0
  volatile      cv >= 0.6
  low-volume    under 100 units moved in the window
  spike         one month >= 3x the median of the others
  drift         demand has moved in one direction
  ok            forecast and outbound agree within tolerance`,
    detail:
      'Ordered by WHAT TO DO ABOUT IT rather than by size. An article that stopped shipping needs ' +
      'delisting whatever else is true of it, and saying "volatile demand" about a discontinued line ' +
      'sends somebody to tune a forecast for a product nobody sells any more. Exactly one reason per ' +
      'article, so the counts sum to the population and no article is double-counted — which also ' +
      'means an article can have several of these problems and only its most actionable one is named.',
    tunable: 'THIN_HISTORY, THIN_VOLUME and the CV bands, in server/insights/whDiagnostics.js.',
  },
  {
    id: 'wh-diag-unpredictable',
    page: 'Forecast Insights',
    visual: 'Articles that are naturally hard to forecast',
    label: 'unpredictable',
    source: LOCAL,
    expression: `hard           = scored articles with cv >= 0.6
averageAccuracy= AVERAGE(MAX(0, accuracy)) over hard
reachable      = AVERAGE(reachable) over hard
unitsAtStake   = SUM(|Forecast - Outbound|) over hard
averageWithout = AVERAGE(MAX(0, accuracy)) over the REST`,
    detail:
      'The panel’s claim is "these score 22% and the best possible is 31%" — a statement about the ' +
      'articles, not about the method. `averageWithout` is the counterfactual a reader actually ' +
      'wants: what the headline would be if these were planned by a rule instead of forecast. ' +
      '`unitsAtStake` sums the ABSOLUTE miss, so over- and under-forecasts both count as cost ' +
      'rather than cancelling.',
    tunable: 'The cv >= 0.6 threshold, CV_VOLATILE in server/insights/whDiagnostics.js.',
  },
  {
    id: 'wh-diag-status',
    page: 'Forecast Insights',
    visual: 'Article status',
    label: 'The status ladder',
    source: LOCAL,
    expression: 'First matching rung, from days since the article last shipped',
    detail:
      'Five statuses in ladder order — active, then progressively quieter, down to never-shipped. ' +
      'Each rung carries its own definition and intended treatment from ' +
      'server/insights/whClassify.js, so this page, the guide and anything printed from them ' +
      'describe the policy in one set of words rather than three. Counted over ALL articles, not ' +
      'just scored ones: an article that never shipped is precisely what this ladder exists to ' +
      'surface, and it has no accuracy at all. `classifiedAt` is the as-at date the days are ' +
      'measured from — the last day the outbound feed holds, not today.',
    tunable: 'THRESHOLDS and RECENT_WINDOW_DAYS, in server/insights/whClassify.js.',
  },
  {
    id: 'wh-diag-zero',
    page: 'Forecast Insights',
    visual: 'How often articles actually ship',
    label: 'zeroShare, regularity',
    source: COPY,
    expression: `articleWeeks = articles x 26 weeks
zeroShare    = 1 - SUM(weeks each article shipped) / articleWeeks
regular      = shipped in >= 80% of weeks
irregular    = 30% to 80%
intermittent = under 30%`,
    detail:
      'Most article-weeks have no shipment at all. That is not a gap in the data, it is what the ' +
      'demand looks like: an article ordered every third week is silent two weeks in three, and a ' +
      'forecast that spreads its demand evenly is wrong in both directions — too high on the quiet ' +
      'weeks and too low on the ordering week.\n\n' +
      'Measured over articles the warehouse ACTUALLY SHIPPED in the window, so it describes bursty ' +
      'demand rather than a catalogue full of dead lines; those are counted by the status ladder ' +
      'instead. Computed live from the local copy on every window rather than quoted, because a ' +
      'number written into a page is true on the day it is written and slowly becomes a lie.',
    tunable: 'The 26-week window and the 80%/30% cuts, in server/insights/whPatterns.js.',
  },
  {
    id: 'wh-diag-table',
    page: 'Forecast Insights',
    visual: 'All articles / Articles — <band> table',
    label: 'The article list',
    source: LOCAL,
    expression: 'the same `rows` every figure on this page is computed from, filtered to what was clicked',
    detail:
      'Not a separate query: clicking a band, a bar or a segment filters THIS list, so the count in ' +
      'the heading always equals the figure that was clicked. Each column is documented under its ' +
      'own entry — accuracy, forecast, outbound, the swing (cv), the best possible (reachable), the ' +
      'named issue and the status. Unscored articles appear only in the unfiltered list, because ' +
      'every band and share on the page is defined over scored articles.',
  },
  {
    id: 'wh-diag-narrative',
    page: 'Forecast Insights',
    visual: 'What we tested and ruled out, The plan to 85%, What has changed',
    label: 'The written sections',
    source: LOCAL,
    expression: 'No calculation — these panels are written findings, not measures',
    detail:
      'Recorded here so that "this visual has not declared a formula" never has to stand in for "it ' +
      'has no formula". These three panels carry the ARGUMENT rather than the arithmetic: what was ' +
      'tested and ruled out, what the route to the target is, and what has already been fixed or ' +
      'has since cleared.\n\n' +
      'Every NUMBER quoted inside them comes from the calculations elsewhere on this page and moves ' +
      'with the window and the brand — they are not typed-in constants. The prose around those ' +
      'numbers is written and is updated by hand when a finding changes.',
  },
  {
    id: 'wh-diag-dow',
    page: 'Forecast Insights',
    visual: 'Which days articles ship on',
    label: 'Weekday concentration',
    source: COPY,
    expression: `per article: top = MAX(qty by weekday) / SUM(qty)
one day  = top >= 50%
leaning  = top 30% to 50%
spread   = top < 30%`,
    detail:
      'A large minority of articles ship on a single weekday. Spreading their forecast evenly across ' +
      'the week guarantees a miss on every other day, which is why accuracy on a SHORT window reads ' +
      'so much worse than the same articles over a whole month — the single most useful thing on ' +
      'this panel for interpreting a bad weekly figure. Weighted by quantity, not by number of ' +
      'shipments, so one large delivery counts more than three small ones.',
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
