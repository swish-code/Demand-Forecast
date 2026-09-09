import { useEffect, useRef, useState } from 'react'
import { api, fmtInt, fmtQty } from '../api.js'
import { IconClose, IconCheck } from './Icons.jsx'
import { InfoBanner } from './ui.jsx'

/**
 * Daily sales for a brand with no forecast model behind it.
 *
 * Forevermore is why this exists. Its warehouse outbound is already in the
 * system and correctly coded, but with no semantic model its sales were missing
 * from the all-brands total — which is the denominator its own outbound gets
 * measured against. The numbers live in a spreadsheet, so this reads one.
 *
 * Checked before it is written, like the recipient import: the file goes up
 * once to be read and once to be applied, and in between you see the dates, the
 * totals and anything that could not be read. A sales file is worth being sure
 * about for a reason the totals cannot show you — 03/04/2026 is the third of
 * April or the fourth of March, and the wrong choice loads real numbers onto
 * the wrong days while every total still balances perfectly.
 */
export function ImportSales({ brand = 'FM', onClose, onDone }) {
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const fileInput = useRef(null)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // Re-reading a changed file is the point of the preview, so any edit drops it.
  const change = (value, name = '') => {
    setText(value)
    setFileName(name)
    setPlan(null)
    setError(null)
  }

  async function pickFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    change(await file.text(), file.name)
  }

  async function run(commit) {
    setBusy(true)
    setError(null)
    try {
      const result = await api.admin.importSales(brand, text, commit)
      if (commit) {
        onDone(
          `${fmtInt(result.written?.written ?? 0)} days of ${brand} sales loaded, ${result.from} to ${result.to}.`
        )
        return
      }
      setPlan(result)
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  return (
    <div
      className="modal"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="modal__card" role="dialog" aria-modal="true" aria-label={`Import ${brand} sales`}>
        <div className="modal__head">
          <div>
            <h2 className="modal__title">Import {brand} sales</h2>
            <span className="modal__sub">One line per day — date, and the day&rsquo;s sales</span>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} disabled={busy} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body">
          {error && <InfoBanner tone="warn">{error}</InfoBanner>}

          <div className="field">
            <span className="field__label">The file</span>
            <div className="bulk__actions">
              <button type="button" className="btn" onClick={() => fileInput.current?.click()} disabled={busy}>
                Choose a CSV
              </button>
              {fileName && <span className="field__help">{fileName}</span>}
            </div>
            <input ref={fileInput} type="file" accept=".csv,text/csv,text/plain" hidden onChange={pickFile} />
            <textarea
              className="field__input bulk__text"
              rows={7}
              value={text}
              placeholder={'Date,Branch,Actual,Forecast\n2026-09-01,FM-Hawally,12500,13000\n2026-09-02,FM-Hawally,9800,10100'}
              onChange={(e) => change(e.target.value)}
            />
            <span className="field__help">
              A <strong>Date</strong> column and an <strong>Actual</strong> column are the minimum.{' '}
              <strong>Forecast</strong> and <strong>Branch</strong> are used if present — without a
              branch every row is filed under one location. Several rows for the same day are added
              together. Export dates as <strong>YYYY-MM-DD</strong> if you can; anything else has to
              be guessed at.
            </span>
          </div>

          {plan && (
            <>
              {plan.dateWarning && <InfoBanner tone="warn">{plan.dateWarning}</InfoBanner>}
              {plan.missingForecast && (
                <InfoBanner tone="warn">
                  No forecast column, so forecast is stored as zero. The all-brands actual total will
                  be right; the all-brands forecast total will not include {brand}, which understates
                  anything derived from it. Add a forecast or run-rate column if you have one.
                </InfoBanner>
              )}

              <div className="field">
                <span className="field__label">What this loads</span>
                <dl className="imp">
                  <dt>Days</dt>
                  <dd>{fmtInt(plan.rows)}</dd>
                  <dt>From</dt>
                  <dd>
                    {plan.from} to {plan.to}
                  </dd>
                  <dt>Total actual</dt>
                  <dd>{fmtQty(plan.actual)}</dd>
                  <dt>Total forecast</dt>
                  <dd>{plan.forecast ? fmtQty(plan.forecast) : <span className="muted">none</span>}</dd>
                  <dt>Locations</dt>
                  <dd>{plan.locations.join(', ')}</dd>
                </dl>
              </div>

              <div className="field">
                <span className="field__label">
                  The first few rows
                  <span className="field__help"> check the dates landed where you expect</span>
                </span>
                <div className="bulk__list">
                  {plan.sample.map((r) => (
                    <div className="bulk__row" key={`${r.date}|${r.location}`}>
                      <span className="pill pill--slate">{r.date}</span>
                      <span className="bulk__email">{r.location}</span>
                      <span className="bulk__detail">
                        actual {fmtQty(r.actual)}
                        {r.forecast ? ` · forecast ${fmtQty(r.forecast)}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {plan.skipped?.length > 0 && (
                <div className="field">
                  <span className="field__label">Lines that will be skipped</span>
                  <div className="bulk__list">
                    {plan.skipped.map((p, i) => (
                      <div className="bulk__row bulk__row--bad" key={`${p.line}-${i}`}>
                        <span className="pill pill--red">line {p.line}</span>
                        <span className="bulk__detail">{p.why}</span>
                      </div>
                    ))}
                  </div>
                  <span className="field__help">
                    Everything else still loads. Fix these and run it again — importing the same
                    dates replaces them rather than adding to them.
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal__foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {plan ? (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => run(true)}>
              {busy ? 'Importing…' : `Load ${fmtInt(plan.rows)} day${plan.rows === 1 ? '' : 's'}`}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !text.trim()}
              onClick={() => run(false)}
            >
              <IconCheck size={12} />
              {busy ? 'Reading…' : 'Check the file'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
