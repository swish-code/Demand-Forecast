import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, fmtInt, fmtPct } from '../api.js'
import { Panel, Empty, ChartSkeleton, Pill } from './ui.jsx'
import { IconAlert, IconInfo, IconCheck, IconRefresh } from './Icons.jsx'
import { BrandTag } from './BrandTag.jsx'

/**
 * The morning message: what the forecast looks like today, and anything that
 * needs a person.
 *
 * Only the admin page carries this. Store and stakeholder users see the numbers
 * on the dashboard itself; an alert saying "the model stopped refreshing" is
 * addressed to whoever can chase it, not to a branch about to prep lunch.
 *
 * Findings are grouped by severity rather than by brand, because the question
 * being answered is "is anything wrong this morning" — not "tell me about BBT".
 */

const SEVERITY = {
  critical: { label: 'Needs attention', tone: 'red', Icon: IconAlert, order: 0 },
  warning: { label: 'Worth a look', tone: 'amber', Icon: IconAlert, order: 1 },
  info: { label: 'For information', tone: 'slate', Icon: IconInfo, order: 2 },
}

/** "19 Aug 2026" — the digest's window end, written the way a person says it. */
function longDay(day) {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function whenText(iso, day) {
  if (!iso) return day ?? ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return day ?? ''
  return d.toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** One line describing the whole morning, so the panel head answers first. */
function headline(digest) {
  if (!digest) return 'No digest has been built yet'
  const { critical, warning, info } = digest.counts
  if (!critical && !warning && !info) return `All ${digest.brands} brands look normal`
  const parts = []
  if (critical) parts.push(`${critical} needing attention`)
  if (warning) parts.push(`${warning} worth a look`)
  if (info) parts.push(`${info} for information`)
  return `${parts.join(', ')} across ${digest.brands} brands`
}

export function DigestPanel() {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setState(await api.admin.insights())
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

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      setState(await api.admin.runInsights())
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(false)
    }
  }

  const acknowledge = async () => {
    if (!state?.digest) return
    try {
      await api.admin.ackInsights(state.digest.day)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  const digest = state?.digest
  const groups = useMemo(() => {
    const bySeverity = new Map()
    for (const f of digest?.findings ?? []) {
      if (!bySeverity.has(f.severity)) bySeverity.set(f.severity, [])
      bySeverity.get(f.severity).push(f)
    }
    return [...bySeverity.entries()]
      .sort(([a], [b]) => (SEVERITY[a]?.order ?? 9) - (SEVERITY[b]?.order ?? 9))
      .map(([severity, items]) => ({ severity, items }))
  }, [digest])

  return (
    <Panel
      title="This morning"
      sub={busy ? 'Reading the latest digest…' : headline(digest)}
      count={digest ? whenText(digest.generated_at, digest.day) : undefined}
      tools={
        <>
          {digest && !state?.acknowledged && (
            <button type="button" className="btn" onClick={acknowledge}>
              <IconCheck size={12} />
              Mark as read
            </button>
          )}
          <button type="button" className="btn" onClick={run} disabled={running}>
            <IconRefresh size={12} />
            {running ? 'Checking all brands…' : 'Check now'}
          </button>
        </>
      }
    >
      {busy ? (
        <ChartSkeleton height={160} />
      ) : error ? (
        <p className="digest__error">{error}</p>
      ) : !digest ? (
        <Empty title="Nothing has been checked yet">
          The digest is built automatically each morning. Use <strong>Check now</strong> to run it
          immediately.
        </Empty>
      ) : (
        <>
          {digest.measuredTo && (
            <p className="digest__window">
              Accuracy is <strong>{longDay(digest.measuredTo)}</strong> alone — the last day with all
              its sales in — against a 90% threshold. Trends, branch checks and variance look back
              over the 30 days to that date. Today is never included; it is still being written.
            </p>
          )}

          {state.stale && (
            <p className="digest__stale">
              This is {digest.day}, not today. The morning run has not happened yet — use{' '}
              <strong>Check now</strong> for the current picture.
            </p>
          )}

          {/* Every brand, every morning — not only the ones that breached. The
              findings below say what to do; this says how everyone did, which
              is the question actually being asked each morning. */}
          {digest.daily?.length > 0 && (
            <div className="score">
              <h3 className="digest__groupHead">
                {/* Named, not "yesterday": the figures are for the last day
                    every brand had sales in, which is usually yesterday and
                    occasionally the day before, and the reader should not have
                    to work out which. */}
                <span>
                  {digest.measuredTo ? longDay(digest.measuredTo) : 'Yesterday'}, every brand
                </span>
                <span className="score__note">
                  worst first · threshold {fmtPct(digest.dailyThreshold ?? 0.9, 0)}
                </span>
              </h3>
              <div className="score__grid">
                {digest.daily.map((d) => (
                  <div className={`score__cell score__cell--${d.state}`} key={d.brand}>
                    <div className="score__head">
                      <BrandTag code={d.brand} />
                      <span className="score__name">{d.brandLabel}</span>
                    </div>
                    <span className="score__value">
                      {d.accuracy === null ? '—' : fmtPct(d.accuracy)}
                    </span>
                    <span className="score__foot">
                      {d.accuracy === null
                        ? 'no completed day'
                        : `${fmtInt(d.actual)} sold vs ${fmtInt(d.forecast)}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Capped rather than unbounded: with nine brands a bad morning would
              otherwise push the user analytics below two screens of scroll. */}
          {groups.length === 0 ? (
            <div className="digest__clear">
              <span className="digest__clearMark" aria-hidden="true">
                <IconCheck size={16} />
              </span>
              <div>
                <strong>Nothing to report.</strong>
                <p>
                  Every brand refreshed on time, accuracy is at target and no branch is below the
                  floor.
                </p>
              </div>
            </div>
          ) : (
            <div className="digest__scroll">
              {groups.map((group) => {
              const meta = SEVERITY[group.severity] ?? SEVERITY.info
              return (
                <section className="digest__group" key={group.severity}>
                  <h3 className="digest__groupHead">
                    <Pill tone={meta.tone}>
                      <meta.Icon size={10} />
                      {meta.label}
                    </Pill>
                    <span>{group.items.length}</span>
                  </h3>
                  <ul className="digest__list">
                    {group.items.map((f, i) => (
                      <li className={`digest__item digest__item--${f.severity}`} key={`${f.code}-${f.brand}-${i}`}>
                        <BrandTag code={f.brand} />
                        <div className="digest__text">
                          <strong>{f.title}</strong>
                          <p>{f.detail}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
                )
              })}
            </div>
          )}

          {state.acknowledged && (
            <p className="digest__acked">
              Marked as read by {state.acknowledged.by} on {whenText(state.acknowledged.at)}.
            </p>
          )}
        </>
      )}
    </Panel>
  )
}
