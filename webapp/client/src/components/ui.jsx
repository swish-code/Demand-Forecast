import { fmtPct, fmtSignedPct } from '../api.js'
import { IconAlert, IconInfo, IconArrowUp, IconArrowDown, IconTable, IconRefresh } from './Icons.jsx'

/**
 * KPI card: mono uppercase label, tinted icon chip, large figure, and an accent
 * bar along the bottom edge filled in proportion to the metric.
 *
 * `accent` picks the chip + bar colour and `progress` (0–1) the fill. `tint`
 * additionally washes the whole card and recolours the figure — reserved for
 * numbers that are themselves good or bad news (variance sign, accuracy target).
 */
export function KpiCard({ label, value, foot, accent = 'slate', tint, progress, icon, loading, textValue }) {
  if (loading) return <div className="kpi skel" style={{ height: 104, border: 'none' }} aria-hidden="true" />

  const pct = Math.max(0, Math.min(1, Number(progress) || 0))

  return (
    <div className={`kpi${tint ? ` kpi--tint-${tint}` : ''}`}>
      <div className="kpi__top">
        <span className="kpi__label">{label}</span>
        {icon ? <span className={`kpi__chip kpi__chip--${accent}`}>{icon}</span> : null}
      </div>
      <span
        className={`kpi__value${textValue ? ' kpi__value--text' : ''}`}
        title={textValue ? String(value) : undefined}
      >
        {value}
      </span>
      <span className="kpi__foot">{foot}</span>
      <span className={`kpi__bar kpi__bar--${accent}`} aria-hidden="true">
        <span style={{ width: `${pct * 100}%` }} />
      </span>
    </div>
  )
}

export function Panel({ title, count, sub, tools, children, flush, fill }) {
  return (
    <section className={`panel${fill ? ' panel--fill' : ''}`}>
      <header className="panel__head">
        <div className="panel__titles">
          <h2>
            {title}
            {count !== undefined && <span className="panel__count">{count}</span>}
          </h2>
          {sub ? <p>{sub}</p> : null}
        </div>
        {tools ? <div className="panel__tools">{tools}</div> : null}
      </header>
      <div className={`panel__body${flush ? ' panel__body--flush' : ''}`}>{children}</div>
    </section>
  )
}

/** Inline legend. `dashed` mirrors how the series is drawn in the chart. */
export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span className="legend__item" key={it.label}>
          {it.bar ? (
            <span className="legend__swatch" style={{ background: it.color }} aria-hidden="true" />
          ) : (
            <span
              className={`legend__rule${it.dashed ? ' legend__rule--dashed' : ''}`}
              style={{ color: it.color }}
              aria-hidden="true"
            />
          )}
          {it.label}
        </span>
      ))}
    </div>
  )
}

/** Generic tinted pill used for brand codes, node types and prep status. */
export function Pill({ tone = 'slate', children }) {
  return <span className={`pill pill--${tone}`}>{children}</span>
}

/** Prep status — text always carries the state, colour only reinforces it. */
export function StatusBadge({ status }) {
  if (status === 'Extra Prep Needed') {
    return (
      <span className="pill pill--red">
        <IconArrowUp size={9} />
        Extra prep
      </span>
    )
  }
  if (status === 'Reduced Prep Needed') {
    return (
      <span className="pill pill--slate">
        <IconArrowDown size={9} />
        Reduced prep
      </span>
    )
  }
  return <span className="pill pill--plain">Normal</span>
}

/** Signed percentage with an arrow, so direction is never colour-only. */
/**
 * Signed percentage with an arrow. The arrow always carries direction; colour
 * only appears once the magnitude passes `limit`, so a red delta in a table
 * genuinely means an outlier rather than "slightly down".
 */
export function Delta({ value, digits = 1, pill = false, limit = 0.15 }) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return <span className="delta delta--flat">–</span>
  }
  const n = Number(value)
  if (n === 0) return <span className="delta delta--plain">{fmtSignedPct(0, digits)}</span>

  const Arrow = n > 0 ? IconArrowUp : IconArrowDown
  const outlier = Math.abs(n) > limit
  const tone = outlier ? (n > 0 ? 'green' : 'red') : 'plain'

  if (pill) {
    return (
      <span className={`pill pill--${outlier ? (n > 0 ? 'green' : 'red') : 'slate'}`}>
        <Arrow size={9} />
        {fmtSignedPct(n, digits).replace('-', '')}
      </span>
    )
  }
  return (
    <span className={`delta delta--${tone === 'green' ? 'up' : tone === 'red' ? 'down' : 'plain'}`}>
      <Arrow size={10} />
      {fmtSignedPct(n, digits)}
    </span>
  )
}

/** Signed quantity, coloured by sign, kept in tabular figures. */
export function SignedQty({ value, format }) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return <span className="delta delta--flat">–</span>
  }
  const n = Number(value)
  if (n === 0) return <span className="delta delta--plain">0</span>
  return (
    <span className="delta delta--plain">
      {n > 0 ? '+' : ''}
      {format(n)}
    </span>
  )
}

/** Horizontal accuracy meter: bar plus the value, so it is never colour-only. */
export function Meter({ value, good = 0.95, warn = 0.85, showValue = true }) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return <span className="delta delta--flat">–</span>
  }
  const v = Math.max(0, Math.min(1, Number(value)))
  // Green on target, red under the floor, neutral in between — no third hue.
  const tone = v >= good ? '' : v >= warn ? ' meter__fill--amber' : ' meter__fill--red'
  return (
    <span className="meter">
      <span className="meter__track">
        <span className={`meter__fill${tone}`} style={{ width: `${v * 100}%` }} />
      </span>
      {showValue && <span className="meter__val">{fmtPct(v)}</span>}
    </span>
  )
}

export function ErrorBanner({ error, onRetry }) {
  const text = String(error?.message || error)
  const noAccess = /cannot be found|404|403|denied|unauthor/i.test(text)

  return (
    <div className="banner banner--error" role="alert">
      <span className="banner__icon">
        <IconAlert size={15} />
      </span>
      <div>
        Could not load data. {text}
        {noAccess && (
          <ol>
            <li>
              Workspace → Manage access → add <code>BPA Web Platform</code> as Contributor (Viewer is not
              enough).
            </li>
            <li>
              Fabric admin portal → Tenant settings → enable <code>Service principals can use Fabric APIs</code>{' '}
              and <code>Dataset Execute Queries REST API</code>.
            </li>
            <li>
              To keep working meanwhile, set <code>DEMO_MODE=1</code> in <code>.env</code>.
            </li>
          </ol>
        )}
        {onRetry && (
          <p style={{ margin: '10px 0 0' }}>
            <button type="button" className="btn" onClick={onRetry}>
              <IconRefresh size={12} />
              Retry
            </button>
          </p>
        )}
      </div>
    </div>
  )
}

export function InfoBanner({ children, tone = 'info', icon }) {
  return (
    <div className={`banner banner--${tone}`}>
      <span className="banner__icon">{icon ?? (tone === 'warn' ? <IconAlert size={15} /> : <IconInfo size={15} />)}</span>
      <div>{children}</div>
    </div>
  )
}


/**
 * A plain input metric: muted label, the number as hero, and a thin accent rule
 * along the bottom edge. No tint and no icon — colour is reserved for state.
 */
export function MetricCard({ label, value, foot, accent = 'green', progress, loading, textValue }) {
  if (loading) return <div className="metric skel" style={{ height: 96, border: 'none' }} aria-hidden="true" />
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <span className={`metric__value${textValue ? ' metric__value--text' : ''}`} title={textValue ? String(value) : undefined}>
        {value}
      </span>
      <span className="metric__foot">{foot}</span>
      <span className={`metric__bar metric__bar--${accent}`} aria-hidden="true">
        <span style={{ width: `${Math.max(0, Math.min(1, progress || 0)) * 100}%` }} />
      </span>
    </div>
  )
}

/**
 * The derived half of a metric flow: one card holding the figures computed from
 * the inputs beside it. White card, coloured figure — the number carries state.
 */
export function PerfCard({ title = 'Performance', items, loading, height = 208 }) {
  if (loading) return <div className="perf skel" style={{ height, border: 'none' }} aria-hidden="true" />
  return (
    <div className="perf">
      <span className="perf__title">{title}</span>
      <div className="perf__grid">
        {items.map((it) => (
          <div className="perf__item" key={it.label}>
            <span className="metric__label">{it.label}</span>
            <span className={`perf__value perf__value--${it.state ?? 'good'}`}>{it.value}</span>
            <span className="metric__foot">{it.foot}</span>
            {it.extra ? <span className="perf__spark">{it.extra}</span> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Two input cards, an arrow, then the card derived from them. */
export function MetricFlow({ inputs, children }) {
  return (
    <div className="flow">
      <div className="flow__inputs">{inputs}</div>
      <span className="flow__arrow" aria-hidden="true">
        →
      </span>
      {children}
    </div>
  )
}

export function ChartSkeleton({ height = 300 }) {
  return <div className="skel" style={{ height }} aria-hidden="true" />
}

export function Empty({ title = 'No data for these filters', children }) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <IconTable size={24} />
      </span>
      <b>{title}</b>
      {children ? <span>{children}</span> : <span>Try widening the date range or clearing a filter.</span>}
    </div>
  )
}
