import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { consumptionByArticle } from '../powerbi/warehouse.js'
import * as dax from '../powerbi/dax.js'

/**
 * Forecasting the things no recipe knows about.
 *
 * Most of what a shop gets through is in a recipe, so its requirement follows
 * from the sales forecast: so many burgers, therefore so many buns. Gloves,
 * cleaning materials, uniforms, till rolls and a long tail of packaging are not
 * in any recipe, and until now they had no forecast at all — the planning sheet
 * simply reads "Not Exist" against them.
 *
 * They are still driven by trade, though. A busier month gets through more
 * gloves, just not in a way any recipe writes down. So the relationship is
 * measured rather than derived:
 *
 *     constant = last month's sales / last month's outbound of that item
 *
 * which is how many units of sale one unit of the item goes with. Divide next
 * month's forecast sales by it and you have next month's requirement. The
 * algebra reduces to something easier to argue about at a planning meeting:
 *
 *     next month = last month's outbound x (next month's sales / last month's)
 *
 * — take what actually went out, and scale it by how much busier the month is
 * expected to be. Nothing is invented; it is last month's real usage moved in
 * proportion to trade.
 *
 * Everything here is per brand. One brand growing while another shrinks would
 * otherwise average into a number belonging to neither.
 */

const iso = (d) => d.toISOString().slice(0, 10)

/** Whole months: the one that has finished, and the one being planned. */
export function monthWindows(today = new Date()) {
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth()
  const start = (yy, mm) => new Date(Date.UTC(yy, mm, 1))
  const end = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0))
  return {
    last: { from: iso(start(y, m - 1)), to: iso(end(y, m - 1)) },
    next: { from: iso(start(y, m + 1)), to: iso(end(y, m + 1)) },
  }
}

/**
 * One brand's sales over one month, from its own model.
 *
 * Built with the same filter helper every page uses, so the hidden report-level
 * filters and the chain pin for the two models that hold two brands each are
 * applied here exactly as they are everywhere else. A figure that quietly
 * skipped them would make every constant below wrong by the same amount.
 */
const salesFor = async (brand, window, which) => {
  const filters = dax.filterArgs({
    brands: brand.chain ? [brand.chain] : [],
    dateFrom: window.from,
    dateTo: window.to,
  })
  const measure = which === 'actual' ? dax.M.actualQty[1] : dax.M.forecastQty[1]
  // Assembled from an array rather than one long template, so the newlines
  // in the query are data rather than something to escape past.
  const query = [
    'EVALUATE',
    'ROW("qty", CALCULATE(' + measure + ',',
    '  ' + filters.join(',' + '\n' + '  '),
    '))',
  ].join('\n')
  const rows = await executeQuery(query, brand.datasetId)
  return Number(rows[0]?.qty) || 0
}

/**
 * One brand's non-recipe items, with the constant and what it implies.
 *
 * An item is "non-recipe" when no recipe anywhere calls for it. Those are the
 * ones this exists for; anything a recipe knows about is forecast properly and
 * must not be forecast twice.
 */
async function forBrand(brand, windows, recipeArticles) {
  const [lastSales, nextSales] = await Promise.all([
    salesFor(brand, windows.last, 'actual'),
    salesFor(brand, windows.next, 'forecast'),
  ])

  const consumed = await consumptionByArticle(brand.code, {
    dateFrom: windows.last.from,
    dateTo: windows.last.to,
  })
  if (!consumed) return { brand: brand.code, items: [], lastSales, nextSales, reason: 'no warehouse data' }

  const items = []
  for (const [article, outbound] of consumed) {
    if (recipeArticles.has(article)) continue // a recipe already forecasts it
    if (!outbound) continue

    /*
     * The constant, exactly as defined: sales per unit of the item. Reported as
     * well as used, because it is the number somebody will want to argue with —
     * a constant of 4,000 says one glove box per four thousand items sold, and
     * whether that is right is a question for the person who orders gloves.
     */
    const constant = lastSales ? lastSales / outbound : null
    const forecast = constant ? nextSales / constant : null

    items.push({
      article,
      outbound,
      constant,
      forecast,
      // Stated rather than implied: the whole method is this one ratio.
      growth: lastSales ? nextSales / lastSales : null,
    })
  }

  items.sort((a, b) => (b.forecast ?? 0) - (a.forecast ?? 0))
  return { brand: brand.code, label: brand.label, lastSales, nextSales, items }
}

/** Every brand, with the articles no recipe covers. */
export async function nonRecipeForecast({ today = new Date() } = {}) {
  const windows = monthWindows(today)

  // One read of the recipe side; RECIPE TABLE is the same table in every model.
  const first = config.brands[0]
  const recipeRows = await executeQuery(
    `EVALUATE SUMMARIZECOLUMNS('RECIPE TABLE'[Item No.])`,
    first.datasetId,
    { bulk: true }
  )
  const recipeArticles = new Set(
    recipeRows.map((r) => String(r['Item No.'] ?? '').trim()).filter(Boolean)
  )

  const brands = []
  for (const brand of config.brands) {
    try {
      brands.push(await forBrand(brand, windows, recipeArticles))
    } catch (err) {
      brands.push({ brand: brand.code, label: brand.label, items: [], reason: err.message.slice(0, 120) })
    }
  }

  return { windows, recipeArticles: recipeArticles.size, brands }
}
