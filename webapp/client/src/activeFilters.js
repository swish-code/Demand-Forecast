/**
 * What is currently filtered, as short chips for the mobile filter bar.
 *
 * Kept out of the component, and free of JSX imports, so it can be tested
 * without a DOM - because the thing most worth testing about the mobile bar is
 * exactly this: that the badge count and the chips describe what is really
 * selected. A bar reading "Filters . 2" above three active slicers is worse
 * than no bar at all, since it tells the reader they have checked when they
 * have not.
 *
 * It DECIDES nothing. Every value it reports is already set in `filters`; this
 * only names it. No filter semantics live here.
 *
 * `slicers` is passed in rather than imported. The real list lives in
 * FilterBar.jsx, and importing a .jsx module here would make this file
 * unloadable by the plain `node --test` runner the project uses.
 */

/** A brand's display name, falling back to its code. */
function brandLabel(brands, code) {
  return brands?.find((b) => b.code === code)?.label ?? code
}

/**
 * One chip per active slicer.
 *
 * `show` is the page's own slicer list, and filtering by it is not cosmetic.
 * Filter state is shared across pages and saved in the browser, so a value set
 * where its slicer exists survives onto pages that do not offer it - and a chip
 * for a filter the page has no control for would be unclearable.
 *
 * A slicer with several values is ONE chip carrying a count, never one chip per
 * value: six selected articles would otherwise push the date off the row and
 * wrap the bar into the tall block it exists to replace.
 *
 * The date is deliberately absent. It always has a value, so counting it would
 * make the badge read "1" on a page with nothing filtered at all. It is shown
 * beside the button instead.
 */
export function activeChips({
  filters = {},
  show = [],
  brands = [],
  selectedBrands = [],
  slicers = [],
} = {}) {
  const out = []

  /*
   * Brands count only when they are a narrowing.
   *
   * Every brand selected is the default state of the page, not a filter, and
   * reporting it would mean the badge never reads zero.
   */
  if (selectedBrands.length && brands.length && selectedBrands.length !== brands.length) {
    out.push({
      key: 'brand',
      text:
        selectedBrands.length === 1
          ? brandLabel(brands, selectedBrands[0])
          : `${selectedBrands.length} brands`,
    })
  }

  /*
   * De-duplicated by the FIELD, not by the slicer id.
   *
   * Three slicers - `article`, `articleName` and `item` - are different
   * controls over the same `filters` key, offered on different pages. A page
   * showing two of them would otherwise produce two chips for one selection.
   */
  const seen = new Set()
  for (const s of slicers) {
    if (!show.includes(s.id)) continue
    if (seen.has(s.key)) continue
    const v = filters[s.key]
    if (!Array.isArray(v) || v.length === 0) continue
    seen.add(s.key)
    out.push({
      key: s.id,
      text: `${s.label}: ${v.length === 1 ? v[0] : `${v.length} selected`}`,
    })
  }

  return out
}

/** The badge number. Always the chip count, so the two cannot disagree. */
export function activeCount(args) {
  return activeChips(args).length
}
