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
