/**
 * "How to use this page", for the production pages.
 *
 * WHY IT IS A PANEL AND NOT A PAGE
 *
 * Stock Article's walkthrough is its own page, `guide`, reached from the filter
 * bar. That could not be reused here. From 29 Sep 2026 the three making
 * departments hold exactly one page each - Production holds CK/CPU, Bakery holds
 * Swish Bakery, YELO Factory holds its own - and nothing else. A separate guide
 * page would have to be granted to each of them as well, and the moment somebody
 * forgot, the button would navigate to a page the account may not open: the app
 * falls back to the first page it can, so the button looks broken rather than
 * forbidden. That exact failure is documented in `departments.js`.
 *
 * A panel is part of the page, so it needs no grant and cannot drift out of step
 * with the access rules.
 *
 * WHO IT IS WRITTEN FOR
 *
 * A section leader or a kitchen manager reading it for the first time, not the
 * person who maintains the forecast. Short sentences, no jargon that is not
 * explained on the spot, and a worked example with real arithmetic wherever a
 * formula appears. It says what to DO with each number, because a column nobody
 * can act on is a column nobody reads.
 *
 * It takes the page's own name and site so it can name them rather than saying
 * "this site" - the same guide serving four pages with the wrong name on three
 * of them is what "specific to each page" was asked to avoid.
 */
import { useEffect } from 'react'
import { IconClose } from './Icons.jsx'

/** One numbered step, in the shape the Stock Article walkthrough uses. */
function Step({ n, title, children }) {
  return (
    <div className="sa__step">
      <div className="sa__stepHead">
        <span className="sa__stepN">{n}</span>
        <h3>{title}</h3>
      </div>
      <div className="sa__stepBody">{children}</div>
    </div>
  )
}

export function GuideProduction({ label, onClose }) {
  const site = label === 'Production' ? 'the kitchens, the bakery and the factory' : label

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal__card modal__card--wide"
        role="dialog"
        aria-modal="true"
        aria-label={`How to use the ${label} page`}
      >
        <div className="modal__head">
          <div>
            <h2 className="modal__title">How to use the {label} page</h2>
            <span className="modal__sub">
              What every number means, and what to do with it
            </span>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <div className="modal__body">
          <div className="sa">
            <p className="sa__intro">
              This page is a <b>production plan</b>. Each row is one article that {site} makes,
              with how much to make and how close we have been getting. Read it top to bottom the
              first time; after that you will only need steps 3 and 4.
            </p>

            <Step n={1} title="What this page is for">
              <p className="sa__do">
                <span aria-hidden="true">▸</span> Decide how much of each article to produce for
                the dates you have selected.
              </p>
              <p>
                Every article here is something made in‑house, not bought from a supplier. Things
                that are bought live on the Stock Article page instead.
              </p>
              <p className="sa__why">
                The list is built from what {label === 'Production' ? 'the sites have' : `${label} has`}{' '}
                actually issued over the last six months, so an article appears because it really
                is produced here — not because somebody added it to a list.
              </p>
            </Step>

            <Step n={2} title="Two forecasts, side by side — the most important thing on the page">
              <p>
                The table has two shaded sections, and they answer the same question two different
                ways. Comparing them is the point.
              </p>
              <ul className="sa__last">
                <li>
                  <b>Product mix</b> works forwards from the menu. It asks: how many burgers do we
                  expect to sell, and how much of this article does each burger need? Multiply and
                  add up.
                </li>
                <li>
                  <b>Outbound forecast</b> ignores recipes completely. It asks: over the last six
                  months, how much of this article did we actually issue for every dinar the brand
                  sold? Then it applies that rate to expected sales.
                </li>
              </ul>
              <p className="sa__why">
                The second one has been much closer in testing — about 85% accurate per article
                against about 65% for the recipe method, measured over four months. Where the two
                disagree, the Outbound forecast is usually the better number to plan from. The
                recipe method is still shown because it explains <i>why</i> a requirement exists.
              </p>
            </Step>

            <Step n={3} title="The cards at the top">
              <p className="sa__do">
                <span aria-hidden="true">▸</span> Read these before the table. They summarise
                everything the filters have left on screen.
              </p>
              <ul className="sa__last">
                <li>
                  <b>Articles</b> — how many distinct articles are in view. Counts articles, not
                  rows, so it does not change when you show or hide the Recipe group column.
                </li>
                <li>
                  <b>Largest requirement</b> — the single biggest article on the list, in its own
                  unit. Useful for spotting a figure that looks wrong by an order of magnitude.
                </li>
                <li>
                  <b>Product mix accuracy</b> — how close the recipe method has been, averaged
                  across articles.
                </li>
                <li>
                  <b>Fulfilment accuracy</b> — how close the <i>Outbound forecast</i> has been to
                  what was really issued, weighted so that a big article counts for more than a
                  tiny one. This is the headline number for this page.
                </li>
              </ul>
            </Step>

            <Step n={4} title="The columns, one band at a time">
              <p>
                Click the <b>ⓘ</b> beside a band heading to see its formulas at any time. In short:
              </p>
              <p className="sa__do">
                <span aria-hidden="true">▸</span> Product mix
              </p>
              <ul>
                <li>
                  <b>PM Forecast</b> — what the recipes ask for. Blank means no recipe reaches this
                  article.
                </li>
                <li>
                  <b>PM Actual</b> — the same sum using what actually sold.
                </li>
                <li>
                  <b>ACC%</b> — how close those two are. Higher is better.
                </li>
                <li>
                  <b>Outbound/PM Forecast</b> — the recipe forecast judged against what was really
                  issued. Read the slash as “versus”.
                </li>
              </ul>
              <p className="sa__do">
                <span aria-hidden="true">▸</span> Outbound forecast
              </p>
              <ul className="sa__last">
                <li>
                  <b>Outbound</b> — how much was actually issued in your selected dates. Measured,
                  not predicted.
                </li>
                <li>
                  <b>Forecast</b> — the rate‑based forecast described in step 2.
                </li>
                <li>
                  <b>Acc%</b> — how close that forecast came. Compare it with ACC% on the left:
                  whichever is higher, that method was closer for this article.
                </li>
              </ul>
            </Step>

            <Step n={5} title="A worked example">
              <p>
                Say <b>Marinated Chicken Tender</b> shows PM Forecast 1,000 kg, Outbound 1,200 kg
                and Forecast 1,150 kg.
              </p>
              <ul>
                <li>
                  The recipes asked for <b>1,000</b>. The kitchens issued <b>1,200</b>. So{' '}
                  <b>Outbound/PM Forecast</b> = 1 − (200 ÷ 1,200) = <b>83.3%</b> — the recipe method
                  was 200 kg light.
                </li>
                <li>
                  The rate method predicted <b>1,150</b>. So <b>Acc%</b> = 1 − (50 ÷ 1,200) ={' '}
                  <b>95.8%</b> — much closer.
                </li>
              </ul>
              <p className="sa__why">
                Both accuracy figures divide by the larger of the two numbers. That means producing
                double and producing half score the same, so read Outbound against Forecast to see
                which way the gap went.
              </p>
            </Step>

            <Step n={6} title="Filters and the date range">
              <p className="sa__do">
                <span aria-hidden="true">▸</span> Set the dates first. Everything on the page
                answers for those dates only.
              </p>
              <ul className="sa__last">
                <li>
                  <b>Dates</b> — use a <b>whole month</b> where you can. Deliveries and sales do not
                  land in step inside a month, so a part month makes every accuracy figure noisier.
                  A range that has not happened yet shows the forecast with no actuals beside it.
                </li>
                <li>
                  <b>Article</b> — narrows to one article. Note that Outbound and the forecasts are
                  brand‑level figures, so they are hidden while a branch filter is on.
                </li>
                <li>
                  <b>Prod. type</b> — PREP is a kitchen step, PA is a prepared article the system
                  stocks.
                </li>
                <li>
                  <b>Build view</b> — show or hide columns. Switching on <b>Recipe group</b> splits
                  an article into one row per recipe; the accuracy columns then blank, because
                  Outbound is only known per article and cannot be split between recipes.
                </li>
              </ul>
            </Step>

            <Step n={7} title="What a dash means — they are not all the same">
              <p>
                A blank cell is always a refusal to state something the data cannot support. Which
                refusal it is matters:
              </p>
              <ul className="sa__last">
                <li>
                  <b>PM Forecast blank</b> — no recipe reaches this article, or the products that
                  use it are not in the sales forecast. Click the article name to see which.
                </li>
                <li>
                  <b>Outbound blank</b> — no site issued it in these dates. Not the same as zero:
                  zero would mean we know none moved.
                </li>
                <li>
                  <b>Forecast blank</b> — no six‑month history to build a rate from, usually a new
                  or dormant article.
                </li>
                <li>
                  <b>Accuracy blank</b> — one of the two sides it needs is missing, or both are
                  zero. An article nobody forecast and nobody issued was never tested, so it scores
                  nothing rather than 0%.
                </li>
              </ul>
            </Step>

            <Step n={8} title="What to do with it">
              <ol className="sa__last">
                <li>
                  Sort by <b>Forecast</b> to see the biggest jobs first.
                </li>
                <li>
                  Check <b>Acc%</b> on those rows. Below about 60% on a high‑volume article is worth
                  investigating before you trust the number.
                </li>
                <li>
                  Where <b>Outbound</b> is consistently above both forecasts, we are under‑planning
                  that article — tell whoever maintains the forecast, with the article number.
                </li>
                <li>
                  Use <b>⭳ CSV</b> to take the list away. It exports the columns you have on screen
                  and the rows left after your search, not the full table.
                </li>
              </ol>
            </Step>
          </div>
        </div>
      </div>
    </div>
  )
}
