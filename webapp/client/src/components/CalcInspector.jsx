/**
 * Click a visual, see the measures behind it — the Power BI inspect gesture,
 * on this app's own pages.
 *
 * The first attempt at this was a list of every formula in the application,
 * parked on the Admin page. It was accurate and useless: somebody looking at a
 * number that seems wrong is looking at *that* number, and asking them to go to
 * another page and find it in a list of twenty is most of the work they wanted
 * help with.
 *
 * So the panel lives on the page it describes. Turn it on and every visual that
 * has declared its formulas becomes selectable; click one and the drawer shows
 * exactly what feeds it — the DAX for a model measure, the arithmetic for
 * anything the app works out itself, and all of them when a visual uses more
 * than one.
 *
 * Visuals declare their own formulas through a `calc` prop, which becomes a
 * `data-calc` attribute. Nothing here maintains a map of where things are: the
 * page is the map, so a visual that moves takes its formulas with it and a
 * visual that is deleted cannot leave a stale entry behind.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { IconClose } from './Icons.jsx'
import { Pill } from './ui.jsx'

const TONE = {
  'Power BI measure': 'blue',
  'Calculated by this app': 'green',
  'Read from the local copy': 'slate',
}

export function CalcInspector({ open, onClose }) {
  const [catalogue, setCatalogue] = useState(null)
  const [note, setNote] = useState('')
  const [picked, setPicked] = useState(null)
  const [error, setError] = useState(null)
  const scope = useRef(null)

  // Fetched once, the first time it is opened — it is a static catalogue and
  // nothing about it changes while a tab is open.
  useEffect(() => {
    if (!open || catalogue) return
    api.admin
      .calculations()
      .then((d) => {
        setCatalogue(new Map((d.calculations ?? []).map((c) => [c.id, c])))
        setNote(d.note ?? '')
      })
      .catch((err) => setError(err))
  }, [open, catalogue])

  /*
   * While the inspector is open, a click picks a visual instead of using it.
   *
   * Captured on the document so it works whatever the page is made of, and
   * `capture` so it runs before the visual's own handlers — clicking a card to
   * inspect it must not also apply the filter that card would normally apply.
   */
  useEffect(() => {
    if (!open) return
    document.body.classList.add('inspecting')

    const onClick = (e) => {
      const el = e.target.closest?.('[data-calc]')
      if (!el) return
      e.preventDefault()
      e.stopPropagation()
      const ids = String(el.dataset.calc || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
      const label =
        el.querySelector('.panel__titles h2')?.firstChild?.textContent?.trim() ||
        el.querySelector('.metric__label')?.textContent?.trim() ||
        'this visual'
      setPicked({ ids, label })

      // A brief mark on what was chosen, so the drawer and the page agree.
      document.querySelectorAll('.calcpick').forEach((n) => n.classList.remove('calcpick'))
      el.classList.add('calcpick')
      scope.current = el
    }

    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.body.classList.remove('inspecting')
      document.querySelectorAll('.calcpick').forEach((n) => n.classList.remove('calcpick'))
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /*
   * Everything on the page that has declared a formula, so the panel is useful
   * before anything has been clicked. Read from the DOM rather than from a
   * registry for the same reason the attribute exists at all.
   */
  const onPage = useMemo(() => {
    if (!open || !catalogue) return []
    const ids = new Set()
    document.querySelectorAll('[data-calc]').forEach((el) => {
      String(el.dataset.calc || '')
        .split(',')
        .forEach((v) => v.trim() && ids.add(v.trim()))
    })
    return [...ids].map((id) => catalogue.get(id)).filter(Boolean)
  }, [open, catalogue, picked])

  if (!open) return null

  const shown = picked
    ? picked.ids.map((id) => catalogue?.get(id)).filter(Boolean)
    : onPage

  return (
    <aside className="calcpanel" aria-label="Calculations on this page">
      <header className="calcpanel__head">
        <div>
          <h2 className="calcpanel__title">Calculations</h2>
          <p className="calcpanel__sub">
            {picked
              ? `${picked.label} — ${shown.length} ${shown.length === 1 ? 'measure' : 'measures'}`
              : 'Click any card, chart or table to see what it is built from'}
          </p>
        </div>
        <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
          <IconClose size={14} />
        </button>
      </header>

      <div className="calcpanel__body">
        {error ? (
          <p className="calcpanel__empty">{error.message}</p>
        ) : !catalogue ? (
          <p className="calcpanel__empty">Loading…</p>
        ) : !shown.length ? (
          <p className="calcpanel__empty">
            {picked
              ? 'This visual has not declared a formula yet.'
              : 'Nothing on this page has declared a formula yet.'}
          </p>
        ) : (
          <>
            {picked && (
              <button type="button" className="btn btn--ghost calcpanel__back" onClick={() => setPicked(null)}>
                ← Everything on this page ({onPage.length})
              </button>
            )}

            {shown.map((c) => (
              <section key={c.id} className="calcpanel__item">
                <div className="calcpanel__itemhead">
                  <span className="calcpanel__label">{c.label}</span>
                  <Pill tone={TONE[c.source] ?? 'slate'}>{c.source}</Pill>
                </div>
                <p className="calcpanel__where">{c.visual}</p>
                <pre className="calc__code">{c.expression}</pre>
                {c.detail && <p className="calc__detail">{c.detail}</p>}
                {c.tunable && (
                  <p className="calc__tunable">
                    <strong>Changeable without Power BI:</strong> {c.tunable}
                  </p>
                )}
              </section>
            ))}

            {note && <p className="calcpanel__note">{note}</p>}
          </>
        )}
      </div>
    </aside>
  )
}
