import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevron, IconClose, IconFilter, IconRefresh } from './Icons.jsx'

/**
 * The Filters control: one pill, a panel, and a flyout per filter.
 *
 * Replaces the row of filter pills that used to sit across the top bar. It is
 * the supplied spec's chrome, wrapped around THIS app's pickers rather than
 * around new ones: every flyout holds the existing `MultiSelect` or
 * `DateRange`, rendered `inline` so the sheet is the only popover. No filter,
 * option list, selection or request changes here - only the trigger, the
 * panel, and how the pickers open.
 *
 * WHY THE HIGHLIGHT AND THE FLYOUT POSITION ARE WRITTEN AS STYLES, NOT STATE.
 * The pointer crosses a row dozens of times a second. Re-rendering the panel
 * on each of those would re-render every picker inside it, including lists of
 * several thousand options. The sliding card is moved by writing a transform
 * onto one element, and React is not told.
 */

const HOVER_MQ = '(hover: hover) and (min-width: 821px)'
const canHover = () =>
  typeof window !== 'undefined' && window.matchMedia?.(HOVER_MQ).matches

/**
 * The white card that glides under whichever row the pointer is over.
 *
 * Shared by the panel and by each flyout - the same gesture in both places -
 * which is why it is a hook rather than two copies of four lines.
 */
function useSlideHl(selector) {
  const hl = useRef(null)
  const onMouseOver = (e) => {
    const el = e.target.closest?.(selector)
    const h = hl.current
    if (!el || !h || !e.currentTarget.contains(el) || !el.offsetHeight) return
    h.style.transform = `translate(${el.offsetLeft - 6}px, ${el.offsetTop}px)`
    h.style.width = `${el.offsetWidth + 12}px`
    h.style.height = `${el.offsetHeight}px`
    h.style.opacity = '1'
  }
  const onMouseLeave = () => {
    if (hl.current) hl.current.style.opacity = '0'
  }
  return { hl, onMouseOver, onMouseLeave }
}

/**
 * One filter's picker, in its own sheet beside the panel.
 *
 * Portalled to `<body>` and positioned `fixed` against its row, because the
 * panel clips its own overflow - a sheet rendered inside it would be cut off
 * at the panel's edge, and a tall one could not reach past the viewport.
 */
function Flyout({ anchorRow, children, onMouseEnter, onMouseLeave }) {
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    const place = () => {
      const btn = document.querySelector(`[data-row="${anchorRow}"]`)
      const panel = document.getElementById('topbar-filters')
      if (!btn || !panel) return
      const r = btn.getBoundingClientRect()
      const left = panel.getBoundingClientRect().left
      setPos({
        position: 'fixed',
        top: Math.max(8, Math.round(r.top - 6)),
        right: Math.round(window.innerWidth - left + 10),
        zIndex: 6000,
      })
    }
    place()
    window.addEventListener('resize', place)
    // Capture, so a scroll in ANY container under the pointer repositions it.
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchorRow])

  if (!pos) return null
  return createPortal(
    <div
      className="pick-sheet"
      style={pos}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  )
}

/**
 * @param {object}   props
 * @param {Array}    props.rows      [{ id, label, Icon, sub, render() }]
 * @param {string}   props.summary   what the pill says is selected
 * @param {number}   props.count     how many filters are set, for the badge
 * @param {Function} props.onReset
 */
export function FiltersPill({ rows, summary, count = 0, onReset }) {
  const [open, setOpen] = useState(false)
  const [hoverRow, setHoverRow] = useState(null)
  const wrap = useRef(null)
  const hoverT = useRef(null)
  const rowT = useRef(null)
  const openedAt = useRef(0)
  const panelHl = useSlideHl('.filters-row')

  const enter = () => {
    if (!canHover()) return
    clearTimeout(hoverT.current)
    hoverT.current = null
    if (!open) openedAt.current = Date.now()
    setOpen(true)
  }

  /*
   * A click just after a hover-open must not shut it again.
   *
   * The pointer opens the panel on its way to the pill; the click that was
   * already on its way then arrives and would toggle it closed, so the panel
   * blinks. Within 700ms of a hover-open, or whenever it is already open, a
   * click is treated as "keep it open".
   */
  const click = () => {
    if (canHover() && (Date.now() - openedAt.current < 700 || open)) {
      setOpen(true)
      return
    }
    setOpen((v) => !v)
  }

  /** Is the reader typing in a search box inside the panel or a sheet? */
  const typing = () => {
    const a = document.activeElement
    return Boolean(
      a &&
        /^(INPUT|TEXTAREA)$/.test(a.tagName) &&
        !/^(checkbox|radio|button)$/i.test(a.type || '') &&
        a.closest('.filters-wrap, .pick-sheet')
    )
  }

  /*
   * Close once the pointer has been somewhere else for 240ms.
   *
   * `mouseover` on the document rather than `mouseleave` on the panel: the
   * flyouts are portalled to <body> and are not inside the panel, so leaving
   * the panel for a sheet is leaving the element but not the control. Coming
   * back cancels the pending close.
   *
   * It never closes while someone is typing - a search box losing its panel
   * mid-word is the most annoying version of this bug.
   */
  useEffect(() => {
    if (!open) return undefined
    const inside = (t) =>
      Boolean(
        t &&
          t.nodeType === 1 &&
          ((wrap.current && wrap.current.contains(t)) || t.closest('.pick-sheet'))
      )
    const over = (e) => {
      if (!canHover()) return
      if (inside(e.target)) {
        clearTimeout(hoverT.current)
        hoverT.current = null
        return
      }
      if (hoverT.current) return
      hoverT.current = setTimeout(() => {
        hoverT.current = null
        if (!typing()) setOpen(false)
      }, 240)
    }
    document.addEventListener('mouseover', over)
    return () => document.removeEventListener('mouseover', over)
  }, [open])

  /* Escape, and the body class that lifts the top bar above the scrim. */
  useEffect(() => {
    document.body.classList.toggle('mfilters-open', open)
    if (!open) return () => document.body.classList.remove('mfilters-open')
    const k = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', k)
    return () => {
      document.removeEventListener('keydown', k)
      document.body.classList.remove('mfilters-open')
    }
  }, [open])

  /* A closed panel has no open row. */
  useEffect(() => {
    if (!open) {
      clearTimeout(rowT.current)
      setHoverRow(null)
    }
  }, [open])

  /*
   * Tell a row its sheet has opened, so it can fetch its options.
   *
   * From an effect, after the row is open - the lists are lazily loaded and
   * firing that from a render pass is how a render loop starts.
   */
  useEffect(() => {
    if (!hoverRow) return
    rows.find((r) => r.id === hoverRow)?.onOpen?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows are rebuilt each render
  }, [hoverRow])

  useEffect(() => () => {
    clearTimeout(hoverT.current)
    clearTimeout(rowT.current)
  }, [])

  /*
   * 110ms in, 280ms out. In, so that running the pointer down the rows does
   * not fire five sheets on the way past; out, so the gap between a row and
   * its sheet can be crossed without the sheet vanishing underneath it.
   */
  const rowHover = (id) =>
    !(open && canHover())
      ? {}
      : {
          onMouseEnter: () => {
            clearTimeout(rowT.current)
            rowT.current = setTimeout(() => setHoverRow(id), 110)
          },
          onMouseLeave: () => {
            clearTimeout(rowT.current)
            rowT.current = setTimeout(
              () => setHoverRow((c) => (c === id ? null : c)),
              280
            )
          },
        }

  const keepSheet = () => clearTimeout(rowT.current)
  const leaveSheet = () => {
    clearTimeout(rowT.current)
    rowT.current = setTimeout(() => setHoverRow(null), 280)
  }

  return (
    <>
      <div className="filters-wrap" ref={wrap} onMouseEnter={enter}>
        <button
          type="button"
          className={`filters-toggle${open ? ' on' : ''}`}
          onClick={click}
          aria-expanded={open}
          aria-controls="topbar-filters"
        >
          <span className="filters-ic">
            <IconFilter size={15} />
          </span>
          <span className="filters-lbl">Filters</span>
          {summary && <span className="filters-sum">{summary}</span>}
          {count > 0 && <span className="filters-count">{count}</span>}
          {/* Reserves the space the clear button is absolutely placed into,
              so it never sits on top of the chevron. */}
          {count > 0 && <span className="filters-xgap" aria-hidden="true" />}
          <IconChevron size={14} className="filters-caret" />
        </button>

        {count > 0 && (
          <button
            type="button"
            className="filters-clear"
            aria-label="Clear filters"
            onClick={(e) => {
              e.stopPropagation()
              onReset()
            }}
          >
            <IconClose size={13} />
          </button>
        )}

        <div
          id="topbar-filters"
          className={`topbar-filters${open ? ' open' : ''}`}
          onMouseOver={panelHl.onMouseOver}
          onMouseLeave={panelHl.onMouseLeave}
        >
          {rows.map((r) => (
            <div key={r.id} className="filters-row" {...rowHover(r.id)}>
              <button
                type="button"
                className="frow"
                data-row={r.id}
                aria-expanded={hoverRow === r.id}
                onClick={() => setHoverRow((c) => (c === r.id ? null : r.id))}
              >
                <span className="frow-ic">{r.Icon ? <r.Icon size={16} /> : null}</span>
                <span className="frow-lbl">{r.label}</span>
                {r.sub && <span className="frow-sub">{r.sub}</span>}
                <IconChevron size={14} className="frow-caret" />
              </button>

              {hoverRow === r.id && (
                <Flyout anchorRow={r.id} onMouseEnter={keepSheet} onMouseLeave={leaveSheet}>
                  {r.render()}
                </Flyout>
              )}
            </div>
          ))}

          <button
            type="button"
            className="filters-reset"
            onClick={onReset}
            disabled={count === 0}
          >
            <IconRefresh size={13} />
            <span>Reset filters</span>
          </button>

          <span ref={panelHl.hl} className="filters-hl" aria-hidden="true" />
        </div>
      </div>

      {/* Transparent on a desktop, dimmed on a phone. Either way it is what
          makes a click anywhere else close the panel. */}
      {open &&
        createPortal(
          <div className="mfilters-scrim" onClick={() => setOpen(false)} />,
          document.body
        )}
    </>
  )
}
