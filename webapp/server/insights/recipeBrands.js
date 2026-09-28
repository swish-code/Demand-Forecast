/**
 * Which recipe groups belong to which brand.
 *
 * WHY THIS EXISTS
 *
 * `'RECIPE TABLE'` is a company-wide master with no brand column, and the same
 * ~262,000 rows are loaded into every brand's model - verified 28 Sep 2026:
 * BBT and YP hold 260,423 rows, the other seven 262,007, and the column list is
 * Product PLU / Product Name / Recipe Group / Recipe / Node Type / Has Children
 * / Item No. / Item / Parent Recipe / Recipe Path / Level / QTY BU / BU. There
 * is nothing in it that says which brand a recipe belongs to.
 *
 * So the only join available to the recipe explosion is Product PLU against
 * Forecast_Product_Table[Clean_ItemID] - and PLU is not unique. Not across
 * brands, and not even within one: in YP's model PLU 958 is both "7up" and
 * "Sprite", and PLU 246 is both "Thin Crust Spicy Chipotle Bacon" and "Pan Peri
 * Peri Ranch Chicken". Meanwhile the recipe master uses 958, 246, 247, 957 and
 * 1055 for entirely different things.
 *
 * The result was Yelo Pizza being forecast to need BBT's lettuce. Reported on
 * 28 Sep 2026: `107100004 Lettuce iceberg prep (PA)` came out at 10.27 kg for
 * the whole of 2027 under YP - a number small enough to look like rounding,
 * which is exactly what made it dangerous.
 *
 * WHAT FIXES IT
 *
 * `Recipe Group` carries the brand in its name, and there are only 38 of them.
 * A stated mapping is far more robust than a PLU join that collides, and it is
 * short enough that somebody can check it by eye - which is the point.
 *
 * Nine groups are deliberately unmapped: the five FM ones and the four Love
 * bird ones. FM is a separate company the forecast does not cover. Love bird
 * appears as its own cost centre (LVB) beside the nine forecast brands rather
 * than inside any of them, so it is treated the same way. If either turns out
 * to belong to a forecast brand, add it here - that is the whole change.
 *
 * Names are matched with whitespace collapsed and case ignored, because three
 * of them carry a double space in the source ("bola  Yelo recipes",
 * "Yelo Pizza  Commissary", "bola  Chili pepper recipes").
 */
const GROUPS = {
  BBT: [
    'BBT Final Food Recipe',
    'BBT Final Bev Recipe',
    'BBT Commissary',
    'BBT Merchandise',
    'BBT Outlet Semi Finished',
  ],
  CHP: ['Chilipepper Final Product', 'bola Chili pepper recipes', 'Chili Pepper Commissary'],
  PAT: ['patty patty Finished Items', 'patty patty Out semi-Finished', 'PP-Merchandise'],
  SS: [
    'Shaker Final Food Recipes',
    'Shaker Finished Bev Recipe',
    'Shaker Outlet Semi Finished',
    'Shaker Commissary',
  ],
  YP: ['Yelo Pizza Finished Product', 'Yelo Pizza Commissary', 'bola Yelo recipes'],
  SLC: [
    'Slice Final Food Recipes',
    'Slice Final Bev Recipes',
    'Slice Outlet Semi Finished',
    'Inactive Slice Final Food Recipes(Old)',
  ],
  // Just C is BUR - confirmed 28 Sep 2026. It shares a model with Slice, which
  // is why the two appear on one dashboard.
  BUR: ['Just C Final Food Recipes', 'Just C Final Bev Recipes'],
  MM: ['MM-Final Food Recipe', 'MM-Final Bev Recipe', 'MM-Outlet Semi-Finished items'],
  TBL: ['T.Final Food Recipe', 'T. Final Bev Recipe'],
}

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase()

const BY_BRAND = new Map(
  Object.entries(GROUPS).map(([brand, list]) => [brand, new Set(list.map(norm))])
)

/** Every recipe group name this brand owns, normalised. Null when unmapped. */
export function recipeGroupsFor(brand) {
  return BY_BRAND.get(String(brand ?? '').trim().toUpperCase()) ?? null
}

/**
 * The same list as written in the source, for putting into a query.
 *
 * `recipeGroupsFor` normalises for comparison, which is the wrong shape to send
 * back to Power BI - it would match nothing. Null for an unmapped brand, which
 * a caller must read as "do not filter" rather than "filter to nothing".
 */
export function recipeGroupNamesFor(brand) {
  return GROUPS[String(brand ?? '').trim().toUpperCase()] ?? null
}

/**
 * Does this recipe line belong to this brand?
 *
 * A brand with no mapping is left alone - `true` for everything - because the
 * permissive answer is the safe one here. A brand that is added to the config
 * and forgotten here would otherwise lose its whole recipe side silently, which
 * is a worse failure than the leak this guards against.
 */
export function belongsToBrand(brand, recipeGroup) {
  const owned = recipeGroupsFor(brand)
  if (!owned) return true
  return owned.has(norm(recipeGroup))
}
