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
/**
 * Measures text the way the browser will actually draw it.
 *
 * Counting characters and multiplying by a nominal advance is close for "Salt"
 * and wrong by 40px for "TISSUE Z FOLD - MISHMASH", because a capital M is
 * nearly three times the width of a lower-case l. A column sized that way still
 * truncates the names it was widened for, which is the one thing it exists to
 * prevent.
 *
 * One canvas, reused, and one `measureText` per cell — cheap enough for a few
 * thousand rows and exact. The font is read from the document so it follows the
 * theme rather than restating it here; the header is measured in the weight and
 * size headers are actually drawn at.
 */
let ctx = null
function textMeasurer() {
  if (!ctx && typeof document !== 'undefined') {
    ctx = document.createElement('canvas').getContext('2d')
  }
  if (!ctx) return (t) => String(t).length * 7.1

  const family =
    (typeof getComputedStyle !== 'undefined' &&
      getComputedStyle(document.body).fontFamily) ||
    'system-ui, sans-serif'

  return (text, header = false) => {
    // Headers are 10px, uppercase and letter-spaced; body text is 12px.
    ctx.font = header ? `500 10px ${family}` : `500 12px ${family}`
    const w = ctx.measureText(text).width
    return header ? w + text.length * 0.7 : w
  }
}

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
  /**
   * Titles for the shaded column groups, keyed by the `group` on each column.
   *
   * Supplying this adds a row above the headers spanning each run of grouped
   * columns. The shading says these belong together; the title says what they
   * belong to, which the shading alone cannot.
   */
  groups,
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
    // `Boolean` first, deliberately. A stray comma in a caller's column list
    // leaves a hole in the array, and reading `.required` off the undefined it
    // produces took the entire page down with a blank screen — a whole class of
    // white-screen crash that one guard removes.
    () => columns.filter(Boolean).filter((c) => c.required || !hidden.has(c.key)),
    [columns, hidden]
  )

  /*
   * Where a shaded group starts and ends, among the columns actually visible.
   *
   * Computed here rather than declared on the column, because hiding one of a
   * group's members moves its edges: shade three columns and hide the middle
   * one and the block is now two blocks, which should look like two blocks.
   */
  const edges = useMemo(() => {
    const map = new Map()
    shown.forEach((c, i) => {
      if (!c.group) return
      map.set(c.key, {
        start: shown[i - 1]?.group !== c.group,
        end: shown[i + 1]?.group !== c.group,
      })
    })
    return map
  }, [shown])

  /*
   * The header row above the headers: one cell per run of adjacent columns.
   *
   * Runs rather than groups, because a group is only a block while its members
   * are adjacent — and the reader can hide one from the middle. Ungrouped runs
   * still get a cell so the row has the same number of columns as the one under
   * it; theirs is simply empty.
   */
  const groupRuns = useMemo(() => {
    const runs = []
    for (const c of shown) {
      const g = c.group ?? null
      const last = runs[runs.length - 1]
      if (last && last.group === g) last.span += 1
      else runs.push({ group: g, span: 1 })
    }
    return runs
  }, [shown])

  const hasGroupRow = Boolean(groups) && groupRuns.some((r) => r.group && groups[r.group])

  const groupClass = (c) => {
    if (!c.group) return ''
    const e = edges.get(c.key)
    return `dt--${c.group}${e?.start ? ' dt--gstart' : ''}${e?.end ? ' dt--gend' : ''}`
  }

  /*
   * Column widths the reader can drag, and keep.
   *
   * The table is `table-layout: fixed`, so a long article name is cut off at
   * whatever width the column was given — and no single width suits both
   * "Salt" and "Sticker White For Yelo Pizza - Chili Flakes". Rather than guess
   * wider and waste the space on every other row, the edge between two headers
   * can be dragged, and where it is dragged to is remembered per table on this
   * device, like the column choice above it.
   */
  // Versioned: widths saved before the article column became the flexible one
  // were absolute, and restoring one as a floor would pin it at whatever it was
  // dragged to back when dragging it stretched the whole table.
  const widthKey = tableId ? `df-widths2-${tableId}` : null
  const [widths, setWidths] = useState(() => {
    if (!widthKey) return {}
    try {
      const saved = JSON.parse(localStorage.getItem(widthKey) || 'null')
      return saved && typeof saved === 'object' ? saved : {}
    } catch {
      return {}
    }
  })

  /*
   * Columns that size themselves to their longest value.
   *
   * `table-layout: fixed` means a column is exactly as wide as it is told, so a
   * fixed width either truncates "Sticker White For Yelo Pizza - Chili Flakes"
   * or wastes that width on every row reading "Salt". Measuring the column's
   * own contents picks a width that fits this particular result set, and it
   * re-measures when a slicer changes what is in it.
   *
   * Characters times a nominal advance rather than real text metrics: it is one
   * cheap pass over the rows instead of a layout per cell, and being a few
   * pixels generous is invisible where being short is not. The cap matters as
   * much as the width — one 90-character name should not push every other
   * column off the screen; past it the cell wraps, and the reader can still
   * drag the edge, which continues to win over anything computed here.
   */
  const autoWidths = useMemo(() => {
    const out = {}
    const measure = textMeasurer()
    for (const c of shown) {
      if (!c.autoWidth) continue
      const opts = c.autoWidth === true ? {} : c.autoWidth
      // 16px of padding each side, plus room for the sort icon in the header.
      const { min = 72, max = 640, pad = 32 + 18 } = opts
      // The header is very often the widest thing in a numeric column, so it is
      // the starting point rather than an afterthought.
      let widest = measure(String(c.label ?? '').toUpperCase(), true)

      if (c.num) {
        /*
         * One format call, not one per row.
         *
         * The widest formatted number is the one with the largest magnitude, so
         * the maximum is found on the raw values and only that one is rendered
         * and measured. Formatting every cell of every numeric column to
         * measure it would be tens of thousands of calls each time a slicer
         * moves, to learn one number.
         */
        let peak = null
        for (const r of rows) {
          const v = Number(r[c.key])
          if (!Number.isFinite(v)) continue
          if (peak === null || Math.abs(v) > Math.abs(peak)) peak = v
        }
        if (peak !== null) {
          const shown = c.render ? c.render(peak, {}) : peak
          const text = typeof shown === 'string' || typeof shown === 'number' ? String(shown) : String(peak)
          const w = measure(text)
          if (w > widest) widest = w
        }
      } else {
        for (const r of rows) {
          const w = measure(String(r[c.key] ?? ''))
          if (w > widest) widest = w
        }
      }

      out[c.key] = Math.round(Math.min(max, Math.max(min, widest + pad)))
    }
    return out
  }, [shown, rows])

  /*
   * Every column is exactly as wide as it says, and a spacer takes the rest.
   *
   * `table-layout: fixed` on a table set to `width: 100%` distributes leftover
   * space by scaling every sized column, so dragging one edge moved all of
   * them. Leaving one column unsized fixed that, but made *that* column the one
   * that swallows the slack — and the article column cannot both hug its
   * longest name and stretch to fill the row.
   *
   * So an empty cell is appended to every row instead. It has no width, so it
   * absorbs whatever is left; it has no content, no border and no background,
   * so it reads as the table simply ending. When the real columns overflow it
   * collapses to nothing and the table scrolls, as before.
   *
   * The result is the behaviour asked for: the article column is exactly as
   * wide as its longest name, and dragging any column changes that column
   * alone.
   */
  const widthOf = (c) => widths[c.key] ?? autoWidths[c.key] ?? c.width

  const startResize = (event, col) => {
    // The header is a sort button; dragging its edge is not a click on it.
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    const startWidth = event.currentTarget.parentElement?.offsetWidth ?? col.width ?? 140
    const MIN = 64

    const move = (e) => {
      const next = Math.max(MIN, Math.round(startWidth + (e.clientX - startX)))
      setWidths((prev) => (prev[col.key] === next ? prev : { ...prev, [col.key]: next }))
    }
    const done = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', done)
      document.body.classList.remove('resizing')
    }

    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', done)
  }

  useEffect(() => {
    if (!widthKey) return
    try {
      localStorage.setItem(widthKey, JSON.stringify(widths))
    } catch {
      /* a browser refusing storage should not break the table */
    }
  }, [widthKey, widths])

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
  /*
   * The flexible column counts at its floor, not at zero.
   *
   * It has no width, so `widthOf` gives nothing for it — but it still needs
   * room, and this sum is what decides when the table starts scrolling
   * sideways. Counting its measured width here is what stops a long article
   * name being squeezed out by the columns beside it.
   */
  const minWidth = shown.reduce((a, c) => a + (widthOf(c) || FLEXIBLE_MIN), 0)

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
          <table
            className={`dt${hasGroupRow ? ' dt--grouped' : ''}`}
            style={{ minWidth }}
          >
            {/*
              * Widths declared here, not on the header cells.
              *
              * `table-layout: fixed` takes its column widths from the first row
              * of the table — and once a group-title row was added above the
              * headers, that first row was cells spanning three columns each.
              * The browser then split each span's width across the columns
              * under it and ignored what those columns actually asked for, so
              * widening the article column widened everything in its group.
              *
              * A `colgroup` outranks both rows and is the only place a fixed
              * layout will take a per-column width from unconditionally. The
              * spacer is left `auto` so it, and only it, absorbs the slack.
              */}
            <colgroup>
              {shown.map((c) => (
                <col key={c.key} style={widthOf(c) ? { width: widthOf(c) } : undefined} />
              ))}
              <col />
            </colgroup>
            <thead>
              {hasGroupRow && (
                <tr className="dt__grouprow">
                  {groupRuns.map((r, i) => (
                    <th
                      key={`${r.group ?? 'none'}-${i}`}
                      colSpan={r.span}
                      scope="colgroup"
                      className={
                        r.group
                          ? `dt--${r.group} dt--gstart dt--gend dt__grouphead`
                          : 'dt__grouphead'
                      }
                    >
                      {r.group ? groups[r.group] : ''}
                    </th>
                  ))}
                  <th className="dt__spacer" aria-hidden="true" />
                </tr>
              )}
              <tr>
                {shown.map((c) => {
                  const on = sort.key === c.key
                  const Arrow = sort.dir === 'asc' ? IconArrowUp : IconArrowDown
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className={`${c.num ? 'num th--num' : ''} ${groupClass(c)}`.trim()}
                      onClick={() => toggle(c.key)}
                      aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <span className="th__inner">
                        {c.label}
                        <span className={`th__sort${on ? '' : ' th__sort--idle'}`}>
                          {on ? <Arrow size={12} /> : <IconSort size={12} />}
                        </span>
                      </span>
                      <span
                        className="th__grip"
                        role="separator"
                        aria-label={`Resize ${c.label}`}
                        title="Drag to resize · double-click to reset"
                        onMouseDown={(e) => startResize(e, c)}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          setWidths((prev) => {
                            const next = { ...prev }
                            delete next[c.key]
                            return next
                          })
                        }}
                      />
                    </th>
                  )
                })}
                {/* Takes the leftover width so no real column is scaled. */}
                <th className="dt__spacer" aria-hidden="true" />
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
                      className={[
                        c.num ? 'num' : '',
                        c.id ? 'id' : '',
                        c.strong ? 'strong' : '',
                        // Columns that belong together are shaded together, so
                        // the relationship reads without a legend.
                        groupClass(c),
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {c.render ? c.render(row[c.key], row) : (row[c.key] ?? '–')}
                    </td>
                  ))}
                  <td className="dt__spacer" />
                </tr>
              ))}
            </tbody>

            {totals && (
              <tfoot>
                <tr>
                  {shown.map((c, i) => {
                    const value = totalOf(c)
                    return (
                      <td
                        key={c.key}
                        className={[c.num ? 'num' : '', groupClass(c)].filter(Boolean).join(' ')}
                      >
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
                  <td className="dt__spacer" />
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
