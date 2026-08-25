import { useEffect, useRef, useState } from 'react'

/**
 * Anchored popover with outside-click and Escape dismissal. `render` receives a
 * `close` callback so panel contents can dismiss themselves after acting.
 */
export function Popover({ trigger, children, render, align = 'left', panelClassName = '', onOpen }) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)
  const root = useRef(null)

  /*
   * Positioned against the viewport, not the trigger's parent.
   *
   * Panels clip their content to keep their rounded corners, and an absolutely
   * positioned panel inside one is cut off at the edge — which is exactly what
   * happened to Build view, where half the column list disappeared behind the
   * table. Fixed positioning escapes every clipping ancestor; the cost is
   * having to place it by hand and to follow the trigger when the page scrolls.
   */
  useEffect(() => {
    if (!open) return undefined

    const place = () => {
      const r = root.current?.getBoundingClientRect()
      if (!r) return
      const margin = 8
      const below = window.innerHeight - r.bottom - margin
      const above = r.top - margin
      // Flip above the trigger when there is more room there — near the bottom
      // of a long page, dropping downwards would open into nothing.
      const drop = below >= 260 || below >= above
      setBox({
        top: drop ? Math.round(r.bottom + 4) : undefined,
        bottom: drop ? undefined : Math.round(window.innerHeight - r.top + 4),
        left: align === 'right' ? undefined : Math.round(r.left),
        right: align === 'right' ? Math.round(window.innerWidth - r.right) : undefined,
        maxHeight: Math.round((drop ? below : above) - 4),
      })
    }

    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, align])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (root.current && !root.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        root.current?.querySelector('.pop__trigger')?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="pop" ref={root}>
      {trigger({
        open,
        toggle: () =>
          setOpen((o) => {
            // Fired on the way open so a slicer can fetch its values only when
            // somebody actually asks to see them.
            if (!o) onOpen?.()
            return !o
          }),
      })}
      {open && (
        <div
          className={`pop__panel pop__panel--fixed ${panelClassName}`}
          style={
            box
              ? {
                  top: box.top,
                  bottom: box.bottom,
                  left: box.left,
                  right: box.right,
                  maxHeight: box.maxHeight,
                }
              : { visibility: 'hidden' }
          }
        >
          {render ? render({ close: () => setOpen(false) }) : children}
        </div>
      )}
    </div>
  )
}

/**
 * The filter pill: label + value, hairline outline when unset, subtle accent
 * tint when a filter is applied. Deliberately not styled like a form input.
 */
export function FilterTrigger({ label, value, open, toggle, active }) {
  return (
    <button
      type="button"
      className={`pop__trigger${active ? ' pop__trigger--set' : ''}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={toggle}
    >
      <span className="pop__label">{label}:</span>
      <span className="pop__value">{value}</span>
      <Caret />
    </button>
  )
}

function Caret() {
  return (
    <svg
      className="pop__caret"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
