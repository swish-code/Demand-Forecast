import { IconChevron, IconRefresh } from './Icons.jsx'

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
export function SideNav({ pages, active, onSelect, health, lastUpdated, onRefresh, user, onSignOut, collapsed = false, onToggle }) {
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
      {/*
        * The brand moved to the app bar on 1 Oct 2026, where the reference puts
        * it. Keeping it here as well would have shown the wordmark twice, a
        * couple of hundred pixels apart, so the rail now starts with its
        * section heading.
        */}

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
            title={collapsed ? `${p.label} — ${p.kicker}` : p.blurb}
          >
            <p.Icon size={15} />
            {/*
              * Name only, from 1 Oct 2026. The kicker underneath was removed on
              * request; it still reaches the reader through the button's own
              * `title`, which names the page and describes it on hover.
              */}
            <span className="nav__item-text">
              <b>{p.label}</b>
            </span>
          </button>
        ))}
      </div>

      {/*
        * Below the last item, in the normal flow - moved there 1 Oct 2026.
        *
        * It was absolutely positioned against the rail and pinned to its
        * vertical middle, so it floated over whichever item happened to be
        * halfway down: Admin when collapsed, Sales plan when expanded.
        *
        * A sibling of the list rather than its last child, because the list
        * scrolls - inside it, the control would scroll out of reach on a short
        * window, which is exactly when somebody wants to collapse the rail. It
        * still renders directly under the last item, and the footer below is
        * untouched, so the avatar stays pinned to the bottom.
        */}
      {onToggle && (
        <button
          type="button"
          className="nav__toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand the menu' : 'Collapse the menu'}
          aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'}
        >
          <IconChevron size={14} />
        </button>
      )}

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
