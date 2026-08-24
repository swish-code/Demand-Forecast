import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Panel, Empty, ChartSkeleton, Pill } from './ui.jsx'
import { IconAlert, IconCheck, IconRefresh, IconClose } from './Icons.jsx'

/**
 * Faults the app has hit while running: Power BI refusing a query, a report
 * that failed to send, an endpoint throwing, an account locked out.
 *
 * Separate from the morning digest on purpose. The digest is what the forecast
 * says and is read once; this is what is broken and stays until someone deals
 * with it. Repeats fold into a count server-side, so a loop failing every
 * thirty seconds is one line saying "×214", not two hundred lines.
 */

const TONE = { critical: 'red', warning: 'amber', info: 'slate' }

function ago(iso) {
  if (!iso) return ''
  const t = Date.parse(iso.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return iso
  const mins = Math.floor((Date.now() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function AlertsPanel() {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setState(await api.admin.alerts())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const act = async (fn) => {
    try {
      setState(await fn())
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }

  const open = state?.open ?? []
  const sources = state?.sources ?? {}

  return (
    <Panel
      title="Alerts"
      count={busy ? undefined : open.length ? `${open.length} open` : undefined}
      sub={
        busy
          ? 'Checking…'
          : open.length
            ? 'Problems the app has hit — these stay until someone clears them'
            : 'Nothing has gone wrong since the last time these were cleared'
      }
      tools={
        <>
          {open.length > 1 && (
            <button type="button" className="btn" onClick={() => act(api.admin.resolveAllAlerts)}>
              <IconCheck size={12} />
              Clear all
            </button>
          )}
          <button type="button" className="btn" onClick={load}>
            <IconRefresh size={12} />
            Refresh
          </button>
        </>
      }
    >
      {busy ? (
        <ChartSkeleton height={120} />
      ) : error ? (
        <p className="digest__error">{error}</p>
      ) : open.length === 0 ? (
        <div className="digest__clear">
          <span className="digest__clearMark" aria-hidden="true">
            <IconCheck size={16} />
          </span>
          <div>
            <strong>No open alerts.</strong>
            <p>
              Power BI is answering, reports are sending, and no account is locked out.
              {state?.resolved?.length
                ? ` Last one cleared ${ago(state.resolved[0].resolved_at)}.`
                : ''}
            </p>
          </div>
        </div>
      ) : (
        <ul className="digest__list">
          {open.map((a) => (
            <li className={`digest__item digest__item--${a.severity}`} key={a.id}>
              <Pill tone={TONE[a.severity] ?? 'slate'}>
                <IconAlert size={10} />
                {sources[a.source] ?? a.source}
              </Pill>
              <div className="digest__text">
                <strong>
                  {a.title}
                  {a.count > 1 && <span className="alert__count">×{a.count}</span>}
                </strong>
                <p>
                  {a.detail}
                  {a.detail ? ' · ' : ''}
                  {a.count > 1
                    ? `First seen ${ago(a.first_seen_at)}, most recently ${ago(a.last_seen_at)}`
                    : `Seen ${ago(a.last_seen_at)}`}
                </p>
              </div>
              <button
                type="button"
                className="btn btn--icon alert__clear"
                title="Clear this alert"
                aria-label={`Clear: ${a.title}`}
                onClick={() => act(() => api.admin.resolveAlert(a.id))}
              >
                <IconClose size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
