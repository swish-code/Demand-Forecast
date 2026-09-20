/**
 * What kind of thing an article is — Food, Packaging, Uniform and ten others.
 *
 * Read from the Inventory Control model's own article master:
 *
 *   'Manager Article'[Article No.]      the article, as the rest of the app knows it
 *   'Manager Article'[Category Group]   the category the business already uses
 *
 * That table is the source the category slicers elsewhere are fed from, so this
 * column and those reports cannot disagree about what an article is. Nothing is
 * derived, mapped or guessed here: whatever the master says is what is shown.
 *
 * WHY THE LOOKUP IS SAFE
 *
 * Measured on 20 Sep 2026: 6,730 rows, 3,656 distinct article numbers, and
 * every one of them carries exactly ONE category - zero articles with two,
 * zero blank article numbers, zero blank categories. So a plain Map is the
 * whole of it; there is no precedence rule to get wrong.
 *
 * The master also carries a purchase-side key, `P.Article No.`, and matching on
 * that as well was tried: it adds 922 keys and not one extra match. The stock
 * article number is the join.
 *
 * THE THIRTEEN, AND WHY ALL OF THEM
 *
 *   Food 4,136 · Packaging 1,441 · Uniform 219 · Beverages 217 ·
 *   Merchandise 200 · Stationary 198 · Chemical & Cleaning 105 ·
 *   Disposable 95 · Equipments & Spare Parts 72 · Extra Charges 18 ·
 *   Marketing 14 · Services 13 · Looney Tunes 2
 *
 * Every one is offered, including the four a report's slicer is often scrolled
 * past. An article quietly missing from a filter is worse than an odd category
 * name in it.
 *
 * WHAT IT DOES NOT COVER, AND WHY THAT IS NOT A FAULT
 *
 * Against the 1,217 articles Article Detail holds, 856 match. Split by what the
 * articles are, the gap explains itself:
 *
 *   RAW - bought in     826 of 828 matched   99.8%
 *   PA  - made in house  30 of 389 matched    7.7%
 *
 * A PURCHASING article master has no category for something the kitchen makes
 * rather than buys: `Pizza Tomato Sauce (PA)`, `Chives Prep (PA)`. Those are
 * given `Prepared` by the caller rather than left blank, because "we make this"
 * is a real answer and a dash would read as missing data. 82.4% of forecast
 * volume carries a master category; the rest is Prepared.
 */
import { config } from '../config.js'
import { executeQuery } from '../powerbi/client.js'
import { cached } from '../cache.js'

const isConfigured = () => Boolean(config.inventory.workspaceId && config.inventory.datasetId)

/** The category shown for an article the purchasing master does not hold. */
export const PREPARED = 'Prepared'

/**
 * Article number to category, or null when there is no inventory model to ask.
 *
 * Null rather than an empty Map so the caller can leave the column off entirely
 * instead of showing a page of "Prepared" that would misdescribe every bought-in
 * article on it.
 */
export async function categoryByArticle() {
  if (!isConfigured()) return null

  /*
   * Cached on nothing but itself: no brand, no window, one entry for everyone.
   * An article's category changes when somebody edits the article master, which
   * is nothing like per-request.
   */
  return cached('article-category', async () => {
    const rows = await executeQuery(
      `EVALUATE
SUMMARIZECOLUMNS(
  'Manager Article'[Article No.],
  'Manager Article'[Category Group]
)`,
      config.inventory.datasetId,
      { bulk: true, workspace: config.inventory.workspaceId }
    )

    const out = new Map()
    for (const r of rows) {
      const article = String(r['Article No.'] ?? '').trim()
      const category = String(r['Category Group'] ?? '').trim()
      if (!article || !category) continue
      out.set(article, category)
    }
    return out.size ? out : null
  })
}

/**
 * Every category on offer, for the slicer.
 *
 * Taken from the values actually present rather than from a fixed list, so a
 * category added upstream appears without this file being edited. `Prepared` is
 * added because it is a real answer this app gives and somebody filtering on it
 * is asking a sensible question.
 */
export async function categoryOptions() {
  const map = await categoryByArticle().catch(() => null)
  if (!map) return []
  return [...new Set([...map.values(), PREPARED])].sort((a, b) => a.localeCompare(b))
}
