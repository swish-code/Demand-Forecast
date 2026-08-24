import { useEffect, useRef, useState } from 'react'

/**
 * Anchored popover with outside-click and Escape dismissal. `render` receives a
 * `close` callback so panel contents can dismiss themselves after acting.
 */
export function Popover({ trigger, children, render, align = 'left', panelClassName = '', onOpen }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)

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
        <div className={`pop__panel${align === 'right' ? ' pop__panel--right' : ''} ${panelClassName}`}>
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
