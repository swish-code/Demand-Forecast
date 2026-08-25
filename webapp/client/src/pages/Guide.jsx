import { Panel } from '../components/ui.jsx'

/**
 * How to use the app, written for the people who actually open it.
 *
 * Kept inside the application rather than in a shared document, for two
 * reasons. It deploys with the code, so it cannot drift into describing a
 * version nobody is running; and it is reachable at the moment somebody is
 * confused, which is when documentation is read at all.
 *
 * The tone is deliberately plain. Most readers here are branch and production
 * staff, not analysts, and the questions they arrive with are practical: what
 * am I looking at, which number do I trust, why does this differ from Power BI.
 */

const SECTIONS = [
  { id: 'start', label: 'Where to start' },
  { id: 'pages', label: 'The four pages' },
  { id: 'filters', label: 'Choosing what you see' },
  { id: 'buildview', label: 'Build view' },
  { id: 'numbers', label: 'Reading the numbers' },
  { id: 'mail', label: 'The daily email' },
  { id: 'recipients', label: 'Managing recipients' },
  { id: 'admin', label: 'Admin' },
]

function Section({ id, title, children }) {
  return (
    <section className="guide__section" id={id}>
      <h3 className="guide__h">{title}</h3>
      {children}
    </section>
  )
}

export function Guide({ onDrill }) {
  const go = (id) => (e) => {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Panel
      title="Contents"
      sub="Jump to a section, or read it through — it is not long"
      tools={
        onDrill ? (
          <button type="button" className="btn" onClick={() => onDrill('summary', {})}>
            Back to Overview
          </button>
        ) : null
      }
    >
      <div className="guide">
        <nav className="guide__toc" aria-label="Contents">
          {SECTIONS.map((s) => (
            <a key={s.id} className="guide__tocLink" href={`#${s.id}`} onClick={go(s.id)}>
              {s.label}
            </a>
          ))}
        </nav>

        <div className="guide__body">
          <Section id="start" title="Where to start">
            <p>
              This app answers one question in several ways: <strong>what did we expect to sell, and
              what did we actually sell?</strong> Every figure comes from the same Power BI models the
              reports use, so the app and the report should always agree for the same brand, branch and
              day.
            </p>
            <p>
              Pick your <strong>brand</strong> at the top left, then a <strong>date range</strong> on
              the right. Everything on the page follows those two choices. Your account decides which
              brands and branches you can see at all — if a branch is missing, it has not been granted
              to you rather than being absent from the data.
            </p>
          </Section>

          <Section id="pages" title="The four pages">
            <dl className="guide__list">
              <dt>Overview</dt>
              <dd>
                How the selected period is tracking. Units sold against units forecast, the variance
                between them, and accuracy. Below that, today's and tomorrow's forecast, the branches
                furthest from normal, and the trend over the window.
              </dd>

              <dt>Products</dt>
              <dd>
                The same comparison broken down to each product and PLU. This is where you find which
                lines drove a variance. Every row is actual against forecast for the window you chose.
              </dd>

              <dt>Ingredients</dt>
              <dd>
                What the forecast implies you need in raw materials and prepared items. Components are
                grouped by recipe group and type — <em>RAW</em> is bought in, <em>PREP</em> is worked
                on, <em>PA</em> is something the kitchen produces itself.
              </dd>

              <dt>Tomorrow's Prep</dt>
              <dd>
                The production plan for the next day, per PLU and per branch, with a prep status on
                each line. <em>Extra prep</em> means demand is running more than 20% above the recent
                average for that weekday; <em>Reduced</em> means more than 20% below.
              </dd>
            </dl>
          </Section>

          <Section id="filters" title="Choosing what you see">
            <p>
              The bar along the top is the same on every page, minus whatever does not apply. Brands
              can be multi-selected; the figures then add up across them. Location, Product and Product
              PLU narrow the rows. The date picker offers the usual ranges plus{' '}
              <strong>Tomorrow</strong>, which is useful on Products when you want to see what the
              model expects rather than what happened.
            </p>
            <p>
              For a future date there are no actuals and never will be, so the actual, variance and
              accuracy columns are hidden rather than shown as zero or as −100%.
            </p>
          </Section>

          <Section id="buildview" title="Build view">
            <p>
              Above the Products, Ingredients and Production plan tables there is a{' '}
              <strong>Build view</strong> button. It chooses which columns the table shows, and your
              choice is remembered on that device.
            </p>
            <p>
              Two of the options are marked <em>splits rows</em>: <strong>Date</strong> and{' '}
              <strong>Branch</strong>. These are not display toggles. Turning one on re-asks the
              question at a finer grain, so one row per product becomes one row per product per day,
              or per branch. A month of one brand goes from a few hundred rows to tens of thousands,
              and the query takes noticeably longer — that is expected, and the totals stay correct.
            </p>
            <p>
              Splitting by day removes the <em>Demand vs prev</em> column, because a single day has
              nothing meaningful to compare against a whole previous month.
            </p>
          </Section>

          <Section id="numbers" title="Reading the numbers">
            <dl className="guide__list">
              <dt>Product and Product PLU</dt>
              <dd>
                A PLU is the code the till sells against and the code stock and recipes are booked to.
                One product name usually covers several PLUs — <em>Regular</em> is four of them. Plan
                a shift from the product; order and book against the PLU. Both totals come to the same
                number, so never add them together.
              </dd>

              <dt>Accuracy</dt>
              <dd>
                How close the forecast was, measured against what actually sold. 95% means the forecast
                was out by 5% of the day's sales. The target line on the dashboard is 95%; the morning
                digest flags anything under 90%.
              </dd>

              <dt>Variance</dt>
              <dd>
                Forecast minus actual, in units and as a percentage. Negative means you sold less than
                was forecast.
              </dd>

              <dt>Demand vs prev</dt>
              <dd>
                This window against the one immediately before it, like for like. Split by branch it
                compares that branch's own history, so a small branch moving from 1 unit to 18 shows a
                very large percentage — correct, but read the unit counts beside it.
              </dd>

              <dt>Dates</dt>
              <dd>
                Cards that talk about a day name it — "Units to prepare · 26 Aug". If a figure ever
                disagrees with Power BI, compare that date first: the two are almost always looking at
                different days rather than at different numbers.
              </dd>
            </dl>
          </Section>

          <Section id="mail" title="The daily email">
            <p>
              Reports go out automatically at <strong>12:00</strong>, once the model holds yesterday's
              sales. If the refresh runs late they wait and try again, and send anyway at 15:00 with a
              note saying the data was not complete. They always come from the automation mailbox,
              whoever pressed anything.
            </p>
            <p>Each message is a short summary with the figures attached as an Excel workbook:</p>
            <dl className="guide__list">
              <dt>Tomorrow's prep list</dt>
              <dd>One branch, what to prepare, with the recent daily average and a prep status.</dd>
              <dt>Branch forecast</dt>
              <dd>
                One branch in three tabs — by product, by PLU, and what the kitchen has to make itself.
              </dd>
              <dt>Tomorrow across stores</dt>
              <dd>Every branch in the chosen brands, ranked by how far from a normal day.</dd>
              <dt>Morning digest</dt>
              <dd>
                Yesterday's accuracy for every brand, worst first, and anything that needs attention.
              </dd>
            </dl>
            <p>
              The body carries the headline numbers and the workbook carries every row — open the
              attachment for the full list rather than expecting it in the email.
            </p>
          </Section>

          <Section id="recipients" title="Managing recipients">
            <p>
              On the Admin page, under <strong>Daily reports</strong>, there are three ways to change
              who receives what. All of them need an administrator.
            </p>
            <dl className="guide__list">
              <dt>Add recipient</dt>
              <dd>
                One address at a time, or several at once with the <em>+</em> button. Each address
                carries its own brands and branches, so a kitchen mailbox and an area manager covering
                six branches can be added on the same form.
              </dd>
              <dt>Edit as table</dt>
              <dd>
                The whole list as a spreadsheet — address, name, brand, branch, on or off, one line per
                branch. Brand and branch are dropdowns of what the model actually holds, so a branch
                cannot be misspelled or filed under the wrong brand. Lines sharing an address become
                one recipient.
              </dd>
              <dt>Import list</dt>
              <dd>
                A CSV of the same columns. It shows you exactly what it would do before writing
                anything, and names the line number of anything it cannot accept.
              </dd>
            </dl>
            <p>
              An address does not need a dashboard account — a shared branch mailbox or a distribution
              list works. Use <strong>Paused</strong> rather than removing somebody who is on leave, so
              the setup survives.
            </p>
          </Section>

          <Section id="admin" title="Admin">
            <p>
              Accounts, roles and access live here, along with the morning digest, the alert list and
              the model review. A user's <strong>role</strong> decides what kind of thing they see and
              their <strong>scope</strong> decides which brands and branches — a store account with one
              branch granted sees only that branch, everywhere.
            </p>
            <p>
              The model review explains how each brand's forecast is built and what would improve its
              accuracy. It is aimed at whoever maintains the DAX, not at branch staff.
            </p>
          </Section>

        </div>
      </div>
    </Panel>
  )
}
