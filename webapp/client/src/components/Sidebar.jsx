import { IconMenu } from './Icons.jsx'

/**
 * Dark navigation rail. The Swishhh wordmark sits beside the dashboard name;
 * each page shows a one-line description of what it answers, and the active
 * item takes a lighter panel with a green edge mark.
 */
export function Sidebar({ pages, active, onSelect, collapsed, onToggle, health, lastUpdated }) {
  const status = !health ? 'down' : health.mode === 'demo' ? 'demo' : 'live'
  const statusText = !health ? 'API unreachable' : health.mode === 'demo' ? 'Sample data' : 'Power BI live'

  return (
    <nav className={`nav${collapsed ? ' nav--collapsed' : ''}`} aria-label="Pages">
      <div className="nav__brand">
        <img className="nav__logo" src="/swish-logo.png" alt="Swishhh" />
        <span className="nav__wordmark">
          <b>Demand Forecast</b>
          <span>BBT · {health?.mode === 'demo' ? 'Demo' : 'Live'}</span>
        </span>
      </div>

      <div className="nav__section">Report pages</div>

      <div className="nav__items">
        {pages.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`nav__item${p.id === active ? ' nav__item--active' : ''}`}
            onClick={() => onSelect(p.id)}
            title={collapsed ? p.label : undefined}
            aria-current={p.id === active ? 'page' : undefined}
          >
            <p.Icon size={15} />
            <span className="nav__item-text">
              <b>{p.label}</b>
              <span>{p.kicker}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="nav__foot">
        <div className="nav__meta">
          <span className={`nav__dot nav__dot--${status}`} />
          {statusText}
        </div>
        {lastUpdated && <div className="nav__meta">Updated {lastUpdated}</div>}
        <button
          type="button"
          className="nav__collapse"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <IconMenu size={14} />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </nav>
  )
}
