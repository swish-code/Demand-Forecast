import { useEffect, useMemo, useState } from 'react'
import { Empty } from './ui.jsx'
import { Popover } from './Popover.jsx'
import { IconSearch, IconSort, IconArrowUp, IconArrowDown, IconClose, IconCheck, IconColumns } from './Icons.jsx'

/**
 * Sortable, searchable, paginated table — the web equivalent of the report's
 * "RUNRATE" table visuals.
 *
 * Pagination is not cosmetic: the production plan returns ~3,700 rows, and
 * rendering them all at once makes sorting and filtering visibly sluggish.
 * Totals are always computed over the full filtered set, never just the page.
 *
 * columns: [{ key, label, num?, mono?, strong?, render?, renderTotal?, total?: 'sum' | fn, width? }]
 */
export function DataTable({
  columns,
  rows,
  initialSort,
  totals = false,
  maxHeight = 560,
  fill = false,
  searchable = true,
  searchPlaceholder = 'Search…',
  paginate = true,
  onRowClick,
  pageSizes = [50, 100, 250, 'All'],
  /**
   * Give a table an id and readers can choose which columns they want.
   *
   * The choice is kept per table in this browser, because it is a preference
   * about how one person reads rather than anything about the data. A column
   * marked `required` cannot be hidden — hiding the article code would leave
   * rows nothing identifies them by.
   */
  tableId,
  /** Told when the hidden set changes, so a page can react to it. */
  onColumnsChange,
  /**
   * Told what the table is currently showing — the visible columns, in order,
   * and the rows left after the search box.
   *
   * This exists so the CSV button in the panel header can export the view
   * rather than the data behind it. Ticking six columns out of twelve and then
   * downloading all twelve is not an export of what you built.
   */
  onViewChange,
}) {
  const [sort, setSort] = useState(initialSort ?? { key: columns[0]?.key, dir: 'asc' })
  const [query, setQuery] = useState('')
  const [pageSize, setPageSize] = useState(pageSizes[0])
  const [page, setPage] = useState(1)

  const storeKey = tableId ? `df-cols-${tableId}` : null
  const [hidden, setHidden] = useState(() => {
    if (!storeKey) return new Set()
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey) || 'null')
      if (Array.isArray(saved)) return new Set(saved)
      // First visit: honour whatever the table says should start hidden.
      return new Set(columns.filter((c) => c.hiddenByDefault).map((c) => c.key))
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    if (!storeKey) return
    try {
      localStorage.setItem(storeKey, JSON.stringify([...hidden]))
    } catch {
      /* a browser refusing storage should not break the table */
    }
    onColumnsChange?.([...hidden])
  }, [storeKey, hidden])

  const shown = useMemo(
    () => columns.filter((c) => c.required || !hidden.has(c.key)),
    [columns, hidden]
  )

  const toggleColumn = (key) =>
    setHidden((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    // Searches what is on screen. Matching a hidden column would return rows
    // with no visible reason for being there.
    return rows.filter((r) => shown.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q)))
  }, [rows, query, shown])

  const sorted = useMemo(() => {
    if (!sort?.key) return searched
    const dir = sort.dir === 'desc' ? -1 : 1
    return [...searched].sort((a, b) => {
      const x = a[sort.key]
      const y = b[sort.key]
      if (x === y) return 0
      if (x === null || x === undefined || x === '') return 1
      if (y === null || y === undefined || y === '') return -1
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir
    })
  }, [searched, sort])

  /*
   * Keyed on which columns are shown rather than on the array holding them.
   *
   * A caller that rebuilds its `columns` prop each render would otherwise give
   * `shown` a new identity each render, this a new dependency each render, and
   * the parent a state update each render — a loop, from a prop that looks
   * entirely reasonable. Pagination is deliberately not part of the view: the
   * page you are on is where you are reading, not what you asked for.
   */
  const shownKey = shown.map((c) => c.key).join('|')
  useEffect(() => {
    onViewChange?.({
      columns: shown.map(({ key, label }) => ({ key, label })),
      rows: sorted,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shownKey stands for shown
  }, [shownKey, sorted])

  const size = !paginate || pageSize === 'All' ? sorted.length || 1 : Number(pageSize)
  const pageCount = Math.max(1, Math.ceil(sorted.length / size))

  // Keep the page in range when filtering or sorting shrinks the result set.
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount))
  }, [pageCount])
  useEffect(() => {
    setPage(1)
  }, [query, pageSize])

  const start = (page - 1) * size
  const visible = sorted.slice(start, start + size)

  const toggle = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))

  // Totals reflect everything matching the search, not just the current page.
  const totalOf = (col) => {
    if (!col.total) return null
    if (typeof col.total === 'function') return col.total(sorted)
    return sorted.reduce((acc, r) => acc + (Number(r[col.key]) || 0), 0)
  }

  // Fixed layout needs a floor, otherwise narrow viewports crush every column;
  // the wrapper scrolls horizontally past it. The unsized name column gets a
  // modest 160px floor and grows into whatever space is left, so a table inside
  // a half-width panel still fits its last column instead of clipping it.
  /**
   * The width below which the table starts scrolling sideways.
   *
   * A column with no width set is the flexible one — it takes whatever is left
   * over. Counting it at its rendered size made it a floor as well as a
   * stretch, and a table whose columns all fit still scrolled: the branch table
   * needed 620px inside a 612px panel, overflowing by eight, purely because its
   * accuracy column claimed 160 it did not need.
   */
  const FLEXIBLE_MIN = 116
  const minWidth = shown.reduce((a, c) => a + (c.width || FLEXIBLE_MIN), 0)

  if (!rows.length) return <Empty />

  const picker = storeKey ? (
    <Popover
      align="right"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={`worklab${hidden.size ? ' worklab--on' : ''}`}
          aria-expanded={open}
          onClick={toggle}
          title="Build your own view of this table"
        >
          <IconColumns size={13} />
          <span className="worklab__label">Build view</span>
          <span className="worklab__count">
            {shown.length}/{columns.length}
          </span>
        </button>
      )}
      render={() => (
        <>
          <div className="worklab__head">
            <div>
              <b>Build your view</b>
              <span>Tick the columns you want. Your choice is remembered on this device.</span>
            </div>
            <button
              type="button"
              className="pop__link"
              disabled={!hidden.size}
              onClick={() => setHidden(new Set())}
            >
              Reset
            </button>
          </div>
          <div className="pop__list">
            {columns.map((c) => {
              const on = c.required || !hidden.has(c.key)
              return (
                <button
                  key={c.key}
                  type="button"
                  className="opt opt--button"
                  disabled={Boolean(c.required)}
                  title={c.required ? 'Always shown' : undefined}
                  onClick={() => toggleColumn(c.key)}
                >
                  <span className={`opt__box${on ? ' opt__box--on' : ''}`} aria-hidden="true">
                    {on && <IconCheck size={10} />}
                  </span>
                  <span className="opt__text">{c.label}</span>
                  {c.required ? (
                    <span className="opt__code">always</span>
                  ) : c.costly ? (
                    <span className="opt__code" title="Turning this on splits each row by this field">
                      splits rows
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          <div className="pop__foot">
            {shown.length} of {columns.length} columns shown
            {columns.some((c) => c.costly && !hidden.has(c.key)) && (
              <span className="worklab__note">splits rows — more detail, more lines</span>
            )}
          </div>
        </>
      )}
    />
  ) : null

  return (
    <>
      {(searchable || picker) && (
        <div className="tbar">
          <div className="pager__spacer" />
          {query && <span className="pager__info">{sorted.length.toLocaleString()} match</span>}
          {picker}
          {searchable && (
          <label className="tsearch">
            <IconSearch size={12} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label="Search table"
            />
            {query && (
              <button
                type="button"
                className="btn btn--ghost btn--icon"
                onClick={() => setQuery('')}
                aria-label="Clear table search"
              >
                <IconClose size={10} />
              </button>
            )}
          </label>
          )}
        </div>
      )}

      {sorted.length === 0 ? (
        <Empty title="No rows match your search">Clear the search box to see all {rows.length.toLocaleString()} rows.</Empty>
      ) : (
        <div
          className={`tablewrap${fill ? ' tablewrap--fill' : ''}`}
          style={fill ? undefined : { maxHeight }}
        >
          <table className="dt" style={{ minWidth }}>
            <thead>
              <tr>
                {shown.map((c) => {
                  const on = sort.key === c.key
                  const Arrow = sort.dir === 'asc' ? IconArrowUp : IconArrowDown
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className={`${c.num ? 'num th--num' : ''}`}
                      style={c.width ? { width: c.width } : undefined}
                      onClick={() => toggle(c.key)}
                      aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <span className="th__inner">
                        {c.label}
                        <span className={`th__sort${on ? '' : ' th__sort--idle'}`}>
                          {on ? <Arrow size={12} /> : <IconSort size={12} />}
                        </span>
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>

            <tbody>
              {visible.map((row, i) => (
                <tr
                  key={shown.map((c) => row[c.key]).join('|') + (start + i)}
                  className={onRowClick ? 'clickable' : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {shown.map((c) => (
                    <td
                      key={c.key}
                      className={[c.num ? 'num' : '', c.id ? 'id' : '', c.strong ? 'strong' : '']
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {c.render ? c.render(row[c.key], row) : (row[c.key] ?? '–')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>

            {totals && (
              <tfoot>
                <tr>
                  {shown.map((c, i) => {
                    const value = totalOf(c)
                    return (
                      <td key={c.key} className={c.num ? 'num' : undefined}>
                        {i === 0
                          ? 'Total'
                          : value === null
                            ? ''
                            : c.renderTotal
                              ? c.renderTotal(value)
                              : c.render
                                ? c.render(value, {})
                                : value}
                      </td>
                    )
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {paginate && sorted.length > 0 && (
        <div className="pager">
          <span className="pager__info">
            {(start + 1).toLocaleString()}–{Math.min(start + size, sorted.length).toLocaleString()} of{' '}
            {sorted.length.toLocaleString()} · Page {page} / {pageCount}
          </span>

          <div className="pager__spacer" />

          <button type="button" className="btn" disabled={page <= 1} onClick={() => setPage(1)}>
            ← First
          </button>
          <button type="button" className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ‹ Prev
          </button>
          <button
            type="button"
            className="btn"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next ›
          </button>
          <button
            type="button"
            className="btn"
            disabled={page >= pageCount}
            onClick={() => setPage(pageCount)}
          >
            Last →
          </button>
        </div>
      )}
    </>
  )
}
