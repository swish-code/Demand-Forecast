/**
 * A slicer you can search OR pick from, matching on two fields at once.
 *
 * Built for the Sales Plan forecast table, where a product is known by its name
 * to one reader and by its PLU to another, and an article by its name or its
 * article number. A free-text box already existed and it only narrowed what was
 * on screen; this is the other half — a list you can tick, so "these four
 * articles" is a selection rather than a search term that happens to match them.
 *
 * Deliberately not a library. It is a button, a text input and a list of
 * checkboxes; the three behaviours worth getting right are that typing filters
 * on EITHER field, that the chosen ones stay visible while you type, and that
 * Escape and a click outside both close it without losing the selection.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

const norm = (v) => String(v ?? '').trim().toLowerCase()

export function Picker({
  id,
  label,
  /** `[{ value, label, code }]` — `label` and `code` are both searchable. */
  options,
  /** Selected `value`s. */
  selected,
  onChange,
  /** What the button says when nothing is chosen. */
  allLabel = 'All',
  placeholder = 'Search name or number…',
  /** Guards the list against a pathological option count. */
  limit = 400,
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const wrap = useRef(null)
  const search = useRef(null)

  // Close on Escape or a click anywhere else, and put the caret in the box on
  // open so the common case - type three letters, tick one - needs no aiming.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const onDown = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    search.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const chosen = useMemo(() => new Set(selected ?? []), [selected])

  /*
   * What the list shows: everything matching the query, plus everything already
   * ticked. Without the second part a selection scrolls out of reach the moment
   * you type, and un-ticking it means clearing the box first.
   */
  const shown = useMemo(() => {
    const needle = norm(q)
    const list = options.filter(
      (o) => chosen.has(o.value) || !needle || norm(o.label).includes(needle) || norm(o.code).includes(needle)
    )
    list.sort((a, b) => {
      const ax = chosen.has(a.value) ? 0 : 1
      const bx = chosen.has(b.value) ? 0 : 1
      return ax - bx || String(a.label).localeCompare(String(b.label))
    })
    return list.slice(0, limit)
  }, [options, q, chosen, limit])

  const hidden = options.length - shown.length

  const toggle = (value) => {
    const next = new Set(chosen)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange([...next])
  }

  const button = chosen.size === 0 ? allLabel : `${chosen.size} selected`

  return (
    <div className="pick" ref={wrap}>
      <span className="pick__lbl" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        id={id}
        className={`field__input pick__btn${chosen.size ? ' pick__btn--on' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label`}
        onClick={() => setOpen((v) => !v)}
        title={
          chosen.size
            ? options
                .filter((o) => chosen.has(o.value))
                .map((o) => o.label)
                .join(', ')
            : allLabel
        }
      >
        <span className="pick__btntext">{button}</span>
        <span className="pick__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="pick__pop" role="dialog" aria-labelledby={`${id}-label`}>
          <input
            ref={search}
            id={`${id}-search`}
            className="field__input pick__search"
            type="search"
            value={q}
            placeholder={placeholder}
            onChange={(e) => setQ(e.target.value)}
            aria-label={`${label} — search`}
          />

          <div className="pick__list" role="listbox" aria-multiselectable="true" tabIndex={-1}>
            {shown.length === 0 ? (
              <p className="pick__none">Nothing matches “{q}”.</p>
            ) : (
              shown.map((o) => {
                const on = chosen.has(o.value)
                return (
                  <label key={o.value} className={`pick__row${on ? ' pick__row--on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(o.value)} />
                    <span className="pick__name">{o.label}</span>
                    {o.code ? <span className="pick__code">{o.code}</span> : null}
                  </label>
                )
              })
            )}
          </div>

          <div className="pick__foot">
            <span className="muted">
              {chosen.size ? `${chosen.size} of ${options.length}` : `${options.length} available`}
              {hidden > 0 ? ` · ${hidden} not shown` : ''}
            </span>
            <button
              type="button"
              className="btn btn--sm"
              disabled={!chosen.size}
              onClick={() => onChange([])}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
