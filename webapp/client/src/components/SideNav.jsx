import { IconRefresh } from './Icons.jsx'

/**
 * Left navigation rail.
 *
 * The pages live down the side rather than across the top so the whole width of
 * the header is free for the slicers — on a dashboard the filters are used far
 * more often than the page switcher, and they need the room more.
 *
 * The rail also carries the page identity: each item shows its name and what it
 * is for, so the content area does not have to spend a row restating which page
 * you are on.
 */
export function SideNav({ pages, active, onSelect, health, lastUpdated, onRefresh, user, onSignOut, collapsed = false }) {
  const status = !health ? 'down' : health.mode === 'demo' ? 'demo' : 'live'
  const statusText = !health ? 'API unreachable' : health.mode === 'demo' ? 'Sample data' : 'Power BI live'

  /*
   * A rail of one page is a label, not a navigation.
   *
   * Somebody granted only Ingredients has nowhere to go, so the rail spends two
   * hundred pixels of a wide table telling them where they already are. It
   * collapses to icons instead — the styling for that already existed for
   * narrow screens and had simply never been applied to this case — keeping the
   * status, Refresh and Sign out, which are the only things in it they can act
   * on.
   */
  return (
    <nav className={`nav${collapsed ? ' nav--collapsed' : ''}`} aria-label="Pages">
      <div className="nav__brand">
        <img className="nav__logo" src="/swish-logo.png" alt="Swishhh" />
        <span className="nav__wordmark">
          <b>Demand Forecast</b>
        </span>
      </div>

      {/*
        * The heading only earns its place when there is a list under it.
        *
        * A reader granted one page sees one button; calling that "Reports" and
        * ruling it off from the brand above adds a section divider to separate
        * nothing from nothing. Their page is simply where they are, so the rail
        * shows it and stops.
        */}
      {pages.length > 1 && <div className="nav__section">Reports</div>}

      <div className="nav__items">
        {pages.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`nav__item${p.id === active ? ' nav__item--active' : ''}`}
            onClick={() => onSelect(p.id)}
            aria-current={p.id === active ? 'page' : undefined}
            title={p.blurb}
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
        <span className="nav__meta" title={lastUpdated ? `Updated ${lastUpdated}` : undefined}>
          <span className={`nav__dot nav__dot--${status}`} />
          {statusText}
          {lastUpdated ? ` · ${lastUpdated}` : ''}
        </span>

        <button type="button" className="nav__action" onClick={onRefresh} title="Clear cache and reload">
          <IconRefresh size={12} />
          Refresh
        </button>

        {user && (
          <button
            type="button"
            className="nav__user"
            onClick={onSignOut}
            title={`${user.email} · ${user.role} — click to sign out`}
          >
            <span className="nav__avatar">{(user.name || user.email).slice(0, 1).toUpperCase()}</span>
            <span className="nav__userText">
              <b>{user.name || user.email}</b>
              <span>Sign out</span>
            </span>
          </button>
        )}
      </div>
    </nav>
  )
}
