import { useEffect, useState } from 'react'
import { api, fmtInt } from '../api.js'
import { IconClose } from './icons.jsx'

/**
 * "Is this article in the forecast, and if not, why?"
 *
 * The page's own search box filters the rows already on screen, which cannot
 * answer that question — an article that is not on the page returns nothing
 * whichever reason applies. Somebody comparing a warehouse outbound sheet
 * against the page then reports it missing, and three unrelated situations
 * arrive as the same empty search:
 *
 *   - it is on the page, but they searched the name and the two systems spell
 *     it differently (468 of 488 reported cases, measured on 10 Sep 2026)
 *   - the warehouse has never issued it, so there is no history to forecast
 *   - it only ever goes to the central kitchen, so no brand shows it
 *
 * This asks the server directly, whether or not the article is on the page, and
 * shows the twelve-month history behind the answer so the reader can check it
 * themselves rather than take our word for it.
 */
export function ArticleFinder({ onClose }) {
  const [term, setTerm] = useState('')
  const [q, setQ] = useState('')
  const [state, setState] = useState({ loading: false, data: null, error: null })

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Typed queries settle before they are sent: the master is a few thousand
  // rows and a keystroke is not a question.
  useEffect(() => {
    const id = setTimeout(() => setQ(term.trim()), 350)
    return () => clearTimeout(id)
  }, [term])

  useEffect(() => {
    if (q.length < 2) {
      setState({ loading: false, data: null, error: null })
      return undefined
    }
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    api
      .articleLookup(q)
      .then((data) => live && setState({ loading: false, data, error: null }))
      .catch((error) => live && setState({ loading: false, data: null, error }))
    return () => {
      live = false
    }
  }, [q])

  const { data, loading, error } = state
  const many = data?.matches?.length > 1

  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__card modal__card--wide" role="dialog" aria-modal="true" aria-label="Find an article">
        <div className="modal__head">
          <div>
            <h2 className="modal__title">Find an article</h2>
            <span className="modal__sub">
              Check whether an article is in the forecast, and see the twelve months behind the answer
            </span>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body">
          <label className="finder__field">
            <span>Article number or name</span>
            <input
              type="search"
              value={term}
              autoFocus
              placeholder="e.g. 106800040, or Ketchup Sachet"
              onChange={(e) => setTerm(e.target.value)}
            />
            <span className="finder__hint">
              The article number is the reliable key — names differ between systems.
            </span>
          </label>

          {error ? (
            <p className="finder__note finder__note--bad">{error.message}</p>
          ) : loading ? (
            <p className="finder__note">Looking…</p>
          ) : !data ? null : many ? (
            <div className="finder__list">
              <p className="finder__note">
                {data.matches.length} articles match. Pick the one you mean:
              </p>
              {data.matches.map((m) => (
                <button key={m.article} type="button" className="finder__row" onClick={() => setTerm(m.article)}>
                  <span className="finder__no">{m.article}</span>
                  <span className="finder__name">{m.name}</span>
                  <span className="finder__unit">{m.unit}</span>
                </button>
              ))}
            </div>
          ) : data.verdict === 'unknown-article' ? (
            <div className="finder__verdict finder__verdict--bad">
              <strong>Not a warehouse article</strong>
              <p>{data.explain}</p>
            </div>
          ) : data.article ? (
            <>
              <div
                className={`finder__verdict finder__verdict--${data.forecast ? 'good' : 'warn'}`}
              >
                <strong>
                  {data.forecast ? 'In the forecast' : 'Not in the forecast'}
                  {' — '}
                  {data.article} {data.name}
                </strong>
                <p>{data.explain}</p>
              </div>

              <div className="finder__facts">
                <div>
                  <span className="finder__label">Article status</span>
                  <span className="finder__value">{data.status?.label ?? '–'}</span>
                </div>
                <div>
                  <span className="finder__label">Named by a recipe</span>
                  <span className="finder__value">{data.inRecipe ? 'Yes' : 'No'}</span>
                </div>
                <div>
                  <span className="finder__label">Months shipped, of 12</span>
                  <span className="finder__value">{data.shippedMonths}</span>
                </div>
                <div>
                  <span className="finder__label">Total shipped, 12 months</span>
                  <span className="finder__value">{fmtInt(data.total)} {data.unit}</span>
                </div>
              </div>

              {data.destinations?.length > 0 && (
                <>
                  <h3 className="finder__h">Where it goes</h3>
                  <div className="finder__dests">
                    {data.destinations.map((d) => (
                      <div key={d.bucket} className="finder__dest">
                        <span>{d.bucket}</span>
                        <span>{fmtInt(d.qty)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <h3 className="finder__h">What the warehouse issued, month by month</h3>
              <div className="finder__months">
                {data.months.map((m) => {
                  const peak = Math.max(...data.months.map((x) => x.qty), 1)
                  return (
                    <div key={m.month} className="finder__month" title={`${m.month}: ${fmtInt(m.qty)}`}>
                      <span className="finder__bar" style={{ height: `${Math.round((m.qty / peak) * 100)}%` }} />
                      <span className="finder__qty">{m.qty ? fmtInt(m.qty) : '–'}</span>
                      <span className="finder__mon">{m.month.slice(5)}</span>
                    </div>
                  )
                })}
              </div>

              {!data.forecast && data.elsewhere && (
                <p className="finder__note">
                  The warehouse does ship this article — {fmtInt(data.elsewhere.total)} units, mostly to{' '}
                  {data.elsewhere.destination ?? 'an internal destination'} — but that is an internal
                  transfer rather than a shop, so no brand can claim it.
                </p>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
