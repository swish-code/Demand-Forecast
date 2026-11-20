import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { pendingFirstLoads, subscribeFirstLoads } from '../firstLoad.js'

/**
 * The card shown while a page's code is being fetched - 20 Nov 2026.
 *
 * The pages are code-split, so opening one that has not been opened before
 * downloads a chunk first. That wait used to show a grey rectangle, which says
 * only "something is happening here" and looks identical on every page.
 *
 * This is the boot screen's card, reused and told WHICH page is coming. The
 * two are deliberately the same object: the first wait of a session and every
 * wait after it then read as one thing, rather than as two different states
 * the app can be in.
 *
 * WHY THE NAME MATTERS. The chunk for a chart-heavy page is the slow one, and
 * that is exactly when a reader wonders whether their click registered.
 * Naming the page answers that without claiming to know how far along it is -
 * which is also why the bar slides rather than filling to a percentage.
 *
 * Rendered only as a Suspense fallback, so it is on screen for as long as the
 * download takes and not a millisecond longer. A page already in the bundle
 * cache never shows it at all.
 */
export function PageLoader({ name, overlay = false }) {
  return (
    <div
      className={`pageload${overlay ? ' pageload--overlay' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="pageload__card">
        <span className="pageload__mark" aria-hidden="true">
          <img src="/swish-logo.png" alt="" />
        </span>
        {/*
         * The page's own name, where the boot screen says "SWiSH Analytics".
         * Falls back to the product name rather than to an empty heading: a
         * card with a blank where the title goes reads as broken.
         */}
        <h2 className="pageload__name">{name || 'SWiSH Analytics'}</h2>
        <p className="pageload__sub">Loading</p>
        <span className="pageload__bar" aria-hidden="true">
          <span />
        </span>
      </div>
      {/* Screen readers get the sentence; the card above is the visual of it. */}
      <span className="sr-only">{name ? `Loading ${name}` : 'Loading'}</span>
    </div>
  )
}

/**
 * Is the page still filling itself in?
 *
 * True from the moment a page opens until its first loads have all finished -
 * then false, and it STAYS false until the next page. That latch is the point:
 * without it, a slicer the reader changes later would drop the count back to
 * zero and throw the card over a page they were already reading.
 *
 * THE GRACE WINDOW. A page's `useData` hooks register from effects, so there
 * is a frame after mount where nothing is pending yet and the page has not
 * asked for anything. Settling in that frame would take the card down
 * immediately and show an empty page. So a page is only considered settled
 * once it is idle AND either something has actually been seen loading, or the
 * grace window has passed with nothing happening - which is the honest answer
 * for a page that fetches nothing at all.
 *
 * THE CAP. A request that never settles must not trap a reader behind a card
 * with no way past it, so the latch closes regardless after `capMs`. The page
 * underneath is mounted and will show its own error or empty state.
 */
export function usePageSettling(pageId, { graceMs = 300, capMs = 20_000 } = {}) {
  const pending = useSyncExternalStore(subscribeFirstLoads, pendingFirstLoads, pendingFirstLoads)
  const [settled, setSettled] = useState(false)
  const sawLoad = useRef(false)

  // A new page starts the whole question again.
  useEffect(() => {
    setSettled(false)
    sawLoad.current = false
  }, [pageId])

  useEffect(() => {
    if (pending > 0) {
      sawLoad.current = true
      return undefined
    }
    if (sawLoad.current) {
      setSettled(true)
      return undefined
    }
    const t = setTimeout(() => setSettled(true), graceMs)
    return () => clearTimeout(t)
  }, [pending, pageId, graceMs])

  useEffect(() => {
    const t = setTimeout(() => setSettled(true), capMs)
    return () => clearTimeout(t)
  }, [pageId, capMs])

  return !settled
}
