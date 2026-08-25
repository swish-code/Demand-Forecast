import { executeQuery } from '../powerbi/client.js'
import { cached } from '../cache.js'
import * as dax from '../powerbi/dax.js'

/**
 * One DAX query, cached on the query text itself.
 *
 * Option lists are fetched a few at a time as the reader opens each slicer, so
 * the same list gets asked for again inside a larger request moments later. The
 * outer cache is keyed by which lists were requested and cannot see that those
 * two requests overlap; this one can, because a DAX string and a dataset fully
 * determine the answer.
 */
const once = (datasetId, query) => cached(`${datasetId}:dax:${query}`, () => executeQuery(query, datasetId))

/** Power BI dates come back as ISO date-times; the UI only wants the day. */
const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : v)

/** One row expected - SUMMARIZECOLUMNS with only measures returns 0 or 1 rows. */
const single = (rows, fallback = {}) => rows[0] ?? fallback

/**
 * Is this one of the deliberately detailed queries?
 *
 * Splitting a month of products by both branch and day multiplies the result by
 * a couple of orders of magnitude, and Power BI takes correspondingly longer.
 * The eight-second limit exists so an ordinary page never hangs on a slow
 * answer; somebody who has just ticked two extra dimensions has asked for the
 * long one, so give it the room the extract gets rather than failing it.
 */
const heavy = (grain = {}) => Boolean(grain?.date && grain?.location)

export const liveProvider = {
  /**
   * Slicer options.
   *
   * `need` lists which option sets the caller actually renders. Each one is its
   * own DAX round trip, so a page that shows four slicers should not pay for
   * nine — that was most of the wait on a cold load. The date range is always
   * fetched because every page needs it to resolve its window.
   */
  async slicers(filters, datasetId, need = null) {
    const wanted = need ? new Set(need) : null
    const want = (key) => !wanted || wanted.has(key)
    const maybe = (key, run) => (want(key) ? run() : Promise.resolve(null))

    const [
      brands,
      locations,
      products,
      articles,
      articleNames,
      items,
      recipeGroups,
      nodeTypes,
      prep,
      range,
    ] = await Promise.all([
      maybe('brands', () => once(datasetId, dax.slicerQuery.brands(filters))),
      maybe('locations', () => once(datasetId, dax.slicerQuery.locations(filters))),
      maybe('products', () => once(datasetId, dax.slicerQuery.products(filters))),
      maybe('articles', () => once(datasetId, dax.slicerQuery.articles(filters))),
      maybe('articleNames', () => once(datasetId, dax.slicerQuery.articleNames(filters))),
      maybe('items', () => once(datasetId, dax.slicerQuery.items())),
      maybe('recipeGroups', () => once(datasetId, dax.slicerQuery.recipeGroups())),
      maybe('nodeTypes', () => once(datasetId, dax.slicerQuery.nodeTypes())),
      maybe('prepStatus', () => once(datasetId, dax.slicerQuery.prepStatus())),
      once(datasetId, dax.slicerQuery.dateRange()),
    ])

    const r = single(range)
    return {
      brands: brands ? brands.map((x) => x.CHAINID) : [],
      locations: locations ? locations.map((x) => x.LocationID) : [],
      products: products ? products.map((x) => x.ProductName_Fixed_Option) : [],
      articles: articles ? articles.map((x) => x.Clean_ItemID) : [],
      // { value, label } so a slicer can show the product name and still filter
      // on the article code the rows are actually keyed by.
      articleNames: articleNames
        ? articleNames.map((x) => ({
            value: x.Clean_ItemID,
            label: x.ProductName_Fixed_Option || String(x.Clean_ItemID),
            hint: String(x.Clean_ItemID),
          }))
        : [],
      items: items ? items.map((x) => x.Item) : [],
      recipeGroups: recipeGroups ? recipeGroups.map((x) => x['Recipe Group']) : [],
      nodeTypes: nodeTypes ? nodeTypes.map((x) => x['Node Type']) : [],
      prepStatus: prep ? prep.map((x) => x['Prep Status']) : [],
      dateRange: {
        min: day(r.MinDate),
        max: day(r.MaxDate),
        today: day(r.Today),
        lastActual: day(r.LastActual),
      },
    }
  },

  async kpis(filters, datasetId) {
    return single(await executeQuery(dax.kpiQuery(filters), datasetId), {
      Actual_Qty: 0,
      Forecast_Qty: 0,
      Variance_Qty: 0,
      Variance_Pct: 0,
      Forecast_Accuracy: 0,
    })
  },

  async trend(filters, datasetId) {
    const rows = await executeQuery(dax.trendQuery(filters), datasetId)
    return rows.map((r) => ({ ...r, Date: day(r.Date) }))
  },

  topProducts(filters, top, datasetId) {
    return executeQuery(dax.topProductsQuery(filters, top), datasetId)
  },

  byLocation(filters, datasetId) {
    return executeQuery(dax.byLocationQuery(filters), datasetId)
  },

  productLevel(filters, datasetId, grain) {
    return executeQuery(dax.productLevelQuery(filters, grain), datasetId, { bulk: heavy(grain) })
  },

  componentLevel(filters, datasetId, grain) {
    return executeQuery(dax.componentLevelQuery(filters, grain), datasetId, { bulk: heavy(grain) })
  },

  productionPlan(filters, datasetId) {
    return executeQuery(dax.productionPlanQuery(filters), datasetId)
  },

  async productionPlanKpis(filters, datasetId) {
    return single(await executeQuery(dax.productionPlanKpiQuery(filters), datasetId), {
      Tomorrow_Forecast_Qty: 0,
      Products_To_Prepare: 0,
      High_Demand_Products: 0,
      Low_Demand_Products: 0,
    })
  },
}
