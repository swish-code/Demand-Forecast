import { fmtSignedPct, fmtPct } from '../api.js'
import { Panel, ChartSkeleton, Empty } from './ui.jsx'
import { IconInfo, IconAlert, IconCheck } from './Icons.jsx'
import { DemandResponseChart } from './charts/contextViz.jsx'

/**
 * "Why don't the forecast and the actuals match?" — answered on the pages
 * ordinary users read, rather than only on the admin page.
 *
 * The cause comes from the server so that a branch and head office read the
 * same sentence. Note the `unexplained` case below: when none of the usual
 * causes account for the gap this panel says exactly that and points at the
 * forecast itself. That case is the reason the other four are worth believing —
 * a panel that always finds an outside explanation stops being read.
 */

const TONE = {
  'demand-shift': { icon: IconInfo, tone: 'info', label: 'Demand has moved' },
  weekday: { icon: IconInfo, tone: 'info', label: 'A weekday pattern' },
  lean: { icon: IconAlert, tone: 'warn', label: 'A steady offset in the forecast' },
  noise: { icon: IconCheck, tone: 'good', label: 'Normal variation' },
  unexplained: { icon: IconAlert, tone: 'warn', label: 'Not explained by the usual causes' },
  insufficient: { icon: IconInfo, tone: 'info', label: 'Not enough history yet' },
}

export function WhyPanel({ context, loading, title = 'Why forecast and actual differ', chart = true }) {
  const e = context?.explanation
  const meta = TONE[e?.cause] ?? TONE.insufficient
  const Icon = meta.icon

  return (
    <Panel
      title={title}
      count={context?.window ? `${context.days} days to ${context.window.to}` : undefined}
      sub={
        loading
          ? 'Looking at the last 30 completed days…'
          : context?.enough
            ? `Typical daily gap ${fmtPct(context.typical)} · measured over completed days only`
            : undefined
      }
    >
      {loading ? (
        <ChartSkeleton height={180} />
      ) : !context?.enough ? (
        <Empty title="Not enough completed days yet">
          A few weeks of actuals are needed before the gap can be explained.
        </Empty>
      ) : (
        <>
          <div className={`why why--${meta.tone}`}>
            <span className="why__mark" aria-hidden="true">
              <Icon size={15} />
            </span>
            <div>
              <span className="why__label">{meta.label}</span>
              <strong className="why__headline">{e.headline}</strong>
              {e.detail && <p className="why__detail">{e.detail}</p>}
            </div>
          </div>

          {/* The split matters more than the total: a steady lean is somebody's
              to fix, day-to-day scatter is nobody's. */}
          <ul className="why__facts">
            <li>
              <span>Steady lean</span>
              <strong>{fmtSignedPct(context.bias)}</strong>
              <em>{context.bias > 0 ? 'forecast above actual' : 'forecast below actual'}</em>
            </li>
            <li>
              <span>Day-to-day scatter</span>
              <strong>{fmtPct(context.noise)}</strong>
              <em>varies either way, no pattern</em>
            </li>
            {context.shift && (
              <li>
                <span>Sold this week</span>
                <strong>{fmtSignedPct(context.shift.actual)}</strong>
                <em>against the week before</em>
              </li>
            )}
            {context.shift && (
              <li>
                <span>Forecast this week</span>
                <strong>{fmtSignedPct(context.shift.forecast)}</strong>
                <em>against the week before</em>
              </li>
            )}
          </ul>

          {chart && context.weekly?.length > 1 && (
            <>
              <div className="why__chartHead">
                <span className="legend">
                  <span className="legend__item">
                    <span className="legend__rule" style={{ color: 'var(--series-1)' }} aria-hidden="true" />
                    What sold
                  </span>
                  <span className="legend__item">
                    <span
                      className="legend__rule legend__rule--dashed"
                      style={{ color: 'var(--series-2)' }}
                      aria-hidden="true"
                    />
                    What was forecast
                  </span>
                </span>
                <span className="why__chartNote">week-on-week change</span>
              </div>
              <DemandResponseChart weekly={context.weekly} />
            </>
          )}
        </>
      )}
    </Panel>
  )
}
