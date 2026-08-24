import { useState } from 'react'
import { Popover } from './Popover.jsx'
import { IconCheck } from './Icons.jsx'
import { brandLogo, brandZoom } from '../brands.js'

/**
 * How much to crop, given how big the chip is.
 *
 * The zoom in the brand list is set for the 52px chips on the sign-in page,
 * where cutting the white margin off Yelo or BBT is what makes the mark fill
 * the square. At 16px the same crop shows a fragment of a letter rather than a
 * logo, so it eases back toward showing the whole thing — smaller but
 * recognisable beats larger but unidentifiable.
 */
const cropFor = (code, size) => {
  const zoom = brandZoom(code)
  if (size >= 40 || zoom <= 1) return zoom
  return 1 + (zoom - 1) * (size >= 22 ? 0.55 : 0.35)
}

/**
 * Brand mark, falling back to the code chip if the file is missing — an
 * un-supplied logo should never break the picker.
 */
export function BrandMark({ code, size = 20 }) {
  const [failed, setFailed] = useState(false)
  const src = brandLogo(code)
  if (!code || !src || failed) return <span className="brandpick__code">{code ?? '—'}</span>
  return (
    <span className="brandpick__chip" style={{ height: size, width: size }}>
      <img
        className="brandpick__logo"
        src={src}
        alt=""
        style={{ transform: `scale(${cropFor(code, size)})` }}
        onError={() => setFailed(true)}
      />
    </span>
  )
}

/**
 * Brand selector — multi-select.
 *
 * Each brand is a separate semantic model, so this decides what the whole page
 * queries rather than filtering a column, which is why it leads the filter row
 * instead of sitting among the slicers. Picking several runs the same query
 * against each model and adds the results up; quantities add, and percentages
 * are recomputed from the totals rather than averaged.
 *
 * At least one brand stays selected: with none there is nothing to query, so
 * unticking the last one is refused rather than showing an empty page.
 */
export function BrandPicker({ brands = [], selected = [], onChange }) {
  if (brands.length < 2) return null

  const picked = brands.filter((b) => selected.includes(b.code))
  const lead = picked[0] ?? brands[0]
  const label =
    picked.length === 0
      ? 'Select brand'
      : picked.length === 1
        ? lead.label
        : `${picked.length} brands`

  const toggle = (code) => {
    const next = selected.includes(code)
      ? selected.filter((c) => c !== code)
      : [...selected, code]
    if (next.length) onChange(next)
  }

  return (
    <Popover
      trigger={({ open, toggle: t }) => (
        <button type="button" className="brandpick" aria-expanded={open} onClick={t}>
          {picked.length === 1 ? (
            <BrandMark code={lead.code} />
          ) : (
            <span className="brandpick__stack" aria-hidden="true">
              {picked.slice(0, 3).map((b) => (
                <BrandMark code={b.code} size={18} key={b.code} />
              ))}
            </span>
          )}
          <span className="brandpick__label">{label}</span>
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}
      render={() => (
        <>
          <div className="pop__head">
            <b>Brands</b>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button
                type="button"
                className="pop__link"
                disabled={picked.length === brands.length}
                onClick={() => onChange(brands.map((b) => b.code))}
              >
                Select all
              </button>
              <button
                type="button"
                className="pop__link"
                disabled={picked.length <= 1}
                onClick={() => onChange([lead.code])}
              >
                Just one
              </button>
            </div>
          </div>
          <div className="pop__list" role="listbox" aria-multiselectable="true">
            {brands.map((b) => {
              const on = selected.includes(b.code)
              const last = on && selected.length === 1
              return (
                <button
                  key={b.code}
                  type="button"
                  className="opt opt--button"
                  disabled={last}
                  title={last ? 'At least one brand has to stay selected' : b.label}
                  onClick={() => toggle(b.code)}
                >
                  <span className={`opt__box${on ? ' opt__box--on' : ''}`} aria-hidden="true">
                    {on && <IconCheck size={10} />}
                  </span>
                  <BrandMark code={b.code} size={24} />
                  <span className="opt__text">{b.label}</span>
                  <span className="opt__code">{b.code}</span>
                </button>
              )
            })}
          </div>
          <div className="pop__foot">
            {picked.length === 1
              ? 'One model queried'
              : `${picked.length} models queried and added together`}
          </div>
        </>
      )}
    />
  )
}
