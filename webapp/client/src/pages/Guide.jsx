import { StockArticleWalkthrough } from './GuideStockArticle.jsx'

/**
 * The guide, which is now one page's walkthrough rather than the whole app's.
 *
 * Cut back to this on 10 Sep 2026, and the reason is who reads it. The
 * departments given this guide — Warehouse, Production, Bakery — hold Stock
 * Article and nothing else, so nine sections about the Overview, the Products
 * table, Build view, the daily email, recipients and Admin described pages they
 * cannot open. A reader arriving from the "How to use this page" button is
 * asking about the page they are standing on.
 *
 * What was here before is in the history if an app-level guide is wanted again.
 * It would want to be a second page rather than a preamble to this one, because
 * the audiences are different.
 */
export function Guide({ onDrill }) {
  return (
    <article className="doc">
      <header className="doc__masthead">
        <p className="doc__eyebrow">Documentation</p>
        <h1 className="doc__title">How to use the Stock Article page</h1>
        <p className="doc__lead">
          Set the filters, read the numbers, and check any article for yourself — including whether
          an article is in the forecast at all, and why it may not be.
        </p>
        {onDrill && (
          <button type="button" className="btn doc__back" onClick={() => onDrill('component', {})}>
            Back to Stock Article
          </button>
        )}
      </header>

      <div className="doc__split">
        <div className="guide__body">
          <StockArticleWalkthrough />
        </div>
      </div>
    </article>
  )
}
