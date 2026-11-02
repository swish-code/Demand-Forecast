import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { FilterBar, SLICERS } from './FilterBar.jsx'
import { activeChips } from '../activeFilters.js'
import { SideNav } from './SideNav.jsx'
import { IconClose, IconMenu, IconFilter } from './Icons.jsx'

/**
 * The small-screen chrome: a navigation drawer and a filter sheet.
 *
 * WHY THIS EXISTS AS ONE SHARED COMPONENT
 *
 * Both problems it solves are problems of the SHELL, not of any page: the rail
 * is 76px of a 440px phone whatever page is open, and the slicer tray is the
 * same six dropdowns everywhere. Fixing them per page would have produced nine
 * inconsistent workarounds, so they are fixed once here and every page inherits
 * the result.
 *
 * WHY IT RENDERS AT EVERY WIDTH
 *
 * Nothing here is conditional on a JavaScript breakpoint. The components mount
 * always and CSS decides whether they are seen - `display: none` on the desktop
 * side, shown only inside `@media (max-width: 640px)`.
 *
 * That is deliberate and it is what makes a rotation safe. A JS breakpoint
 * would unmount this subtree when a tablet turns landscape, and unmounting is
 * how filter state gets lost. Here the state never moves: it lives in App, and
 * both the desktop bar and this sheet are views onto the same object.
 *
 * NO FILTER LOGIC LIVES HERE
 *
 * The sheet renders `<FilterBar>` - the same component the desktop row uses,
 * with the same props and the same handlers. The drawer renders `<SideNav>` the
 * same way. This file contributes a container, a button and a summary; it does
 * not know what a filter means, and it cannot drift from the desktop behaviour
 * because there is only one implementation of that behaviour.
 */

/* -------------------------------------------------------------- the sheet -- */

/**
 * Shared behaviour for the drawer and the sheet: escape to close, a locked
 * background, and focus that goes in and comes back.
 *
 * Scroll is locked on `body` rather than on the shell, because iOS Safari
 * scrolls the document behind a fixed overlay regardless of what the element
 * under it says.
 */
function useOverlay(open, onClose) {
  const restoreTo = useRef(null)
  const panel = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    restoreTo.current = document.activeElement
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)

    // After paint, so the panel exists to receive it.
    const id = requestAnimationFrame(() => panel.current?.focus())

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
      cancelAnimationFrame(id)
      // Back where they were, so closing the sheet does not dump the reader at
      // the top of the document.
      const back = restoreTo.current
      if (back && typeof back.focus === 'function') back.focus()
    }
  }, [open, onClose])

  return panel
}

/* ---------------------------------------------------------- filter sheet -- */

export function MobileFilters(props) {
  const { filters, show = [], brands = [], selectedBrands = [], dateLabel } = props
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const panel = useOverlay(open, close)
  const titleId = useId()

  const chips = useMemo(
    () => activeChips({ filters, show, brands, selectedBrands, slicers: SLICERS }),
    [filters, show, brands, selectedBrands]
  )
  const count = chips.length

  return (
    <>
      <div className="mbar" role="group" aria-label="Filters">
        <div className="mbar__row">
          <button
            type="button"
            className={`mbar__btn${count ? ' mbar__btn--on' : ''}`}
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <IconFilter size={14} />
            Filters
            {count > 0 && <span className="mbar__badge">{count}</span>}
          </button>
          {dateLabel && <span className="mbar__date">{dateLabel}</span>}
        </div>

        {chips.length > 0 && (
          /* One scrollable row, so a long selection never wraps the bar into a
             second line and pushes the page down again - which is the defect
             this whole bar exists to remove. */
          <div className="mbar__chips">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                className="mbar__chip"
                onClick={() => setOpen(true)}
                title="Change filters"
              >
                {c.text}
              </button>
            ))}
          </div>
        )}
      </div>

      {open && (
        <div className="msheet" role="presentation">
          <div className="msheet__scrim" onClick={close} aria-hidden="true" />
          <div
            className="msheet__panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            ref={panel}
          >
            <div className="msheet__head">
              <span className="msheet__grab" aria-hidden="true" />
              <h2 className="msheet__title" id={titleId}>
                Filters
              </h2>
              <button type="button" className="msheet__x" onClick={close} aria-label="Close filters">
                <IconClose size={16} />
              </button>
            </div>

            <div className="msheet__body">
              {/*
                * The DESKTOP filter bar, rendered inside a sheet.
                *
                * Same component, same props, same handlers - so a change made
                * here is the identical state change it would be on a desktop,
                * and Reset is the identical reset. The sheet contributes layout
                * and nothing else.
                */}
              <FilterBar {...props} />
            </div>

            <div className="msheet__foot">
              <button type="button" className="btn btn--primary msheet__done" onClick={close}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------- nav drawer -- */

export function MobileNav(props) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const panel = useOverlay(open, close)
  const titleId = useId()

  return (
    <>
      <button
        type="button"
        className="mnav__open"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Open navigation"
      >
        <IconMenu size={18} />
      </button>

      {open && (
        <div className="mnav" role="presentation">
          <div className="mnav__scrim" onClick={close} aria-hidden="true" />
          <div
            className="mnav__panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            ref={panel}
          >
            <div className="mnav__head">
              <h2 className="mnav__title" id={titleId}>
                Menu
              </h2>
              <button type="button" className="mnav__x" onClick={close} aria-label="Close navigation">
                <IconClose size={16} />
              </button>
            </div>
            {/*
              * The same SideNav, never collapsed.
              *
              * `collapsed` is forced off and the toggle withheld: inside a
              * drawer there is room for the labels, and a rail-within-a-drawer
              * is the narrow column this pattern exists to escape.
              *
              * Permissions are untouched - `pages` arrives already filtered by
              * the shell, so the drawer can only ever list what the account may
              * open.
              */}
            <SideNav
              {...props}
              collapsed={false}
              onToggle={null}
              onSelect={(id) => {
                props.onSelect?.(id)
                close()
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}
