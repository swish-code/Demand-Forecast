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
export function PageLoader({ name }) {
  return (
    <div className="pageload" role="status" aria-live="polite">
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
