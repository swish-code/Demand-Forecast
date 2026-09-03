import { MultiSelect } from './MultiSelect.jsx'
import { DateRange } from './DateRange.jsx'
import { BrandPicker } from './BrandPicker.jsx'

/**
 * A single row of filter pills. `show` lists the slicers this page carries,
 * mirroring the corresponding Power BI report page:
 *
 *   brand | location | product | article | item |
 *   nodeType (production type) | prepStatus | date
 *
 * Each pill reads "Label: value"; unset pills read "All".
 */

const SLICERS = [
  { id: 'location', key: 'locations', label: 'Location', options: 'locations', placeholder: 'All' },
  { id: 'product', key: 'products', label: 'Product', options: 'products', placeholder: 'All' },
  { id: 'article', key: 'articles', label: 'Product PLU', options: 'articles', placeholder: 'All' },
  // Same filter, named rather than numbered. The production plan is read by
  // branch staff, who know the product but not its article code.
  { id: 'articleName', key: 'articles', label: 'Product PLU', options: 'articleNames', placeholder: 'All' },
  { id: 'item', key: 'items', label: 'Component', options: 'items', placeholder: 'All' },
  { id: 'nodeType', key: 'nodeTypes', label: 'Prod. type', options: 'nodeTypes', placeholder: 'All' },
  /*
   * Where an article's stock comes from.
   *
   * Two fixed values rather than a list read from a model: it is derived from
   * whether the warehouse has issued the article in six months, so there is
   * nothing to look up and no third answer.
   */
  { id: 'supply', key: 'supply', label: 'Supply', options: 'supply', placeholder: 'All' },
]

export function FilterBar({ show, options, filters, setFilters, loading, brands, selectedBrands, onBrandChange, onNeedOptions }) {
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
      supply: [],
      prepStatus: [],
      dateFrom: f.defaultFrom,
      dateTo: f.defaultTo,
    }))

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
    </div>
  )
}
