import { articleNames } from '../powerbi/warehouse.js'
import { articleNodeTypes } from './nodeTypes.js'
import { productionSourceByArticle, UNCLASSIFIED } from './productionSource.js'

/**
 * The site-classified articles the recipe explosion never returns.
 *
 * THE FAULT THIS EXISTS TO FIX
 *
 * The production pages were populated by the recipe tree and filtered by the
 * classification, which are two different populations - and the classification
 * is the better one, because it is built from what the sites actually issued
 * rather than from what a recipe implies.
 *
 * Two filters compounded to hide most of it. The component query ends
 * `NOT ISBLANK([Component_Forecast_Qty]) && [Component_Forecast_Qty] <> 0`, so
 * an article the kitchen demonstrably issues but that no menu recipe explodes
 * to has NO ROW AT ALL; then `lockNodeTypes: ['PREP','PA']` drops the RAW ones.
 * Audited on 29 Sep 2026 for August:
 *
 *                        classified   reached the page
 *   Central Kitchen/CPU         954                324
 *   Swish Bakery                107                 33
 *   YELO Factory                  9                  0
 *
 * The Yelo Factory page was empty for exactly this reason - all nine of its
 * articles have no recipe forecast - and it read as missing data, a broken
 * classification or an access problem, none of which it was.
 *
 * WHAT THESE ROWS ARE
 *
 * One row per classified article the explosion did not return, carrying the
 * identity of the article and nothing it cannot support:
 *
 *   Forecast qty / Actual qty  BLANK. There is no recipe to explode, so there
 *                              is no demand figure - and inventing one from the
 *                              site history would put the same number in two
 *                              columns and make one method look like two. The
 *                              Outbound forecast band is where these are
 *                              measured, and it measures them properly.
 *
 * The node type is read where the master knows it and left blank where it does
 * not - a classified article with no recipe row genuinely has no type, and
 * guessing RAW would be a claim about how it is made.
 *
 * WHY IT DOES NOT TOUCH STOCK ARTICLE
 *
 * Only the pages that pin a production source ask for these. Stock Article is
 * the bought half and already has its own mechanism for articles no recipe
 * mentions - `nonRecipeRows`, which these rows are modelled on and deliberately
 * separate from: that one answers "the warehouse ships this and no recipe
 * names it", this one answers "a production site issues this and no recipe
 * names it". Same shape, different evidence, different pages.
 */

/*
 * Why the row is here, and they are NOT the same reason.
 *
 * The first version stamped every added row "No recipe — from site outbound",
 * which made the Recipe column read "Non-recipe" for all of them. That is how
 * `fromRecipe` decides the label - it tests whether Recipe Group starts with
 * "No recipe" - and for most of these rows it was simply untrue.
 *
 * BACON ERMG is the case that showed it: article 100300001 is in every brand's
 * RECIPE TABLE, under MM-Final Food Recipe, linked to eleven MM products. It
 * was labelled non-recipe because it was absent from the component query, and
 * it is absent for a completely different reason - the query drops a zero
 * forecast, and only MM's products use it, so the other eight brands forecast
 * none of it.
 *
 * "Has no recipe" and "has a recipe that nothing forecast in this window" are
 * different facts about an article, and a reader deciding what to make needs to
 * be able to tell them apart.
 */
export const SITE_ONLY_GROUP = 'No recipe — from site outbound'
export const SITE_UNFORECAST_GROUP = 'Recipe — nothing forecast in this window'

/**
 * Rows for every classified article missing from `covered`.
 *
 * `covered` is the set of article numbers the recipe explosion already
 * returned; anything in it is left alone, because a second row for the same
 * article would double every total that meets it.
 *
 * `sources` narrows to the pages asking - so the CK page does not pay for the
 * bakery's articles. Null means every site, which is what the Production page
 * wants.
 *
 * Returns [] rather than throwing when a lookup fails: these rows are an
 * addition to a page that already works, and a page that loses its whole table
 * because one supporting query failed is worse than a page missing them.
 */
export async function siteOnlyRows(
  covered,
  { sources = null, hasOutbound = null, alsoInclude = null, markUnattributed = null } = {}
) {
  const [classes, names, types] = await Promise.all([
    productionSourceByArticle().catch(() => null),
    articleNames().catch(() => new Map()),
    Promise.resolve(articleNodeTypes()).catch(() => new Map()),
  ])
  if (!classes?.size) return []

  const wanted = sources?.length ? new Set(sources.map((v) => String(v))) : null

  const rows = []
  for (const [article, source] of classes) {
    if (!article) continue
    if (covered.has(article)) continue
    /*
     * Unclassified is included only when it is asked for by name.
     *
     * It is not a site: it is the articles no rule could place, and the page
     * that holds them exists so they can be looked at rather than shipped. The
     * Production page asks for every site and must not silently absorb them.
     */
    if (wanted ? !wanted.has(source) : source === UNCLASSIFIED) continue

    /*
     * One row per BRAND THAT RECEIVES IT, not one per brand.
     *
     * The classification is company-wide - an article belongs to a site, not to
     * a brand - and these rows are built inside the per-brand fan-out. Without
     * this test every brand got a copy of every classified article: BACON ERMG
     * appeared nine times, eight of them entirely blank, and the table went from
     * roughly 1,100 rows to 8,605. Reported within minutes of shipping it.
     *
     * `hasOutbound` is the articles this brand actually received from the sites
     * in the selected window, which is the same figure the Outbound column
     * shows - so a row exists exactly where there is something to put in it.
     *
     * `alsoInclude` is how an article that moved for NO brand in the window
     * still gets listed - exactly once, because only one brand's pass is given
     * the set. Asked for on 29 Sep 2026: these pages are the list of what each
     * site is responsible for, so an article missing because it happened not to
     * move in the chosen month reads as an article that does not exist. The row
     * is mostly blank, and that is the honest answer for a quiet month.
     */
    if (hasOutbound && !hasOutbound.has(article) && !alsoInclude?.has(article)) continue

    const known = names.get(article)
    /*
     * `articleNodeTypes` reads the RECIPE TABLE itself, so knowing an article's
     * type IS knowing it has a recipe row. One lookup answers both questions
     * and they cannot disagree.
     */
    const nodeType = types?.get?.(article) ?? ''
    const inRecipe = Boolean(nodeType)
    rows.push({
      'Recipe Group': inRecipe ? SITE_UNFORECAST_GROUP : SITE_ONLY_GROUP,
      Item: known?.name || article,
      'Item No.': article,
      BU: known?.unit || '',
      // Blank where nothing knows it, rather than a guess - see the header.
      'Node Type': nodeType,
      Component_Forecast_Qty: null,
      Component_Actual_Qty: null,
      Prod_Source: source,
      /*
       * True when no brand received this article and none forecasts it, so the
       * row is here to represent the SITE rather than any brand. The route
       * reads it to leave the brand column empty instead of naming whichever
       * brand's pass happened to carry the row.
       */
      ...(markUnattributed?.(article) ? { __unattributed: true } : {}),
    })
  }
  return rows
}
