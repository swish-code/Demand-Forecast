import { cached } from '../cache.js'
import { executeQuery } from '../powerbi/client.js'
import { planProductRows } from './planForecast.js'
import { recipeGroupNamesFor } from './recipeBrands.js'

/**
 * A planned year's ARTICLE requirement, exploded from the planned PRODUCTS.
 *
 * WHY THIS REPLACED THE OLD PATH
 *
 * The Sales Plan used to reach articles by taking the base year's recipe
 * explosion and multiplying the whole thing by one factor. That re-derived the
 * products instead of using the ones the plan had already worked out, and it
 * inherited none of what the product side does:
 *
 *   - no last-28-days blend, so a product launched mid-year is forecast from a
 *     base year in which it barely existed. The Nashville range launched in
 *     September 2026, so the base year held four months of it and the article
 *     requirement came out about a third of the truth - before the stale-copy
 *     defect took it down another twenty-fold.
 *   - no month-validity correction, so a base-year month with a broken
 *     units-per-dinar ratio fed straight through.
 *   - no reconciliation: the Products tab and the Articles tab were two
 *     independent calculations of the same thing, free to disagree.
 *
 * So this consumes `planProductRows` - Method C, with its 75/25 history-to-
 * latest blend and its 25% validity threshold - and explodes those units
 * through the recipe tree. Products and articles now agree by construction,
 * because the articles are the products.
 *
 * WHAT IT DOES NOT CHANGE
 *
 * Nothing about the warehouse-constant path, which still answers first for any
 * article the warehouse has shipped. This only decides what the recipe side
 * contributes for the articles the warehouse cannot reach.
 */

/**
 * Recipe lines for one brand, as article-per-product-unit rates.
 *
 * Scoped by recipe group, because 'RECIPE TABLE' is a company-wide master with
 * no brand column and Product PLU collides both across brands and within one -
 * see `recipeBrands.js`. Scoped again by the PLUs the plan actually uses, which
 * keeps the answer small.
 *
 * `Product PLU` is an Integer in BBT's model and Text in the others, so both
 * sides of the match are converted to numbers. A non-numeric PLU is dropped
 * rather than allowed to raise, because VALUE() throws on the first one it
 * meets and would take the whole query down.
 *
 * Summed per (PLU, article): one article can appear on several paths of the
 * same product - a sauce in the base and again in a topping - and the
 * requirement is the total of them, which is what the model's own measure does.
 */
async function recipeRates(brand, plus) {
  const groups = recipeGroupNamesFor(brand.code)
  if (!groups?.length || !plus.length) return []

  const numeric = plus.map((p) => Number(p)).filter((n) => Number.isFinite(n))
  if (!numeric.length) return []

  /*
   * The PLU list goes into the query only while it is small enough to help.
   * Past a few thousand the literal costs more than it saves, and the recipe
   * group filter alone already cuts the master to one brand's share.
   */
  const pluFilter =
    numeric.length <= 3000
      ? `,
  FILTER(
    ALL('RECIPE TABLE'[Product PLU]),
    NOT ISERROR(VALUE('RECIPE TABLE'[Product PLU]))
      && VALUE('RECIPE TABLE'[Product PLU]) IN {${numeric.join(', ')}}
  )`
      : ''

  /*
   * Grouped by the ITEM as well as the article number.
   *
   * A prep step is a kitchen instruction rather than a stocked thing, so the
   * recipe master leaves its `Item No.` blank - about a quarter of all
   * component rows. Keying on the article number alone silently dropped every
   * one of them, even though the forecast for them exists and the Production
   * page shows it, identified by recipe and item instead.
   *
   * So the item name comes back too, and a row with no article number is kept
   * and keyed by its name. `Node Type` and `BU` come with it because there is
   * no article master to look either up in for those rows.
   */
  const dax = `EVALUATE
SUMMARIZECOLUMNS(
  'RECIPE TABLE'[Product PLU],
  'RECIPE TABLE'[Item No.],
  'RECIPE TABLE'[Item],
  'RECIPE TABLE'[Node Type],
  'RECIPE TABLE'[BU],
  TREATAS({${groups.map((g) => `"${g.replace(/"/g, '""')}"`).join(', ')}}, 'RECIPE TABLE'[Recipe Group])${pluFilter},
  "rate", SUM('RECIPE TABLE'[QTY BU])
)`

  const key = `${brand.datasetId}:plan-recipe-rates:${groups.length}:${numeric.length <= 3000 ? numeric.slice().sort().join(',') : 'all'}`
  return cached(key, async () => {
    const rows = await executeQuery(dax, brand.datasetId, { bulk: true }).catch((err) => {
      console.warn(`  [plan-articles] ${brand.code}: recipe rates unavailable (${err.message})`)
      return null
    })
    if (!rows) return []
    const out = []
    for (const r of rows) {
      const plu = Number(r['Product PLU'] ?? r['[Product PLU]'])
      const article = String(r['Item No.'] ?? r['[Item No.]'] ?? '').trim()
      const item = String(r.Item ?? r['[Item]'] ?? '').trim()
      const rate = Number(r.rate ?? r['[rate]']) || 0
      // An article number OR a name is enough to identify a requirement; with
      // neither there is nothing to report it against.
      if (!Number.isFinite(plu) || !(rate > 0) || (!article && !item)) continue
      out.push({
        plu,
        article,
        item,
        nodeType: String(r['Node Type'] ?? r['[Node Type]'] ?? '').trim(),
        unit: String(r.BU ?? r['[BU]'] ?? '').trim(),
        rate,
      })
    }
    return out
  })
}

/**
 * @returns {{ byArticle: Map<string, number>, unsplit: number, products: number }}
 *   `unsplit` is planned product units that carry no PLU at all, so nothing can
 *   be exploded from them. Reported rather than swallowed.
 */
export async function planArticleRows(brand, year, window) {
  const products = await planProductRows(brand.code, year, window).catch(() => [])

  const byPlu = new Map()
  let unsplit = 0
  for (const r of products) {
    const qty = Number(r.Forecast_Qty) || 0
    if (!(qty > 0)) continue
    const plu = String(r.Clean_ItemID ?? '').trim()
    // A product with no observed article split still has a forecast; it just
    // has no PLU to explode through. Counted so the caller can say so.
    if (!plu) { unsplit += qty; continue }
    byPlu.set(plu, (byPlu.get(plu) ?? 0) + qty)
  }
  if (!byPlu.size) return { byArticle: new Map(), unsplit, products: 0 }

  const rates = await recipeRates(brand, [...byPlu.keys()])
  return { byArticle: explodeArticles(byPlu, rates), unsplit, products: byPlu.size }
}

/**
 * The arithmetic on its own, so it can be tested without Power BI.
 *
 *   article requirement = SUM over menu items of ( menu item units x rate )
 *
 * `rates` arrives already summed per (PLU, article) by the query, which is the
 * right place for it: two recipe PATHS to the same article inside one product
 * are two real requirements and must add. What must NOT add is one product's
 * units being counted once per path - so the units are looked up per PLU and
 * multiplied by the already-summed rate, never accumulated per row.
 *
 * Measured 28 Sep 2026 against the model's own Component_Actual_Qty for YP over
 * August: no (PLU, article) pair in the recipe master carries more than one
 * product name, so there is nothing here to de-duplicate.
 */
export function explodeArticles(unitsByPlu, rates) {
  const byArticle = new Map()
  for (const r of rates) {
    const units = unitsByPlu.get(String(r.plu))
    if (!units) continue
    /*
     * The article number where there is one, the item name where there is not.
     * Prefixed so a prep step called "1234" can never collide with article
     * 1234, which is the kind of thing that goes unnoticed for a year.
     */
    const key = r.article || `item:${r.item}`
    const held = byArticle.get(key)
    const qty = units * r.rate
    if (held) { held.qty += qty; continue }
    byArticle.set(key, {
      qty,
      article: r.article || '',
      item: r.item || '',
      nodeType: r.nodeType || '',
      unit: r.unit || '',
    })
  }
  return byArticle
}
