import { useEffect, useState } from 'react'
import {
  IconSummary,
  IconProduct,
  IconComponent,
  IconPlan,
  IconCalendar,
  IconFilter,
  IconColumns,
  IconArrowRight,
} from '../components/Icons.jsx'
import {
  Figure,
  FigShell,
  FigOverview,
  FigProducts,
  FigIngredients,
  FigPlan,
  FigBuildView,
  FigFilters,
  FigAdmin,
} from '../components/GuideFigures.jsx'

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

/*
 * The quick view: the whole app on one screen, before any prose.
 *
 * Most people who open this page are not going to read eight sections. They
 * want to know which of the four pages answers their question and how to get
 * the figures they came for, and they want it in about fifteen seconds. So the
 * top of the guide is a picture of the app rather than a description of it —
 * three steps, four page cards, and the handful of colours the reports use.
 *
 * Each page keeps one colour and one shape wherever it appears here, so the
 * card, the step strip and the legend all point at the same thing. The colours
 * are the report palette, used here to identify a page rather than to signal a
 * threshold — the legend at the bottom is where they carry their real meaning.
 */
const STEPS = [
  {
    n: 1,
    title: 'Pick your brand',
    body: 'Top left. Choose more than one and the figures add up across them.',
    Icon: IconFilter,
  },
  {
    n: 2,
    title: 'Pick a date range',
    body: 'Top right. Last 7 days, this month, tomorrow — everything follows it.',
    Icon: IconCalendar,
  },
  {
    n: 3,
    title: 'Open the page that answers your question',
    body: 'The four below. Add columns with Build view once you are there.',
    Icon: IconColumns,
  },
]

/** A small drawing of what each page looks like, so the card is recognisable. */
const Spark = () => (
  <svg viewBox="0 0 72 28" className="qv__art" aria-hidden="true">
    <path d="M2 20 L14 14 L26 17 L38 8 L50 11 L62 4 L70 6" fill="none" strokeWidth="2.5" />
    <path
      d="M2 24 L14 19 L26 21 L38 14 L50 16 L62 10 L70 12"
      fill="none"
      strokeWidth="2"
      strokeDasharray="3 3"
      opacity="0.55"
    />
  </svg>
)

const Bars = () => (
  <svg viewBox="0 0 72 28" className="qv__art" aria-hidden="true">
    {[
      [4, 22],
      [18, 16],
      [32, 19],
      [46, 10],
      [60, 14],
    ].map(([x, h]) => (
      <rect key={x} x={x} y={26 - h} width="8" height={h} rx="2" strokeWidth="0" />
    ))}
  </svg>
)

const Stack = () => (
  <svg viewBox="0 0 72 28" className="qv__art" aria-hidden="true">
    <rect x="6" y="4" width="60" height="6" rx="3" strokeWidth="0" />
    <rect x="6" y="13" width="42" height="6" rx="3" strokeWidth="0" opacity="0.72" />
    <rect x="6" y="22" width="26" height="6" rx="3" strokeWidth="0" opacity="0.45" />
  </svg>
)

const Checks = () => (
  <svg viewBox="0 0 72 28" className="qv__art" aria-hidden="true">
    {[3, 13, 23].map((y) => (
      <g key={y}>
        <path d={`M4 ${y + 3} l3 3 l6 -7`} fill="none" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="20" y={y} width={y === 13 ? 32 : 46} height="5" rx="2.5" strokeWidth="0" opacity="0.35" />
      </g>
    ))}
  </svg>
)

const PAGES = [
  {
    id: 'summary',
    tone: 'green',
    label: 'Overview',
    asks: 'Are we tracking to forecast?',
    body: 'Sold against forecast for the period, accuracy, and the branches furthest from normal.',
    Icon: IconSummary,
    Art: Spark,
  },
  {
    id: 'product',
    tone: 'blue',
    label: 'Products',
    asks: 'Which lines moved the number?',
    body: 'The same comparison per product, so a variance can be traced to what caused it.',
    Icon: IconProduct,
    Art: Bars,
  },
  {
    id: 'component',
    tone: 'amber',
    label: 'Ingredients',
    asks: 'What do we need to buy and prep?',
    body: 'Raw materials and prepared items the forecast implies, grouped by recipe and type.',
    Icon: IconComponent,
    Art: Stack,
  },
  {
    id: 'production',
    tone: 'violet',
    label: "Tomorrow's Prep",
    asks: 'What does each branch make tomorrow?',
    body: 'The production plan for the next day, per branch, with a prep status on every line.',
    Icon: IconPlan,
    Art: Checks,
  },
]

/** The colours that carry a meaning, stated once where they can be looked up. */
const LEGEND = [
  { tone: 'green', term: 'On target', meaning: 'Accuracy 95% or better, or demand within its normal range.' },
  { tone: 'amber', term: 'Watch', meaning: 'Under target but not breached — worth a look, not an alarm.' },
  { tone: 'red', term: 'Outlier', meaning: 'Far enough from normal that somebody should check it.' },
  { tone: 'blue', term: 'Forecast', meaning: 'Every forecast figure and the dashed line on charts.' },
]

const SECTIONS = [
  { id: 'quick', label: 'Quick view' },
  { id: 'start', label: 'Where to start' },
  { id: 'pages', label: 'The four pages' },
  { id: 'filters', label: 'Choosing what you see' },
  { id: 'buildview', label: 'Build view' },
  { id: 'numbers', label: 'Reading the numbers' },
  { id: 'mail', label: 'The daily email' },
  { id: 'recipients', label: 'Managing recipients' },
  { id: 'admin', label: 'Admin' },
]

/**
 * A numbered section.
 *
 * The number is looked up rather than passed in, so the heading and the
 * contents list cannot drift apart when a section is added or moved — there is
 * one ordering, and it is the SECTIONS array.
 */
function Section({ id, title, figure, children }) {
  const n = SECTIONS.findIndex((s) => s.id === id) + 1
  return (
    <section className={`guide__section${figure ? ' guide__section--aside' : ''}`} id={id}>
      <header className="guide__sectionHead">
        <span className="guide__n" aria-hidden="true">
          {String(n).padStart(2, '0')}
        </span>
        <h2 className="guide__h">{title}</h2>
      </header>
      <div className="guide__prose">{children}</div>
      {figure && <aside className="guide__aside">{figure}</aside>}
    </section>
  )
}

export function Guide({ onDrill }) {
  const [active, setActive] = useState(SECTIONS[0].id)

  const go = (id) => (e) => {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /*
   * Which section is being read, so the contents can say so.
   *
   * The page scrolls inside the shell rather than the window, so the observer
   * is given that element as its root — against the viewport it would never
   * fire. The band is the top third: a heading counts as "here" once it has
   * reached the upper part of the screen, not when it is halfway down it.
   */
  useEffect(() => {
    const root = document.querySelector('.scroll')
    const seen = new Map()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting)
        const first = SECTIONS.find((sec) => seen.get(sec.id))
        if (first) setActive(first.id)
      },
      { root, rootMargin: '0px 0px -66% 0px', threshold: 0 }
    )
    for (const sec of SECTIONS) {
      const el = document.getElementById(sec.id)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [])

  return (
    <article className="doc">
      <header className="doc__masthead">
        <p className="doc__eyebrow">Documentation</p>
        <h1 className="doc__title">How to use this app</h1>
        <p className="doc__lead">
          One question, answered several ways: what did we expect to sell, and what did we actually
          sell? Every figure comes from the same Power BI models the reports use, so the app and the
          report agree for the same brand, branch and day.
        </p>
        {onDrill && (
          <button type="button" className="btn doc__back" onClick={() => onDrill('summary', {})}>
            Back to Overview
          </button>
        )}
      </header>

      <div className="doc__split">
        <nav className="doc__nav" aria-label="Contents">
          <p className="doc__navTitle">Contents</p>
          <ol className="doc__navList">
            {SECTIONS.map((sec, i) => (
              <li key={sec.id}>
                <a
                  className={`doc__navLink${active === sec.id ? ' doc__navLink--on' : ''}`}
                  href={`#${sec.id}`}
                  onClick={go(sec.id)}
                  aria-current={active === sec.id ? 'true' : undefined}
                >
                  <span className="doc__navN">{String(i + 1).padStart(2, '0')}</span>
                  {sec.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="guide__body">
          {/* The picture first. Everything below it is the same thing in words,
              for whoever needs more than the picture. */}
          <section className="guide__section qv" id="quick">
            <header className="guide__sectionHead">
              <span className="guide__n" aria-hidden="true">
                01
              </span>
              <h2 className="guide__h">Quick view</h2>
            </header>

            <ol className="qv__steps">
              {STEPS.map((s) => (
                <li className="qv__step" key={s.n}>
                  <span className="qv__num" aria-hidden="true">
                    {s.n}
                  </span>
                  <span className="qv__stepIcon" aria-hidden="true">
                    <s.Icon size={14} />
                  </span>
                  <span className="qv__stepText">
                    <strong>{s.title}</strong>
                    <span>{s.body}</span>
                  </span>
                </li>
              ))}
            </ol>

            <div className="qv__pages">
              {PAGES.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`qv__card qv__card--${p.tone}`}
                  onClick={() => onDrill?.(p.id, {})}
                  disabled={!onDrill}
                  title={onDrill ? `Open ${p.label}` : undefined}
                >
                  <span className="qv__cardHead">
                    <span className="qv__badge" aria-hidden="true">
                      <p.Icon size={15} />
                    </span>
                    <span className="qv__cardName">{p.label}</span>
                    {onDrill && (
                      <span className="qv__go" aria-hidden="true">
                        <IconArrowRight size={13} />
                      </span>
                    )}
                  </span>
                  <p.Art />
                  <span className="qv__asks">{p.asks}</span>
                  <span className="qv__cardBody">{p.body}</span>
                </button>
              ))}
            </div>

            <ul className="qv__legend">
              {LEGEND.map((l) => (
                <li className={`qv__key qv__key--${l.tone}`} key={l.tone}>
                  <span className="qv__dot" aria-hidden="true" />
                  <strong>{l.term}</strong>
                  <span>{l.meaning}</span>
                </li>
              ))}
            </ul>
          </section>

          <Section
            id="start"
            title="Where to start"
            figure={
              <Figure caption="The reports run down the left. Brand and date sit across the top and apply to whichever one you open.">
                <FigShell />
              </Figure>
            }
          >
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
                The same comparison broken down to each product. This is where you find which lines
                drove a variance. Every row is actual against forecast for the window you chose.
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

            <div className="figgrid">
              <Figure tone="green" caption="Overview — figures across the top, actual against forecast below.">
                <FigOverview />
              </Figure>
              <Figure tone="blue" caption="Products — one line per product, with variance beside it.">
                <FigProducts />
              </Figure>
              <Figure tone="amber" caption="Ingredients — the component table, and a card per unit of measure.">
                <FigIngredients />
              </Figure>
              <Figure tone="violet" caption="Tomorrow's Prep — the day it covers, then what each branch makes, with a prep status on every line.">
                <FigPlan />
              </Figure>
            </div>
          </Section>

          <Section
            id="filters"
            title="Choosing what you see"
            figure={
              <Figure tone="blue" caption="The same bar on every page. The date list carries the usual ranges plus Tomorrow.">
                <FigFilters />
              </Figure>
            }
          >
            <p>
              The bar along the top is the same on every page, minus whatever does not apply. Brands
              can be multi-selected; the figures then add up across them. Location and Product narrow
              the rows. The date picker offers the usual ranges plus{' '}
              <strong>Tomorrow</strong>, which is useful on Products when you want to see what the
              model expects rather than what happened.
            </p>
            <p>
              For a future date there are no actuals and never will be, so the actual, variance and
              accuracy columns are hidden rather than shown as zero or as −100%.
            </p>
          </Section>

          <Section
            id="buildview"
            title="Build view"
            figure={
              <Figure caption="Build view opens over the table. Two options are marked as splitting rows — those re-ask the question at a finer grain rather than hiding a column.">
                <FigBuildView />
              </Figure>
            }
          >
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
                One product name usually covers several PLUs — <em>Regular</em> is four of them, so a
                product name can appear on more than one line. The PLU column and its filter are
                switched off at the moment; the rows are still counted per PLU underneath, which is
                why two lines can share a name.
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

          <Section
            id="admin"
            title="Admin"
            figure={
              <Figure tone="violet" caption="Each account carries a role, a status, and the brands it may see. Status decides whether they get in at all.">
                <FigAdmin />
              </Figure>
            }
          >
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
    </article>
  )
}
