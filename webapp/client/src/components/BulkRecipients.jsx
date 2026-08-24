import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { IconClose, IconCheck, IconDownload } from './Icons.jsx'
import { InfoBanner } from './ui.jsx'

/**
 * A spreadsheet of recipients instead of sixty trips through the form.
 *
 * Checked before it is written. The file is sent once to be read and once to be
 * applied, and in between you see exactly what it would do — which addresses
 * are new, which existing ones gain a branch, and which lines are wrong and
 * why. A list this size is worth being sure about: the failure mode of a bad
 * one is somebody's kitchen quietly not receiving anything.
 */
export function BulkRecipients({ onClose, onDone }) {
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
      const result = await api.admin.importRecipients(text, commit)
      if (commit) {
        const c = result.counts ?? {}
        onDone(
          `${c.created ?? 0} added, ${c.updated ?? 0} updated${c.unchanged ? `, ${c.unchanged} already covered` : ''}.`
        )
        return
      }
      setPlan(result)
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  const entries = plan?.entries ?? []
  const problems = plan?.problems ?? []
  const willWrite = entries.filter((e) => e.action !== 'unchanged')

  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal__card" role="dialog" aria-modal="true" aria-label="Import recipients">
        <div className="modal__head">
          <div>
            <h2 className="modal__title">Import a list</h2>
            <span className="modal__sub">One line per branch — email, name, brand, branch</span>
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
              <a className="btn" href="/api/admin/email/recipients/template" download>
                <IconDownload size={12} />
                Template
              </a>
              {fileName && <span className="field__help">{fileName}</span>}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv,text/plain"
              hidden
              onChange={pickFile}
            />
            <textarea
              className="field__input bulk__text"
              rows={7}
              value={text}
              placeholder={'email,name,brand,branch\nbyn.kitchen@swishhh.net,BBT Bayan,BBT,BYN'}
              onChange={(e) => change(e.target.value)}
            />
            <span className="field__help">
              A brand can be its code or its name. Several branches in one cell are separated by a
              semicolon. Lines for the same address are folded into one recipient. Leave the report
              column out and every line is a prep list.
            </span>
          </div>

          {plan && (
            <>
              {entries.length === 0 && problems.length === 0 && (
                <InfoBanner tone="warn">Nothing usable in that file.</InfoBanner>
              )}

              {entries.length > 0 && (
                <div className="field">
                  <span className="field__label">
                    What this does
                    <span className="field__help"> {willWrite.length} to write</span>
                  </span>
                  <div className="bulk__list">
                    {entries.map((e) => (
                      <div className={`bulk__row bulk__row--${e.action}`} key={`${e.email}|${e.report}`}>
                        <span className={`pill pill--${e.action === 'create' ? 'green' : 'slate'}`}>
                          {e.action === 'create' ? 'new' : e.action === 'update' ? 'adds' : 'no change'}
                        </span>
                        <span className="bulk__email">{e.email}</span>
                        <span className="bulk__report">{e.reportLabel}</span>
                        <span className="bulk__detail">{e.detail}</span>
                        <span className="bulk__lines">
                          line{e.lines.length === 1 ? '' : 's'} {e.lines.join(', ')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {problems.length > 0 && (
                <div className="field">
                  <span className="field__label">Lines that will be skipped</span>
                  <div className="bulk__list">
                    {problems.map((p, i) => (
                      <div className="bulk__row bulk__row--bad" key={`${p.line}-${i}`}>
                        <span className="pill pill--red">line {p.line}</span>
                        <span className="bulk__detail">{p.detail}</span>
                      </div>
                    ))}
                  </div>
                  <span className="field__help">
                    Everything else still imports. Fix these in the spreadsheet and run it again — the
                    lines already imported will show as no change.
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
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || willWrite.length === 0}
              onClick={() => run(true)}
            >
              {busy ? 'Importing…' : `Import ${willWrite.length} recipient${willWrite.length === 1 ? '' : 's'}`}
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
