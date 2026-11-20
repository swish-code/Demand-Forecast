import { useState } from 'react'
import { IconChevron, IconMenu, IconRefresh } from './Icons.jsx'
import { useDockMagnify } from '../dockMagnify.js'

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
  /*
   * A callback ref, not `useRef`.
   *
   * `useDockMagnify` binds listeners to the element, and a plain ref object is
   * still null on the render that creates it - the effect would run once
   * against nothing and never again. State re-renders when the node arrives,
   * so the hook gets a real element.
   */
  const [railNav, setRailNav] = useState(null)
  useDockMagnify(railNav)
  /** The phone-only overflow sheet for pages six and beyond. */
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <aside className={`rail${collapsed ? ' rail--collapsed' : ''}`} aria-label="Pages">
      <div className="rail-panel">
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

      <nav className="rail-nav" ref={setRailNav}>
        {pages.map((p, i) => (
          <button
            key={p.id}
            type="button"
            /*
             * `rail-extra` is every page past the fifth. It changes nothing on
             * a desktop; on a phone the rail becomes a five-tab bottom bar and
             * these go under "More".
             */
            className={`rail-item${p.id === active ? ' on' : ''}${i >= 5 ? ' rail-extra' : ''}`}
            /*
             * `blur()` after selecting, deliberately.
             *
             * The panel also opens on `:focus-visible` so it can be reached by
             * keyboard. Without this, clicking a page left that button focused
             * and the rail stayed expanded over the content you had just
             * navigated to. A keyboard Tab still opens it; a mouse click no
             * longer holds it open.
             */
            onClick={(e) => {
              onSelect(p.id)
              e.currentTarget.blur()
            }}
            aria-current={p.id === active ? 'page' : undefined}
            aria-label={p.label}
            title={`${p.label} — ${p.kicker}`}
          >
            <p.Icon size={19} />
            <span className="rail-label">{p.label}</span>
          </button>
        ))}

        {/* Only shown on a phone, where the bar holds five. */}
        {pages.length > 5 && (
          <button
            type="button"
            className="rail-item rail-more"
            aria-label="More pages"
            onClick={() => setMoreOpen((v) => !v)}
          >
            <IconMenu size={19} />
          </button>
        )}
      </nav>

      {/*
        * The overflow sheet, phone only. Plain buttons rather than a second
        * rail: it is a list of page names, and the bar below it is already
        * the navigation.
        */}
      {moreOpen && pages.length > 5 && (
        <div className="rail-more__sheet" role="menu" aria-label="More pages">
          {pages.slice(5).map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className={`rail-more__item${p.id === active ? ' on' : ''}`}
              onClick={() => {
                onSelect(p.id)
                setMoreOpen(false)
              }}
            >
              <p.Icon size={17} />
              {p.label}
            </button>
          ))}
        </div>
      )}

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

      <div style={{ flex: 1 }} />

      <div className="nav__foot rail-foot">
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
      </div>
    </aside>
  )
}
