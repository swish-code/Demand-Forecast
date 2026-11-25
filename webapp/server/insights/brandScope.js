/**
 * A brand selection must mean what it says - 25 Nov 2026, on request.
 *
 * Stock Article, Production and Swish Bakery build their rows from three
 * different places, and only one of them is narrowed by the brand fan-out:
 *
 *   recipe rows      exploded per brand, stamped `CHAINID` in the fan - these
 *                    are already the selected brand's and nothing else's
 *   site-only rows   appended by `siteOnlyRows` for the production pages. The
 *                    ones that reached no brand carry `__unattributed`, so the
 *                    fan deliberately leaves their brand cell EMPTY - see the
 *                    note at the stamp in routes/api.js, and the 29 Sep 2026
 *                    report behind it
 *   FM articles      stamped `CHAINID: FM` by `withFmArticles`, which runs
 *                    after the merge and has never consulted the selection
 *
 * So picking one brand returned that brand's articles PLUS every blank-brand
 * site row PLUS every FM article. None of the latter two belongs to the brand
 * on the slicer, and a reader scanning one brand's list has no way to tell
 * that two thirds of the rows are not that brand's.
 *
 * THE PRECEDENT THIS FOLLOWS is `includeUnmapped` on the Consumption page, two
 * hundred lines below the call site: "They belong to no brand, so beside a
 * single brand's 571 articles they would add 4,073 rows that are not that
 * brand's and swamp the page - a brand filter has to mean what it says."
 * Identical reasoning, applied to the other three pages.
 *
 * NOTHING IS NARROWED WHEN EVERY BRAND IS ASKED FOR. The unattributed and FM
 * rows are real articles the sites really handle, and the page without a brand
 * selection is still the full list - which is where they belong and where they
 * have always been read. This removes them from a narrowed page only.
 */

/**
 * Keep only the rows that belong to the brands this request asked for.
 *
 * Pure, and exported on its own, so the rule can be tested without a route,
 * Power BI or a fan-out behind it.
 *
 * @param {object[]} rows        the assembled rows, after `withFmArticles`
 * @param {string[]} brandCodes  the brands the request really covers
 * @param {boolean}  brandSplit  is `CHAINID` stamped per brand on these rows?
 * @param {number}   totalBrands how many brands exist in all (`config.brands`)
 */
export function narrowToBrands(rows, { brandCodes = [], brandSplit = false, totalBrands = 0 } = {}) {
  const asked = (brandCodes ?? [])
    .map((c) => String(c ?? '').trim().toUpperCase())
    .filter(Boolean)

  /*
   * Two ways to ask for everything, and both must pass every row through.
   *
   * No brand resolved at all is "we do not know which brands these are", and
   * narrowing on an empty set would empty the page - the same direction as the
   * New Article filter, which refuses to turn "could not tell" into "none".
   */
  if (!asked.length) return rows
  if (totalBrands > 0 && asked.length >= totalBrands) return rows

  const want = new Set(asked)
  return (rows ?? []).filter((r) => {
    const brand = String(r?.CHAINID ?? '').trim().toUpperCase()
    /*
     * A row that names a brand is kept only if it names one of THESE. This is
     * what drops the FM articles: `withFmArticles` has already written FM into
     * the cell, and FM is not a forecast brand, so it can never be asked for.
     */
    if (brand) return want.has(brand)
    /*
     * A blank cell means two different things, and the grain is what tells
     * them apart.
     *
     * Brand-split rows: every row that belongs to a brand was stamped with it,
     * so a blank one is `__unattributed` - an article the site moved to FM, to
     * the warehouse or to another site. It is not this brand's, and goes.
     *
     * Merged rows: no row carries a brand at all, because the merge is the
     * point of that view - a component in two brands is one thing to order. A
     * blank is then the normal case and says nothing about scope, so it stays.
     * The recipe fan-out has already narrowed those rows to the selection.
     */
    return !brandSplit
  })
}
