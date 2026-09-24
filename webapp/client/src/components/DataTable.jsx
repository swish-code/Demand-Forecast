import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
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

/**
 * The unrounded value, for a cell that had to round.
 *
 * Quantities are shown as whole numbers once they are big enough that a
 * fraction does not read — but the percentages beside them are computed on the
 * true figures, so a column can honestly show "71", "41" and "24.0%" while
 * 1 − |71−41|/41 is 26.8%. The real numbers were 71.3 and 40.5.
 *
 * Nothing is wrong with either figure; what is missing is any way to check one
 * against the other. Hovering the quantity gives the value the arithmetic
 * actually used, which costs no space and settles the question on the spot.
 */
function exactly(column, value) {
  if (!column?.num) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || Number.isInteger(n)) return undefined
  return String(n)
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
   * Fields the reader may fold the table on, as `[{ key, label }]`.
   *
   * Supplying this adds a "Group by" control. Grouping is a reading aid rather
   * than a filter — every row is still there, gathered under a heading that
   * carries the count and the totals for its group.
   */
  groupable,
  /**
   * Titles for the shaded column groups, keyed by the `group` on each column.
   *
   * Supplying this adds a row above the headers spanning each run of grouped
   * columns. The shading says these belong together; the title says what they
   * belong to, which the shading alone cannot.
   */
  groups,
  /**
   * Pin this many leading columns while the rest scroll under them.
   *
   * For tables wide enough that the identifying columns leave the screen before
   * the interesting ones arrive — Replenishment Planning is 43 columns, so by
   * the time a delivery date is in view there is nothing on the row saying
   * which article it belongs to. Counted in VISIBLE columns, so hiding one
   * through Build view re-pins whatever moved up into its place.
   *
   * Opt-in, and zero everywhere else: sticky cells need an opaque background,
   * which is wrong for a table narrow enough never to scroll sideways.
   */
  freeze = 0,
  /**
   * Let the reader shut a whole shaded group of columns from its heading.
   *
   * Only useful where `groups` is supplied and there are enough of them to be
   * worth putting away. A shut group's columns leave the table entirely rather
   * than collapsing to a stub cell — a stub has to be sized, shaded and
   * explained, and it still costs the width the reader was trying to reclaim.
   * They come back from the chips above the table, which is also what tells
   * somebody a section is missing rather than empty.
   */
  collapsibleGroups = false,
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

  /*
   * Which field the rows are folded on, and which groups are shut.
   *
   * Collapsed rather than expanded is the wrong default here: somebody who has
   * just grouped a table wants to see the shape of it, and a page of closed
   * headings makes them click every one to find out what they did.
   */
  const [groupBy, setGroupBy] = useState(null)
  const [shut, setShut] = useState(() => new Set())
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

  /** Column groups the reader has shut. Never persisted — a view, not a setting. */
  const [shutCols, setShutCols] = useState(() => new Set())

  /*
   * How many leading columns the reader has pinned, or null for the caller's
   * default.
   *
   * Null rather than a number so that "never chosen" stays distinguishable from
   * "chosen to be the same as the default". A table whose `freeze` prop changes
   * later should move for the first reader and stay put for the second.
   *
   * Remembered per table on this device, beside the column choice, because it
   * is the same kind of thing: how one person likes to read this table, not
   * anything about the data.
   */
  const freezeKey = tableId ? `df-freeze-${tableId}` : null
  const [frozen, setFrozen] = useState(() => {
    if (!freezeKey) return null
    try {
      const saved = JSON.parse(localStorage.getItem(freezeKey) ?? 'null')
      return Number.isInteger(saved) && saved >= 0 ? saved : null
    } catch {
      return null
    }
  })

  useEffect(() => {
    if (!freezeKey) return
    try {
      if (frozen === null) localStorage.removeItem(freezeKey)
      else localStorage.setItem(freezeKey, JSON.stringify(frozen))
    } catch {
      /* a browser refusing storage should not break the table */
    }
  }, [freezeKey, frozen])

  const shown = useMemo(
    // `Boolean` first, deliberately. A stray comma in a caller's column list
    // leaves a hole in the array, and reading `.required` off the undefined it
    // produces took the entire page down with a blank screen — a whole class of
    // white-screen crash that one guard removes.
    () =>
      columns
        .filter(Boolean)
        .filter((c) => c.required || !hidden.has(c.key))
        // A required column outranks a shut group: it is required because the
        // row is unreadable without it, and that does not stop being true
        // because its neighbours were put away.
        .filter((c) => c.required || !(c.group && shutCols.has(c.group))),
    [columns, hidden, shutCols]
  )

  /** The visible column keys as one string, for effects that react to them. */
  const shownKey = shown.map((c) => c.key).join('|')

  /*
   * Which groups are currently shut, with what they cost — for the chips that
   * bring them back. Read off `columns` rather than `shown`, because a shut
   * group is by definition absent from `shown`.
   */
  const shutList = useMemo(() => {
    if (!collapsibleGroups || !shutCols.size) return []
    const counted = new Map()
    for (const c of columns.filter(Boolean)) {
      if (!c.group || !shutCols.has(c.group) || c.required) continue
      counted.set(c.group, (counted.get(c.group) ?? 0) + 1)
    }
    return [...counted.entries()].map(([key, n]) => ({ key, n }))
  }, [collapsibleGroups, shutCols, columns])

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
   * A group title is either a string or `{ label, help }`.
   *
   * The help is a list of `{ term, text }` — what each column in the group
   * means, in the words somebody reading the table would use. It hangs off the
   * heading rather than living in a page-level legend because that is where the
   * question gets asked: at the column, while looking at a number.
   */
  const titleOf = (key) => {
    const g = groups?.[key]
    if (typeof g === 'string') return { label: g, help: null }
    const held = g ?? { label: '', help: null }
    /*
     * Only a real list counts as help.
     *
     * `help` is mapped over below, so anything else - most plausibly a single
     * string, which is what the Replenishment Planning groups were written with
     * - rendered the information icon and then threw on the click. One bad
     * value in a group definition took the whole page down to the error
     * boundary. Coerced here instead: a malformed `help` shows no icon, which
     * is a missing explanation rather than a broken page.
     */
    return Array.isArray(held.help) ? held : { ...held, help: null }
  }


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
  const widthKey = tableId ? `df-widths3-${tableId}` : null
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
      /*
       * 16px of cell padding each side. The sort icon is added to the header
       * only — it sits beside the header text, not beside the values, and
       * charging every row for it made the column 18px wider than any name in
       * it needs.
       */
      // Numeric columns get tighter side padding — see the stylesheet. Their
      // width is set by the header almost every time, so every pixel of padding
      // is a pixel of empty column.
      const { min = 72, max = null, percentile = null, pad = c.num ? 20 : 32 } = opts
      // The header is very often the widest thing in a numeric column, so it is
      // the starting point rather than an afterthought.
      let widest = measure(String(c.label ?? '').toUpperCase(), true) + 14

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
      } else if (percentile === null) {
        for (const r of rows) {
          const w = measure(String(r[c.key] ?? '').trim())
          if (w > widest) widest = w
        }
      } else {
        /*
         * Sized to most of the names, not to the longest one.
         *
         * Article names run from 4 characters to 60, and the single 60 was
         * setting the width of all 3,536 rows — 90% of them need barely half
         * that, so nine columns out of ten were empty space. Sizing to the 95th
         * percentile fits almost everything exactly.
         *
         * The few that overflow are not truncated: this column wraps, so a long
         * name takes two lines and is still read in full. That is the only
         * arrangement that satisfies both "never cut off" and "never wider than
         * it needs to be" — one of them has to give, and a second line costs
         * less than 200px of empty column on every other row.
         */
        const all = []
        for (const r of rows) {
          const t = String(r[c.key] ?? '').trim()
          if (t) all.push(measure(t))
        }
        if (all.length) {
          all.sort((x, y) => x - y)
          const at = all[Math.min(all.length - 1, Math.floor(all.length * percentile))]
          if (at > widest) widest = at
        }
      }

      const want = Math.max(min, widest + pad)
      out[c.key] = Math.round(max === null ? want : Math.min(max, want))
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
  /*
   * Only the measured column can be dragged, and only wider.
   *
   * Two rules that read as one: the full article name is always visible, and
   * dragging never disturbs anything else.
   *
   * A dragged width used to win outright, which is why the column went back to
   * truncating the moment it was touched — the saved number outranked the
   * measurement from then on, on every later load, for every later result set.
   * Here it can only raise the floor. Drag it wider and it stays wider; drag it
   * narrower and it stops at the longest name, because that is the one thing
   * this column exists to show.
   *
   * Every other column takes its own width and offers no grip at all, so there
   * is no gesture that can move them.
   */
  /*
   * One column carries no width, and it is the one that can afford to.
   *
   * `table-layout: fixed` on a table set to `width: 100%` has to put leftover
   * space somewhere. Size every column and it scales all of them, so dragging
   * one edge moves the whole table. Add an empty cell to soak it up and the
   * table ends in a band of dead white before the panel does.
   *
   * The column that should take it is the one whose content is open-ended: the
   * article name. Everything else is a number or a short label with a natural
   * width, and no reason to be stretched past it.
   *
   * Its measurement is not discarded — it becomes the floor, fed into
   * `minWidth` below. So the column is never narrower than the names it holds,
   * takes whatever room is going spare, and the table always ends flush with
   * its panel however many columns are switched on.
   */
  const flexKey = shown.find((c) => c.flex)?.key ?? null

  const floorOf = (c) => {
    const measured = autoWidths[c.key]
    if (measured === undefined) return c.width
    const dragged = Number(widths[c.key]) || 0
    return Math.max(measured, dragged)
  }

  const widthOf = (c) => (c.key === flexKey ? undefined : floorOf(c))

  /*
   * Where each pinned column sits, in pixels from the left edge.
   *
   * Taken from the SAME widths the colgroup declares rather than measured off
   * the DOM: the table is `table-layout: fixed`, so those widths are what the
   * browser actually uses, and reading them here means the offsets cannot
   * disagree with the layout or lag a frame behind a drag.
   *
   * A column with no declared width ends the pinning — that is the flex column,
   * which has no fixed left edge to pin anything after it to. Returning the
   * offsets found so far rather than bailing keeps whatever prefix is sound.
   */
  /*
   * How far pinning can legally reach, whatever the reader asks for.
   *
   * Two hard limits, and neither is a preference. A column with no declared
   * width — the flex column — has no fixed left edge, so nothing after it can
   * be offset against it; and pinning every column leaves nothing to scroll,
   * which is a table that simply cannot be read sideways. So the options stop
   * one short of the end, and at the flex column if that comes first.
   */
  /*
   * Where every column actually starts, measured off the rendered header.
   *
   * This was computed from the declared widths, which put a ceiling on what
   * could be pinned: the flex column has no declared width, so the sum stopped
   * there and everything after it was unpinnable. On Article detail the flex
   * column is the SECOND one, so the only offer was "Up to Recipe" — reported
   * on 24 Sep 2026, and the reason was this and not anything about the data.
   *
   * Measuring removes the ceiling rather than working around it: an auto-width
   * column has a real width once it is on screen, and that is the number a
   * sticky offset needs. `offsetWidth` accumulated across the header cells is
   * used rather than `offsetLeft`, because offsetLeft is relative to whichever
   * ancestor happens to be positioned and the scroll container is one.
   */
  const headRow = useRef(null)
  const [colLefts, setColLefts] = useState([])

  useEffect(() => {
    const row = headRow.current
    if (!row) return

    const measure = () => {
      let x = 0
      const lefts = []
      for (const cell of row.children) {
        lefts.push(x)
        x += cell.offsetWidth
      }
      // Replace only on a real change, or this sets state on every observer
      // callback and the observer fires on every layout it causes.
      setColLefts((prev) =>
        prev.length === lefts.length && prev.every((v, i) => v === lefts[i]) ? prev : lefts
      )
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    for (const cell of row.children) ro.observe(cell)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, rows.length, widths, autoWidths])

  /*
   * Pinning still stops one short of the end — freezing every column leaves
   * nothing to scroll, which is a table that cannot be read sideways.
   */
  const freezeMax = Math.max(0, shown.length - 1)

  /*
   * The reader's choice wins over the caller's default, and the ceiling wins
   * over both — a stored "freeze 8" must not break the table on a day when
   * only four columns are shown.
   */
  const freezeCount = Math.min(frozen ?? freeze ?? 0, freezeMax)

  /*
   * Declared after `freezeCount` on purpose: the runs are split at the
   * frozen edge, so this cannot be computed before that edge is known.
   * It sat above it for one revision and crashed the page on render —
   * a `const` read before its declaration is a ReferenceError, and a
   * useMemo body runs immediately, so the dep array alone was enough.
   */
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
    let at = 0
    for (const c of shown) {
      const g = c.group ?? null
      const last = runs[runs.length - 1]
      /*
       * A run is also broken by the frozen edge, not only by a change of group.
       *
       * One cell cannot be half pinned and half scrolling — a colspan has a
       * single left offset — so a group straddling the boundary used to fail
       * the "is it wholly inside the prefix" test and scroll away in one
       * piece, leaving a blank band above the columns that had stayed put.
       * Freezing two of the five Article columns showed it: the title left the
       * screen and nothing replaced it.
       *
       * Splitting at the boundary gives the pinned columns their own titled
       * cell and the scrolling ones theirs, both carrying the group's tint and
       * name — so the section reads as one section on both sides of the seam,
       * which is what AG Grid and Excel do with a split group too.
       */
      const boundary = at === freezeCount
      if (last && last.group === g && !boundary) last.span += 1
      // `at` is where this run starts among the visible columns, which is what
      // decides whether it sits wholly inside the pinned prefix.
      else runs.push({ group: g, span: 1, at })
      at += 1
    }
    return runs
  }, [shown, freezeCount])

  const hasGroupRow =
    Boolean(groups) && groupRuns.some((r) => r.group && titleOf(r.group).label)

  /*
   * The offsets in play: the measured ones, cut to what the reader asked for.
   *
   * Empty until the first measurement lands, so nothing is pinned for one
   * frame after mount. That is the right way round — an unpinned column is
   * merely unpinned, where a column pinned at a guessed offset overlaps its
   * neighbour and hides data.
   */
  const freezeLeft = useMemo(
    () => (freezeCount > 0 ? colLefts.slice(0, freezeCount) : []),
    [freezeCount, colLefts]
  )

  /** Sticky positioning for the i-th visible column, or nothing if not pinned. */
  const freezeCell = (i) =>
    i < freezeLeft.length
      ? {
          className: `dt__frz${i === freezeLeft.length - 1 ? ' dt__frz--last' : ''}`,
          style: { left: `${freezeLeft[i]}px` },
        }
      : null

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
  useEffect(() => {
    onViewChange?.({
      columns: shown.map(({ key, label }) => ({ key, label })),
      rows: sorted,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shownKey stands for shown
  }, [shownKey, sorted])

  /*
   * The rows folded into groups, in the order the sort already put them.
   *
   * Grouping switches pagination off. A page boundary through the middle of a
   * group is meaningless — the heading says "18 articles" and the page shows
   * four of them — and these tables are small enough to render whole.
   */
  const folds = useMemo(() => {
    if (!groupBy) return null
    const out = new Map()
    for (const r of sorted) {
      const raw = r[groupBy]
      const key =
        raw === null || raw === undefined || raw === ''
          ? '—'
          : typeof raw === 'boolean'
            ? raw ? 'Yes' : 'No'
            : String(raw)
      if (!out.has(key)) out.set(key, [])
      out.get(key).push(r)
    }
    return [...out.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [sorted, groupBy])

  const size = !paginate || groupBy || pageSize === 'All' ? sorted.length || 1 : Number(pageSize)
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
  /*
   * The flexible column counts at its floor, not at nothing.
   *
   * It has no width, so `widthOf` gives none for it — but it still needs room,
   * and this sum is what decides when the table starts scrolling sideways
   * instead of squeezing. Counting its measured width here is what stops the
   * article names being crushed as more columns are switched on.
   */
  const minWidth = shown.reduce(
    (a, c) => a + (c.key === flexKey ? floorOf(c) || FLEXIBLE_MIN : widthOf(c) || FLEXIBLE_MIN),
    0
  )

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
      {(searchable || picker || groupable?.length || freezeMax > 0) && (
        <div className="tbar">
          <div className="pager__spacer" />
          {query && <span className="pager__info">{sorted.length.toLocaleString()} match</span>}

          {groupable?.length ? (
            <label className="tgroup">
              <span>Group by</span>
              <select
                value={groupBy ?? ''}
                onChange={(e) => {
                  setGroupBy(e.target.value || null)
                  // A new grouping opens fresh; last time's shut headings are
                  // about a different set of groups.
                  setShut(new Set())
                }}
              >
                <option value="">Nothing</option>
                {groupable.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {picker}
          {/*
            * Freezing is a toolbar control, not a setting behind a panel.
            *
            * It lived inside "Build view" first and nobody found it — which is
            * the right verdict: it changes how the table is READ, in the same
            * way "Group by" does, and both belong where they can be seen
            * without opening anything.
            *
            * Phrased "up to X" because pinning is a prefix: a sticky cell is
            * offset from the left edge, so freezing the seventh column while
            * the sixth still scrolls would slide one under the other. Excel and
            * Sheets say it the same way, for the same reason.
            */}
          {freezeMax > 0 ? (
            <label className={`tgroup tfreeze${freezeCount ? ' tfreeze--on' : ''}`}>
              <span title="Keep the left-hand columns in place while the rest scroll sideways">
                Freeze
              </span>
              <select
                value={String(freezeCount)}
                onChange={(e) => setFrozen(Number(e.target.value))}
                title="Choose the last column that stays put while the rest scroll"
              >
                <option value="0">None</option>
                {shown.slice(0, freezeMax).map((c, i) => (
                  <option key={c.key} value={String(i + 1)}>
                    Up to {c.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
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

      {/*
        * What has been put away, and the way back.
        *
        * A shut group leaves no trace inside the table - that is the point of
        * shutting it - so without this the columns are simply gone and the only
        * cure is a reload. The chip carries the count, because "Deliveries" and
        * "Deliveries (18)" are different offers.
        */}
      {shutList.length ? (
        <div className="dt__shutbar">
          <span className="dt__shutlbl">Hidden sections</span>
          {shutList.map((g) => (
            <button
              key={g.key}
              type="button"
              className="dt__shutchip"
              onClick={() =>
                setShutCols((prev) => {
                  const next = new Set(prev)
                  next.delete(g.key)
                  return next
                })
              }
              title={`Show the ${titleOf(g.key).label} columns again`}
            >
              {titleOf(g.key).label}
              <span className="dt__shutn">{g.n}</span>
              <span aria-hidden="true">+</span>
            </button>
          ))}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setShutCols(new Set())}
          >
            Show all
          </button>
        </div>
      ) : null}

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
            </colgroup>
            <thead>
              {hasGroupRow && (
                <tr className="dt__grouprow">
                  {groupRuns.map((r, i) => {
                    /*
                     * A split group's controls belong to one of its halves.
                     *
                     * Splitting at the frozen edge can give one group two
                     * cells, and rendering the help icon and the collapse
                     * button on both reads as two sections that happen to
                     * share a name. The first cell carries them; the second
                     * carries the title and the tint, which is what says
                     * "still the same section".
                     */
                    const lead = groupRuns.findIndex((x) => x.group === r.group) === i
                    return (
                    <th
                      key={`${r.group ?? 'none'}-${i}`}
                      colSpan={r.span}
                      scope="colgroup"
                      /*
                       * Pinned when the whole run sits inside the prefix, at
                       * its own left offset — runs are split at the boundary
                       * above, so this is now always true or always false for
                       * a given run, never partly.
                       */
                      style={
                        r.at + r.span <= freezeLeft.length
                          ? { left: `${freezeLeft[r.at]}px` }
                          : undefined
                      }
                      className={[
                        r.group ? `dt--${r.group} dt--gstart dt--gend` : '',
                        'dt__grouphead',
                        r.at + r.span <= freezeLeft.length ? 'dt__frz' : '',
                        r.at + r.span === freezeLeft.length ? 'dt__frz--last' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {r.group ? (
                        <span className="dt__grouptitle">
                          {titleOf(r.group).label}
                          {lead && titleOf(r.group).help ? (
                            <Popover
                              align="left"
                              panelClassName="pop--help"
                              trigger={({ toggle }) => (
                                <button
                                  type="button"
                                  className="dt__help"
                                  onClick={(e) => {
                                    // The heading is not a sort target, but the
                                    // cell around it still swallows clicks.
                                    e.stopPropagation()
                                    toggle()
                                  }}
                                  aria-label={`How ${titleOf(r.group).label} is calculated`}
                                  title={`How ${titleOf(r.group).label} is calculated`}
                                >
                                  !
                                </button>
                              )}
                              render={() => (
                                <div className="help">
                                  <h3 className="help__title">{titleOf(r.group).label}</h3>
                                  <dl className="help__list">
                                    {titleOf(r.group).help.map((h) => (
                                      <Fragment key={h.term}>
                                        <dt>{h.term}</dt>
                                        <dd>
                                          {h.text}
                                          {/*
                                            * The sum itself, written the way
                                            * somebody would say it. A reader
                                            * asking how a number was reached
                                            * wants the arithmetic, not a
                                            * paraphrase of it.
                                            */}
                                          {h.formula ? <span className="help__sum">{h.formula}</span> : null}
                                          {h.example ? (
                                            <span className="help__eg">
                                              <b>Example</b> {h.example}
                                            </span>
                                          ) : null}
                                        </dd>
                                      </Fragment>
                                    ))}
                                  </dl>
                                </div>
                              )}
                            />
                          ) : null}
                          {/*
                             * A group may refuse to be collapsible.
                             *
                             * The section that identifies the row is the one
                             * case: putting it away leaves a table of numbers
                             * with nothing saying what they are about. Its
                             * columns can still be hidden one at a time from
                             * Build view, which is a deliberate act rather
                             * than a side effect of tidying a section away.
                             */}
                          {lead && collapsibleGroups && titleOf(r.group).collapsible !== false ? (
                            <button
                              type="button"
                              className="dt__gshut"
                              onClick={(e) => {
                                e.stopPropagation()
                                setShutCols((prev) => new Set(prev).add(r.group))
                              }}
                              aria-label={`Hide the ${titleOf(r.group).label} columns`}
                              title={`Hide the ${titleOf(r.group).label} columns`}
                            >
                              &minus;
                            </button>
                          ) : null}
                        </span>
                      ) : (
                        ''
                      )}
                    </th>
                    )
                  })}
                </tr>
              )}
              <tr ref={headRow}>
                {shown.map((c, ci) => {
                  const on = sort.key === c.key
                  const Arrow = sort.dir === 'asc' ? IconArrowUp : IconArrowDown
                  const frz = freezeCell(ci)
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      style={frz?.style}
                      className={`${c.num ? 'num th--num' : ''} ${groupClass(c)} ${frz?.className ?? ''}`.trim()}
                      /*
                       * A column can explain itself on hover.
                       *
                       * Asked for on 16 Sep 2026. Shortening a header to "SS
                       * qty" or "DTL" only works if the long version is still
                       * reachable, and the header is where a reader looks for
                       * it - the cell tooltips underneath explain one value,
                       * not what the column is. Optional, so every existing
                       * table is unaffected.
                       */
                      title={c.hint || undefined}
                      onClick={() => toggle(c.key)}
                      aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <span className="th__inner">
                        {c.label}
                        <span className={`th__sort${on ? '' : ' th__sort--idle'}`}>
                          {on ? <Arrow size={12} /> : <IconSort size={12} />}
                        </span>
                      </span>
                      {c.autoWidth && (
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
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>

            <tbody>
              {folds
                ? folds.map(([key, rows]) => {
                    const open = !shut.has(key)
                    return (
                      <Fragment key={key}>
                        <tr className="dt__grouprow-body">
                          <th colSpan={shown.length} scope="colgroup">
                            <button
                              type="button"
                              className="dt__grouptoggle"
                              aria-expanded={open}
                              onClick={() =>
                                setShut((prev) => {
                                  const next = new Set(prev)
                                  next.has(key) ? next.delete(key) : next.add(key)
                                  return next
                                })
                              }
                            >
                              <span className={`dt__caret${open ? ' dt__caret--open' : ''}`} aria-hidden="true" />
                              {key}
                              <span className="dt__groupcount">{rows.length}</span>
                              {/*
                                * The group's own totals, on the heading.
                                *
                                * A collapsed group that shows only a count makes
                                * somebody open it to learn anything, which is the
                                * work collapsing was meant to save.
                                */}
                              {shown
                                .filter((c) => c.num && c.total === 'sum')
                                .slice(0, 3)
                                .map((c) => (
                                  <span key={c.key} className="dt__groupsum">
                                    {c.label}{' '}
                                    <b>
                                      {(c.renderTotal ?? c.render ?? String)(
                                        rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0),
                                        {}
                                      )}
                                    </b>
                                  </span>
                                ))}
                            </button>
                          </th>
                        </tr>
                        {open &&
                          rows.map((row, i) => (
                            <tr
                              key={shown.map((c) => row[c.key]).join('|') + i}
                              className={onRowClick ? 'clickable' : undefined}
                              onClick={onRowClick ? () => onRowClick(row) : undefined}
                            >
                              {shown.map((c, ci) => (
                                <td
                                  key={c.key}
                                  style={freezeCell(ci)?.style}
                                  className={[c.num ? 'num' : '', c.id ? 'id' : '', c.strong ? 'strong' : '', c.wrap ? 'dt--wrap' : '', groupClass(c), freezeCell(ci)?.className]
                                    .filter(Boolean)
                                    .join(' ')}
                                  title={exactly(c, row[c.key])}
                                >
                                  {c.render ? c.render(row[c.key], row) : (row[c.key] ?? '–')}
                                </td>
                              ))}
                            </tr>
                          ))}
                      </Fragment>
                    )
                  })
                : visible.map((row, i) => (
                <tr
                  key={shown.map((c) => row[c.key]).join('|') + (start + i)}
                  className={onRowClick ? 'clickable' : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {shown.map((c, ci) => (
                    <td
                      key={c.key}
                      style={freezeCell(ci)?.style}
                      className={[
                        c.num ? 'num' : '',
                        c.id ? 'id' : '',
                        c.strong ? 'strong' : '',
                        c.wrap ? 'dt--wrap' : '',
                        freezeCell(ci)?.className,
                        // Columns that belong together are shaded together, so
                        // the relationship reads without a legend.
                        groupClass(c),
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      title={exactly(c, row[c.key])}
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
                      <td
                        key={c.key}
                        /* Pinned in the totals row too, or the totals slide out
                           from under the columns they belong to. */
                        style={freezeCell(i)?.style}
                        className={[c.num ? 'num' : '', groupClass(c), freezeCell(i)?.className]
                          .filter(Boolean)
                          .join(' ')}
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
