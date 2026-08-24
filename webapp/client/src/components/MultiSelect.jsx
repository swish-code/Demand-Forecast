import { useMemo, useState } from 'react'
import { Popover, FilterTrigger } from './Popover.jsx'
import { IconSearch, IconCheck } from './Icons.jsx'

/**
 * Dropdown slicer: searchable checkbox list with select-all / clear.
 * An empty selection means "no filter", matching a Power BI slicer with
 * nothing ticked.
 *
 * Options are either bare strings or `{ value, label, hint }`. The second form
 * exists for slicers whose stored value is not what a person would recognise —
 * the article slicer filters on a numeric code but shows the product name, with
 * the code as the hint, so both search terms find the same row.
 */

/** Bare strings and rich options are handled by the same code below. */
const norm = (o) =>
  o !== null && typeof o === 'object'
    ? { value: o.value, label: String(o.label ?? o.value), hint: o.hint ? String(o.hint) : '' }
    : { value: o, label: String(o), hint: '' }
export function MultiSelect({
  label,
  options = [],
  value = [],
  onChange,
  placeholder = 'All',
  single = false,
  loading = false,
  onOpen,
}) {
  const [search, setSearch] = useState('')

  const items = useMemo(() => options.map(norm), [options])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (o) => o.label.toLowerCase().includes(q) || o.hint.toLowerCase().includes(q)
    )
  }, [items, search])

  const selected = useMemo(() => new Set(value.map(String)), [value])

  const toggle = (item, close) => {
    const key = String(item.value)
    if (single) {
      onChange(selected.has(key) ? [] : [item.value])
      close()
      return
    }
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    // Rebuilt from the full list, so the emitted order stays stable regardless
    // of what the search box happened to be showing when a box was ticked.
    onChange(items.filter((o) => next.has(String(o.value))).map((o) => o.value))
  }

  // A single selection is named, not counted — "SALT" beats "1 selected".
  const labelOf = (v) => items.find((o) => String(o.value) === String(v))?.label ?? String(v)
  const summary =
    value.length === 0 ? placeholder : value.length === 1 ? labelOf(value[0]) : `${value.length} selected`

  return (
    <Popover
      onOpen={onOpen}
      trigger={({ open, toggle: t }) => (
        <FilterTrigger
          label={label}
          value={summary}
          open={open}
          toggle={t}
          active={value.length > 0}
        />
      )}
      render={({ close }) => (
        <>
          <div className="pop__head">
            <b>{label}</b>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              {!single && (
                <button
                  type="button"
                  className="pop__link"
                  disabled={!filtered.length}
                  onClick={() => onChange(filtered.map((o) => o.value))}
                >
                  Select all
                </button>
              )}
              <button
                type="button"
                className="pop__link"
                disabled={!value.length}
                onClick={() => onChange([])}
              >
                Clear
              </button>
            </div>
          </div>

          {options.length > 7 && (
            <label className="pop__search">
              <IconSearch size={14} />
              <input
                placeholder={`Search ${label.toLowerCase()}…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </label>
          )}

          <div className="pop__list" role="listbox" aria-label={label} aria-multiselectable={!single}>
            {loading && <div className="pop__empty">Loading…</div>}
            {!loading && filtered.length === 0 && (
              <div className="pop__empty">{options.length ? 'No matches' : 'No values available'}</div>
            )}
            {filtered.slice(0, 500).map((option) => {
              const on = selected.has(String(option.value))
              return (
                <label
                  className="opt"
                  key={String(option.value)}
                  title={option.hint ? `${option.label} · ${option.hint}` : option.label}
                >
                  <input
                    type={single ? 'radio' : 'checkbox'}
                    checked={on}
                    onChange={() => toggle(option, close)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <span
                    className={`opt__box${on ? ' opt__box--on' : ''}${single ? ' opt__box--radio' : ''}`}
                    aria-hidden="true"
                  >
                    {on && <IconCheck size={11} />}
                  </span>
                  <span className="opt__text">{option.label}</span>
                  {option.hint && <span className="opt__hint">{option.hint}</span>}
                </label>
              )
            })}
          </div>

          <div className="pop__foot">
            {filtered.length > 500
              ? `Showing first 500 of ${filtered.length.toLocaleString()} — narrow with search`
              : `${filtered.length.toLocaleString()} value${filtered.length === 1 ? '' : 's'}`}
            {value.length > 0 && <span style={{ marginLeft: 'auto' }}>{value.length} selected</span>}
          </div>
        </>
      )}
    />
  )
}
