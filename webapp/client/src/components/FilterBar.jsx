import { MultiSelect } from './MultiSelect.jsx'
import { DateRange } from './DateRange.jsx'
import { BrandPicker } from './BrandPicker.jsx'
import { FiltersPill } from './FiltersPill.jsx'
import { IconCalendar, IconFilter, IconSummary } from './Icons.jsx'

/*
 * The new Filters control, behind one constant - 20 Nov 2026.
 *
 * `false` restores the old row of pills on every page at once, with no other
 * edit anywhere: the switch is inside this component and its props are
 * unchanged, which is why fifteen pages could adopt it without being touched.
 */
const NEW_FILTERS = false

/** What the Date row says on its right-hand side. */
function dateSummary(filters, options) {
  const { dateFrom, dateTo, defaultFrom, defaultTo } = filters ?? {}
  if (!dateFrom && !dateTo) return 'All dates'
  if (dateFrom === defaultFrom && dateTo === defaultTo) return 'Default'
  const short = (d) => String(d ?? '').slice(0, 10)
  return `${short(dateFrom)} – ${short(dateTo)}`
}

/**
 * The line written on the pill itself.
 *
 * Names the two things a reader most wants to see without opening anything -
 * which brands, and which dates - and then says how many other filters are on
 * rather than listing them, because a pill that lists ten slicers is the row
 * of pills this replaced.
 */
function pillSummary({ filters, options, visible, selectedBrands, brands, show }) {
  const parts = []
  if (brands.length > 1) {
    parts.push(
      selectedBrands.length === 0
        ? 'All brands'
        : selectedBrands.length === 1
          ? (brands.find((b) => b.code === selectedBrands[0])?.label ?? selectedBrands[0])
          : `${selectedBrands.length} brands`
    )
  }
  if (show.includes('date')) parts.push(dateSummary(filters, options))
  const others = visible.filter((s) => (filters[s.key] ?? []).length > 0).length
  if (others) parts.push(`+${others} filter${others === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/**
 * A single row of filter pills. `show` lists the slicers this page carries,
 * mirroring the corresponding Power BI report page:
 *
 *   brand | location | product | article | item |
 *   nodeType (production type) | prepStatus | date
 *
 * Each pill reads "Label: value"; unset pills read "All".
 */

/*
 * Exported so the request can be narrowed to the slicers a page actually shows.
 *
 * Filter state is shared across pages and saved in the browser, so a value set
 * where its slicer exists kept filtering pages that do not offer it - with no
 * control to clear it and nothing on screen to say why the page was short. See
 * `filtersForPage` in App.jsx.
 */
export const SLICERS = [
  { id: 'location', key: 'locations', label: 'Location', options: 'locations', placeholder: 'All' },
  { id: 'product', key: 'products', label: 'Product', options: 'products', placeholder: 'All' },
  { id: 'article', key: 'articles', label: 'Product PLU', options: 'articles', placeholder: 'All' },
  // Same filter, named rather than numbered. The production plan is read by
  // branch staff, who know the product but not its article code.
  { id: 'articleName', key: 'articles', label: 'Product PLU', options: 'articleNames', placeholder: 'All' },
  // Labelled for what the reader calls it. The other two article slicers are
  // "Product PLU" and are not offered on the same page, so there is nothing to
  // confuse it with.
  { id: 'item', key: 'items', label: 'Article', options: 'items', placeholder: 'All' },
  { id: 'nodeType', key: 'nodeTypes', label: 'Prod. type', options: 'nodeTypes', placeholder: 'All' },
  /*
   * What kind of thing the article is — Food, Packaging, Uniform and the rest.
   *
   * From the Inventory Control article master, so it is the same list the
   * category slicers elsewhere offer. Items the kitchen makes rather than buys
   * are "Prepared", which the master has no category for and which is a real
   * answer rather than a gap.
   */
  { id: 'category', key: 'categories', label: 'Category', options: 'categories', placeholder: 'All' },
  /*
   * Where an article's stock comes from.
   *
   * Two fixed values rather than a list read from a model: it is derived from
   * whether the warehouse has issued the article in six months, so there is
   * nothing to look up and no third answer.
   */
  /*
   * HIDDEN 28 Oct 2026, at the user's request, TEMPORARILY.
   *
   * Commented out rather than deleted so putting it back is uncommenting one
   * line. Nothing else was touched: the server still computes `supply`, still
   * accepts the filter, and `withSupply` is untouched - so a saved view or a
   * bookmarked URL that carries a supply filter still works. Only the control
   * is gone from the bar.
   */
  // { id: 'supply', key: 'supply', label: 'Supply', options: 'supply', placeholder: 'All' },
  /*
   * Transaction Type, which until 28 Oct 2026 sat beside Supply.
   *
   * The two looked similar and answered different questions - Supply is a
   * standing fact about the article, this is what happened in the window on
   * screen - so they were offered together and neither narrowed the other.
   */
  { id: 'channel', key: 'channels', label: 'Transaction Type', options: 'channels', placeholder: 'All' },
  /*
   * Transfer Status, added 3 Nov 2026 for the production-source pages.
   *
   * Beside Transaction Type because both are read from the warehouse model,
   * and separate from it because they ask different questions: that column
   * names the LATEST movement, this one asks whether a direct transfer to the
   * row's own brand happened anywhere in the window.
   */
  { id: 'transferStatus', key: 'transferStatus', label: 'Transfer Status', options: 'transferStatus', placeholder: 'All' },
  /*
   * Whether our recipe and Oracle's disagree about this article - 8 Nov 2026.
   *
   * Two fixed values, stamped by `varianceFlag` on the server rather than being
   * a column any query can narrow on, so the slicer is applied to the assembled
   * rows beside Transaction Type and Transfer Status. Only the Consumption page
   * offers it, because it is the only page carrying Oracle's figures.
   */
  { id: 'varianceFlag', key: 'varianceFlags', label: 'Variance', options: 'varianceFlag', placeholder: 'All' },
  /*
   * Whether ORACLE has a recipe for the article - 9 Nov 2026, on request.
   *
   * Not the same question as Prod. type, which asks whether OUR recipe tree
   * knows it. This one asks whether Oracle's own `Potential COS QTY` is
   * anything at all, and it exists because of what that does to the variance:
   * where the theoretical is nothing, the whole of consumption is the variance
   * and there is no percentage to put it in proportion, so 7,112 of 9,302
   * article-brands - napkins, tissue, gloves, containers - swamp the figures
   * that do have a recipe behind them. Measured 9 Nov 2026.
   *
   * Applied by the Consumption page itself rather than by the server: the value
   * is read off a column already in the response, so filtering locally changes
   * the view without re-querying Power BI for rows it is about to drop.
   */
  /*
   * "MC theoretical" - renamed 12 Nov 2026, on request.
   *
   * It was "Recipe", then "MC recipe", and the word was the problem both
   * times. `recipeKind` below asks whether OUR recipe tree knows the article;
   * this asks only whether MC holds a Potential COS QTY for it. Calling both
   * of them "recipe" invited the reading that a zero here means the article
   * has no recipe, which it does not - genuine non-recipe articles exist on
   * both sides of this test.
   *
   * The label now matches the MC Theoretical column it keys on, and the two
   * values say what is measured rather than what might be concluded.
   */
  { id: 'oracleRecipe', key: 'oracleRecipes', label: 'MC theoretical', options: 'oracleRecipe', placeholder: 'All' },
  /*
   * How long since the article was last issued - by the CENTRAL WAREHOUSE on
   * Stock Article, and by the page's own production site where one is pinned
   * (Production reads CK/CPU, from 5 Nov 2026). Same ladder either way; the
   * server picks the source in `withStatus`.
   *
   * The same ladder the forecast routes on, so filtering to Non-Moving shows
   * exactly the articles the forecast decided not to forecast.
   */
  { id: 'status', key: 'statuses', label: 'Status', options: 'statuses', placeholder: 'All' },
  /*
   * Whether a recipe asks for the article, or only the warehouse ships it.
   *
   * Two fixed values like Supply, and for the same reason: it is derived from
   * whether any recipe names the article, so there is nothing to look up and no
   * third answer.
   */
  { id: 'recipeKind', key: 'recipeKinds', label: 'Recipe', options: 'recipeKinds', placeholder: 'All' },
]

/*
 * `brands` and `selectedBrands` default to empty - 20 Nov 2026.
 *
 * They had no defaults, and the old bar got away with it because it only ever
 * handed them to `BrandPicker`, which defaults them itself. The new branch
 * reads `brands.length` directly, so an undefined value threw and took the
 * whole app to a blank page. `MobileChrome` renders this component with
 * `{...props}`, so what arrives is not guaranteed.
 */
export function FilterBar({
  show = [],
  options = {},
  filters = {},
  setFilters,
  loading,
  brands = [],
  selectedBrands = [],
  onBrandChange,
  onNeedOptions,
  tools,
}) {
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }))
  const visible = SLICERS.filter((s) => show.includes(s.id))

  const anyApplied =
    visible.some((s) => (filters[s.key] ?? []).length > 0) ||
    (show.includes('prepStatus') && (filters.prepStatus ?? []).length > 0) ||
    (show.includes('date') &&
      (filters.dateFrom !== filters.defaultFrom || filters.dateTo !== filters.defaultTo))

  const resetAll = () =>
    setFilters((f) => ({
      ...f,
      brands: [],
      locations: [],
      products: [],
      articles: [],
      items: [],
      recipeGroups: [],
      nodeTypes: [],
      categories: [],
      supply: [],
      channels: [],
      transferStatus: [],
      varianceFlags: [],
      oracleRecipes: [],
      prepStatus: [],
      dateFrom: f.defaultFrom,
      dateTo: f.defaultTo,
    }))

  /*
   * THE NEW FILTERS CONTROL — 20 Nov 2026.
   *
   * Behind a flag, and the switch lives HERE rather than in App.jsx: this
   * component's props are unchanged, so no page had to be touched to adopt it
   * and setting NEW_FILTERS back to false restores the old bar everywhere at
   * once. It is the same `visible` list, the same state and the same
   * `setFilters` - only the chrome differs.
   */
  if (NEW_FILTERS) {
    const rows = []

    if (brands.length > 1) {
      rows.push({
        id: 'brand',
        label: 'Brand',
        Icon: IconSummary,
        sub: selectedBrands.length ? `${selectedBrands.length}` : 'All',
        render: () => (
          <MultiSelect
            inline
            label="Brand"
            options={brands.map((b) => ({ value: b.code, label: b.label ?? b.code }))}
            value={selectedBrands}
            onChange={(v) => onBrandChange?.(v)}
            placeholder="All"
          />
        ),
      })
    }

    for (const s of visible) {
      const picked = filters[s.key] ?? []
      rows.push({
        id: s.id,
        label: s.label,
        Icon: IconFilter,
        sub: picked.length ? `${picked.length}` : s.placeholder,
        render: () => (
          <MultiSelect
            inline
            label={s.label}
            options={options[s.options] ?? []}
            value={filters[s.key] ?? []}
            onChange={(v) => set({ [s.key]: v })}
            placeholder={s.placeholder}
            loading={loading}
          />
        ),
        // Fetched when the row's sheet opens, exactly as they were when its
        // pill opened. Passed as a callback rather than called here: this runs
        // during render, and firing a fetch from a render pass is how a render
        // loop starts.
        onOpen: () => onNeedOptions?.(s.options),
      })
    }

    if (show.includes('prepStatus')) {
      const picked = filters.prepStatus ?? []
      rows.push({
        id: 'prepStatus',
        label: 'Prep status',
        Icon: IconFilter,
        sub: picked.length ? `${picked.length}` : 'All',
        render: () => (
          <MultiSelect
            inline
            label="Prep status"
            options={options.prepStatus ?? []}
            value={filters.prepStatus ?? []}
            onChange={(v) => set({ prepStatus: v })}
            placeholder="All"
          />
        ),
      })
    }

    if (show.includes('date')) {
      rows.push({
        id: 'date',
        label: 'Date',
        Icon: IconCalendar,
        sub: dateSummary(filters, options),
        render: () => (
          <DateRange
            inline
            from={filters.dateFrom}
            to={filters.dateTo}
            min={options.dateRange?.min}
            max={options.dateRange?.max}
            today={options.dateRange?.today}
            onChange={(dateFrom, dateTo) => set({ dateFrom, dateTo })}
          />
        ),
      })
    }

    const count =
      visible.reduce((n, s) => n + ((filters[s.key] ?? []).length ? 1 : 0), 0) +
      (selectedBrands.length ? 1 : 0) +
      (show.includes('prepStatus') && (filters.prepStatus ?? []).length ? 1 : 0) +
      (show.includes('date') &&
      (filters.dateFrom !== filters.defaultFrom || filters.dateTo !== filters.defaultTo)
        ? 1
        : 0)

    return (
      <>
        <FiltersPill
          rows={rows}
          summary={pillSummary({ filters, options, visible, selectedBrands, brands, show })}
          count={count}
          onReset={() => {
            resetAll()
            onBrandChange?.([])
          }}
        />
        {tools}
      </>
    )
  }

  return (
    <div className="filters" role="group" aria-label="Filters">
      <BrandPicker brands={brands} selected={selectedBrands} onChange={onBrandChange} />

      {visible.map((s) => (
        <MultiSelect
          key={s.id}
          label={s.label}
          options={options[s.options] ?? []}
          value={filters[s.key] ?? []}
          onChange={(v) => set({ [s.key]: v })}
          placeholder={s.placeholder}
          loading={loading}
          onOpen={() => onNeedOptions?.(s.options)}
        />
      ))}

      {show.includes('prepStatus') && (
        <MultiSelect
          label="Prep status"
          options={options.prepStatus ?? []}
          value={filters.prepStatus ?? []}
          onChange={(v) => set({ prepStatus: v })}
          placeholder="All"
          onOpen={() => onNeedOptions?.('prepStatus')}
        />
      )}

      {show.includes('date') && (
        <DateRange
          from={filters.dateFrom}
          to={filters.dateTo}
          min={options.dateRange?.min}
          max={options.dateRange?.max}
          today={options.dateRange?.today}
          onChange={(dateFrom, dateTo) => set({ dateFrom, dateTo })}
        />
      )}

      <div className="filters__spacer" />

      {loading && (
        <span className="busy">
          <span className="busy__spin" />
          Updating
        </span>
      )}

      {anyApplied && (
        <button type="button" className="btn btn--ghost" onClick={resetAll}>
          Reset
        </button>
      )}

      {/*
        * A page's own control, beside the reset rather than adrift below it.
        *
        * Stock Article puts its guide link here. It belongs with the filters
        * because that is what it explains, and a button on a row of its own
        * read as a stray element rather than as part of the bar.
        */}
      {tools}
    </div>
  )
}
