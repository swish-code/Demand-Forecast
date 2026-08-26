/**
 * DAX generation for the BBT PRODUCT FORECAST semantic model.
 *
 * Every query goes through SUMMARIZECOLUMNS and reuses the model's OWN
 * measures ([Total_Actual_Qty], [Forecast Accuracy %], [Demand Change %], ...)
 * so the web app returns exactly what the Power BI report shows.
 *
 * Model fields used (verified against the .SemanticModel TMDL):
 *   Forecast_Product_Table[Date | CHAINID | LocationID | Clean_ItemID |
 *                          ProductName_Fixed_Option | IsTomorrow]
 *   'RECIPE TABLE'[Recipe Group | Item | Node Type | BU | Product PLU]
 *   Prep_Filter_Options[Prep Status]
 *   DateTable[Date]  (1-side of the relationship to Forecast_Product_Table[Date])
 */

// --- literal escaping -------------------------------------------------------

/** A DAX literal. Numbers stay unquoted; everything else becomes a string. */
export function lit(value) {
  if (value === null || value === undefined) return 'BLANK()'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE()' : 'FALSE()'
  return '"' + String(value).replace(/"/g, '""') + '"'
}

/** DATE(y,m,d) from a YYYY-MM-DD string. */
function daxDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return `DATE(${y},${m},${d})`
}

// --- filter arguments -------------------------------------------------------

const COLUMN = {
  brands: 'Forecast_Product_Table[CHAINID]',
  locations: 'Forecast_Product_Table[LocationID]',
  products: 'Forecast_Product_Table[ProductName_Fixed_Option]',
  articles: 'Forecast_Product_Table[Clean_ItemID]',
  items: "'RECIPE TABLE'[Item]",
  recipeGroups: "'RECIPE TABLE'[Recipe Group]",
  nodeTypes: "'RECIPE TABLE'[Node Type]",
}

/**
 * Filters the Power BI reports apply to every page, hidden from the reader.
 *
 * Without these the app and the report disagree. Products whose name begins
 * "SM" are excluded by every report, and they are not marginal: they are 1.9%
 * of BBT and 10.4% of Yelo Pizza, so every figure for those brands read high
 * until this was applied.
 *
 * Two further report filters — excluding brand "YP COOP" and a null ChainName —
 * were measured against all nine models and changed nothing, so they are
 * deliberately not reproduced here. Adding inert filters to every query would
 * be surface area with no benefit.
 *
 * A caveat worth passing on: the report matches on the first two characters, so
 * it also removes genuine products that merely start with "Sm" — Smokey Rolls
 * Beef among them. The app copies that behaviour on purpose, because agreeing
 * with the report matters more than being cleverer than it. Fixing it belongs
 * in the report, and both would then need changing together.
 */
const REPORT_FILTERS = [
  'FILTER(ALL(Forecast_Product_Table[ProductName_Fixed_Option]), NOT(LEFT(Forecast_Product_Table[ProductName_Fixed_Option], 2) = "SM"))',
]

/**
 * Turn the UI filter state into SUMMARIZECOLUMNS filter arguments.
 *
 * @param {object} f                    filter state from the client
 * @param {object} [options]
 * @param {string[]} [options.only]     restrict to these filter keys
 * @param {string[]} [options.skip]     drop these filter keys
 * @param {boolean}  [options.withDate] include the date range (default true)
 */
export function filterArgs(f = {}, options = {}) {
  const { only, skip = [], withDate = true, reportFilters = true } = options
  const args = reportFilters ? [...REPORT_FILTERS] : []

  for (const [key, column] of Object.entries(COLUMN)) {
    if (only && !only.includes(key)) continue
    if (skip.includes(key)) continue
    const values = f[key]
    if (!Array.isArray(values) || values.length === 0) continue
    args.push(`TREATAS({${values.map(lit).join(', ')}}, ${column})`)
  }

  if (withDate && !skip.includes('date') && (f.dateFrom || f.dateTo)) {
    // The report slices on DateTable[Date], which filters
    // Forecast_Product_Table[Date] through the model relationship.
    const from = f.dateFrom ? daxDate(f.dateFrom) : 'MIN(DateTable[Date])'
    const to = f.dateTo ? daxDate(f.dateTo) : 'MAX(DateTable[Date])'
    args.push(`TREATAS(CALENDAR(${from}, ${to}), DateTable[Date])`)
  }

  return args
}

/** Join group-by columns, filters and measures into one SUMMARIZECOLUMNS. */
export function summarize({ groupBy = [], filters = [], measures = [] }) {
  const parts = [
    ...groupBy,
    ...filters,
    ...measures.map(([name, expr]) => `${lit(name)}, ${expr}`),
  ]
  return `SUMMARIZECOLUMNS(\n  ${parts.join(',\n  ')}\n)`
}

// --- measure shorthands -----------------------------------------------------

export const M = {
  actualQty: ['Actual_Qty', '[Total_Actual_Qty]'],
  forecastQty: ['Forecast_Qty', '[Total_Forecast_Qty]'],
  variancePct: ['Variance_Pct', '[Variance%]'],
  varianceQty: ['Variance_Qty', '[Variance_Qty]'],
  accuracy: ['Forecast_Accuracy', '[Forecast Accuracy %]'],
  tomorrowQty: ['Tomorrow_Forecast_Qty', '[Tomorrow Forecast Qty]'],
  lastAvgActual: ['Last_Avg_Actual', '[Last 2 Weekdays Avg Actual]'],
  demandChange: ['Demand_Change_Pct', '[Demand Change %]'],
  prepStatus: ['Prep_Status', '[Product Prep Status]'],
  componentForecast: ['Component_Forecast_Qty', '[Component_Forecast_Qty]'],
  componentActual: ['Component_Actual_Qty', '[Component_Actual_Qty]'],
}

// --- slicer value queries ---------------------------------------------------

/**
 * Distinct values for one slicer. Slicers cross-filter each other: passing the
 * rest of the filter state narrows the list the way Power BI slicers do.
 */
/**
 * A recipe-side slicer, narrowed to what the current selection actually uses.
 *
 * These three listed the whole recipe table regardless of anything chosen. On a
 * model holding one brand that was merely untidy; on the two that hold two
 * brands each — Slice with Just C, Mishmash with Tabel — it was wrong: choosing
 * Tabel offered Mishmash's components, and picking one returned nothing.
 *
 * 'RECIPE TABLE' has no relationship to the forecast, so the narrowing follows
 * the same join the [Component_Forecast_Qty] measure makes: Product PLU against
 * Clean_ItemID. Whatever filters are in play — brand, branch, product, date —
 * decide which PLUs are in scope, and the recipe rows follow from those.
 */
function recipeSlicer(f = {}, column) {
  const filters = filterArgs(f, { skip: ['items', 'recipeGroups', 'nodeTypes'] })
  const scope = filters.length ? `,\n    ${filters.join(',\n    ')}` : ''
  return `EVALUATE
VAR PLUs =
  CALCULATETABLE(
    VALUES(Forecast_Product_Table[Clean_ItemID])${scope}
  )
RETURN
FILTER(
  DISTINCT(
    SELECTCOLUMNS(
      FILTER('RECIPE TABLE', 'RECIPE TABLE'[Product PLU] IN PLUs),
      "${column}", 'RECIPE TABLE'[${column}]
    )
  ),
  NOT ISBLANK([${column}])
)
ORDER BY [${column}] ASC`
}

export const slicerQuery = {
  brands: (f) => `EVALUATE
FILTER(
  ${summarize({
    groupBy: ['Forecast_Product_Table[CHAINID]'],
    filters: filterArgs(f, { skip: ['brands', 'items', 'recipeGroups', 'nodeTypes'] }),
  })},
  NOT ISBLANK(Forecast_Product_Table[CHAINID])
)
ORDER BY Forecast_Product_Table[CHAINID] ASC`,

  locations: (f) => `EVALUATE
FILTER(
  ${summarize({
    groupBy: ['Forecast_Product_Table[LocationID]'],
    filters: filterArgs(f, { skip: ['locations', 'items', 'recipeGroups', 'nodeTypes'] }),
  })},
  NOT ISBLANK(Forecast_Product_Table[LocationID])
)
ORDER BY Forecast_Product_Table[LocationID] ASC`,

  products: (f) => `EVALUATE
FILTER(
  ${summarize({
    groupBy: ['Forecast_Product_Table[ProductName_Fixed_Option]'],
    filters: filterArgs(f, { skip: ['products', 'items', 'recipeGroups', 'nodeTypes'] }),
  })},
  NOT ISBLANK(Forecast_Product_Table[ProductName_Fixed_Option])
)
ORDER BY Forecast_Product_Table[ProductName_Fixed_Option] ASC`,

  articles: (f) => `EVALUATE
FILTER(
  ${summarize({
    groupBy: ['Forecast_Product_Table[Clean_ItemID]'],
    filters: filterArgs(f, { skip: ['articles', 'items', 'recipeGroups', 'nodeTypes'] }),
  })},
  NOT ISBLANK(Forecast_Product_Table[Clean_ItemID])
)
ORDER BY Forecast_Product_Table[Clean_ItemID] ASC`,

  /**
   * Articles paired with the product they belong to.
   *
   * The model has no article-name column — an article is a bare code like
   * 83001108300117. Pairing it with its product name is what lets someone find
   * "the SALT one" without already knowing the number, which is the whole point
   * of naming a slicer by name.
   */
  articleNames: (f) => `EVALUATE
FILTER(
  ${summarize({
    groupBy: [
      'Forecast_Product_Table[Clean_ItemID]',
      'Forecast_Product_Table[ProductName_Fixed_Option]',
    ],
    filters: filterArgs(f, { skip: ['articles', 'items', 'recipeGroups', 'nodeTypes'] }),
  })},
  NOT ISBLANK(Forecast_Product_Table[Clean_ItemID])
)
ORDER BY Forecast_Product_Table[Clean_ItemID] ASC`,

  items: (f) => recipeSlicer(f, 'Item'),
  recipeGroups: (f) => recipeSlicer(f, 'Recipe Group'),
  nodeTypes: (f) => recipeSlicer(f, 'Node Type'),

  prepStatus: () => `EVALUATE
DISTINCT(
  SELECTCOLUMNS(
    Prep_Filter_Options,
    "Prep Status", Prep_Filter_Options[Prep Status],
    "Sort Order", Prep_Filter_Options[Sort Order]
  )
)
ORDER BY [Sort Order] ASC`,

  dateRange: () => `EVALUATE
ROW(
  "MinDate", MIN(DateTable[Date]),
  "MaxDate", MAX(DateTable[Date]),
  "Today", TODAY(),
  "LastActual", CALCULATE(MAX(Forecast_Product_Table[Date]), Forecast_Product_Table[Actual_Qty] > 0)
)`,
}

// --- page queries -----------------------------------------------------------

/** KPI cards: Actual Qty, Forecast Qty, Variance %, Forecast Accuracy %. */
export function kpiQuery(f) {
  return `EVALUATE
${summarize({
    filters: filterArgs(f),
    measures: [M.actualQty, M.forecastQty, M.variancePct, M.varianceQty, M.accuracy],
  })}`
}

/** "Demand Forecast Tracking" line chart: actual vs forecast by date. */
export function trendQuery(f) {
  return `EVALUATE
${summarize({
    groupBy: ['Forecast_Product_Table[Date]'],
    filters: filterArgs(f),
    measures: [M.actualQty, M.forecastQty],
  })}
ORDER BY Forecast_Product_Table[Date] ASC`
}

/** "TOP PRODUCTS BY QTY VOLUME" bar chart. */
export function topProductsQuery(f, top = 0) {
  const body = summarize({
    groupBy: ['Forecast_Product_Table[ProductName_Fixed_Option]'],
    filters: filterArgs(f),
    measures: [M.actualQty, M.forecastQty],
  })
  // top = 0 means every product; the client scrolls the full list.
  const table = Number(top) > 0 ? `TOPN(${Number(top)}, ${body}, [Actual_Qty], DESC, [Forecast_Qty], DESC)` : body
  return `EVALUATE
${table}
ORDER BY [Actual_Qty] DESC`
}

/** "QTY VOLUME BY LOCATION" column chart. */
export function byLocationQuery(f) {
  return `EVALUATE
${summarize({
    groupBy: ['Forecast_Product_Table[LocationID]'],
    filters: filterArgs(f),
    measures: [M.actualQty, M.forecastQty],
  })}
ORDER BY [Actual_Qty] DESC`
}

/** PRODUCT LEVEL page "RUNRATE" table. */
/**
 * `grain` adds dimensions the reader asked for.
 *
 * Every one of them multiplies rows — a product sold in thirteen branches over
 * thirty days is one row, or thirteen, or three hundred and ninety, depending
 * on what is switched on. So they are off unless asked for, and the table says
 * as much next to the option.
 */
export function productLevelQuery(f, grain = {}) {
  return `EVALUATE
${summarize({
    groupBy: [
      ...(grain.date ? ['Forecast_Product_Table[Date]'] : []),
      ...(grain.location ? ['Forecast_Product_Table[LocationID]'] : []),
      'Forecast_Product_Table[Clean_ItemID]',
      'Forecast_Product_Table[CHAINID]',
      'Forecast_Product_Table[ProductName_Fixed_Option]',
    ],
    filters: filterArgs(f),
    measures: [M.actualQty, M.forecastQty, M.varianceQty, M.variancePct],
  })}
ORDER BY [Actual_Qty] DESC`
}

/**
 * COMPONENT LEVEL page "RUNRATE" table.
 *
 * 'RECIPE TABLE' has no relationship to Forecast_Product_Table - the
 * [Component_Forecast_Qty] measure joins them on Product PLU = Clean_ItemID
 * inside its own CALCULATE, so brand/location/date filters still reach it.
 */
export function componentLevelQuery(f, grain = {}) {
  return `EVALUATE
FILTER(
  ${summarize({
    groupBy: [
      ...(grain.date ? ['Forecast_Product_Table[Date]'] : []),
      ...(grain.location ? ['Forecast_Product_Table[LocationID]'] : []),
      "'RECIPE TABLE'[Recipe Group]",
      "'RECIPE TABLE'[Item]",
      "'RECIPE TABLE'[BU]",
      "'RECIPE TABLE'[Node Type]",
    ],
    filters: filterArgs(f, { skip: ['products'] }),
    // What the recipes implied, and what the sales that actually happened
    // implied. The row is kept on the forecast alone: a component with a
    // requirement and no sales yet is exactly what a future window looks like,
    // and dropping it would empty the page.
    measures: [M.componentForecast, M.componentActual],
  })},
  NOT ISBLANK([Component_Forecast_Qty]) && [Component_Forecast_Qty] <> 0
)
ORDER BY [Component_Forecast_Qty] DESC`
}

/**
 * PRODUCTION PLAN page "RUNRATE" table.
 *
 * [Tomorrow Forecast Qty] and [Last 2 Weekdays Avg Actual] resolve their own
 * dates off TODAY(), so the date slicer is deliberately not applied here -
 * matching the report, where this table ignores it. Prep Status is filtered on
 * [Product Prep Status], which is what the report's [Prep Slicer Filter
 * Toggle] compares against.
 */
export function productionPlanQuery(f) {
  const prep = (Array.isArray(f.prepStatus) ? f.prepStatus : f.prepStatus ? [f.prepStatus] : [])
    .filter((v) => v && v !== 'All')
  const conditions = ['[Tomorrow_Forecast_Qty] > 0']
  if (prep.length === 1) conditions.push(`[Prep_Status] = ${lit(prep[0])}`)
  else if (prep.length > 1) conditions.push(`[Prep_Status] IN {${prep.map(lit).join(', ')}}`)

  return `EVALUATE
FILTER(
  ${summarize({
    groupBy: [
      'Forecast_Product_Table[Clean_ItemID]',
      'Forecast_Product_Table[CHAINID]',
      'Forecast_Product_Table[LocationID]',
      'Forecast_Product_Table[ProductName_Fixed_Option]',
    ],
    filters: filterArgs(f, { withDate: false, skip: ['items', 'recipeGroups', 'nodeTypes'] }),
    measures: [M.tomorrowQty, M.lastAvgActual, M.demandChange, M.prepStatus],
  })},
  ${conditions.join(' && ')}
)
ORDER BY [Tomorrow_Forecast_Qty] DESC`
}

/** PRODUCTION PLAN KPI cards. */
export function productionPlanKpiQuery(f) {
  return `EVALUATE
${summarize({
    filters: filterArgs(f, { withDate: false, skip: ['items', 'recipeGroups', 'nodeTypes'] }),
    measures: [
      M.tomorrowQty,
      ['Products_To_Prepare', '[Products To Prepare]'],
      ['High_Demand_Products', '[High Demand Products]'],
      ['Low_Demand_Products', '[Low Demand Products]'],
      // Which day the plan is actually for, read from the model's own
      // IsTomorrow flag rather than assumed to be the next day here.
      //
      // [Tomorrow Forecast Qty] resolves off TODAY(), and TODAY() is the
      // service's clock, not Kuwait's. The two are the same date for
      // twenty-one hours a day and differ for the three between local midnight
      // and 03:00, when the service is still on yesterday and "tomorrow" means
      // today. A figure that disagrees with the report is nearly always this,
      // and naming the date turns an argument into a glance.
      ['Plan_Date', 'FORMAT(CALCULATE(MAX(Forecast_Product_Table[Date]), Forecast_Product_Table[IsTomorrow] = 1), "yyyy-MM-dd")'],
      // Today's forecast, for the Overview. [Tomorrow Forecast Qty] is fixed to
      // the next day, so today is read straight off the forecast column for the
      // model's own current date rather than by shifting that measure.
      ['Today_Forecast_Qty', 'CALCULATE([Total_Forecast_Qty], Forecast_Product_Table[Date] = TODAY())'],
      ['Today_Date', 'FORMAT(TODAY(), "yyyy-MM-dd")'],
    ],
  })}`
}
